import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

/**
 * Thin, shell-free wrapper around ffmpeg.
 *
 * Resolution order: `FFMPEG_PATH`, then the binary bundled by `ffmpeg-static`,
 * then `ffmpeg` on the PATH. Arguments are always passed as an array, never
 * through a shell, so nothing in a file name or a cue can be interpreted as a
 * command.
 */

let resolved: string | null | undefined;

function bundledFfmpeg(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const candidate = require("ffmpeg-static") as string | null;
    return candidate && existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

export class FfmpegUnavailableError extends Error {
  constructor() {
    super("ffmpeg is not available on this server, so sound design cannot be mixed. Install ffmpeg or set FFMPEG_PATH.");
    this.name = "FfmpegUnavailableError";
  }
}

/**
 * How long ffmpeg may run.
 *
 * `idleMs` is the real guard: it is measured from the last line the process
 * printed, and a running ffmpeg reports progress every second, so a slow but
 * healthy pass is never stopped. `maxMs` is only a backstop for a process that
 * never finishes at all.
 *
 * This matters: a stopwatch on the clock used to stop whole-chapter encodes on
 * a busy machine. The encode was working, and the export failed with
 * "ffmpeg failed (exit null)" — a SIGKILL — for no reason but the wall clock.
 */
export type FfmpegLimits = { idleMs?: number; maxMs?: number };

/** Whole-file work: a long chapter decoded or encoded on a shared CPU. */
export const FILE_WORK_LIMITS: FfmpegLimits = { idleMs: 240_000, maxMs: 6 * 60 * 60_000 };

/** A pass that reads one file and writes a short one. */
export const QUICK_LIMITS: FfmpegLimits = { idleMs: 120_000, maxMs: 30 * 60_000 };

/** Absolute path (or PATH name) of a working ffmpeg, or null when there is none. */
export async function resolveFfmpeg(): Promise<string | null> {
  if (resolved !== undefined) return resolved;
  const candidates = [process.env.FFMPEG_PATH, bundledFfmpeg(), "ffmpeg"].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    try {
      const { code } = await execute(candidate, ["-hide_banner", "-version"], { timeoutMs: 10_000 });
      if (code === 0) {
        resolved = candidate;
        return resolved;
      }
    } catch {
      // try the next candidate
    }
  }
  resolved = null;
  return null;
}

export async function requireFfmpeg(): Promise<string> {
  const binary = await resolveFfmpeg();
  if (!binary) throw new FfmpegUnavailableError();
  return binary;
}

type ExecResult = {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  /** Which guard stopped the process, when one did. */
  stopped: "idle" | "cap" | null;
  /** The signal that ended it, when it was not a normal exit. */
  signal: NodeJS.Signals | null;
  ms: number;
};

function execute(binary: string, args: string[], options: FfmpegLimits & { timeoutMs?: number; input?: Buffer } = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const stdout: Buffer[] = [];
    let stderr = "";
    const startedAt = Date.now();
    let lastOutputAt = startedAt;
    let stopped: "idle" | "cap" | null = null;
    // `timeoutMs` is the older name for the backstop, still used by callers that
    // only ever want a hard ceiling.
    const maxMs = options.maxMs ?? options.timeoutMs ?? 120_000;
    const idleMs = options.idleMs ?? maxMs;
    const watchdog = setInterval(() => {
      const now = Date.now();
      if (maxMs > 0 && now - startedAt >= maxMs) {
        stopped = "cap";
        child.kill("SIGKILL");
      } else if (idleMs > 0 && now - lastOutputAt >= idleMs) {
        stopped = "idle";
        child.kill("SIGKILL");
      }
    }, 500);
    child.stdout.on("data", chunk => {
      lastOutputAt = Date.now();
      stdout.push(chunk as Buffer);
    });
    child.stderr.on("data", chunk => {
      lastOutputAt = Date.now();
      // Keep the tail only; ffmpeg can be chatty on long files.
      stderr = (stderr + chunk.toString()).slice(-20_000);
    });
    child.on("error", error => {
      clearInterval(watchdog);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearInterval(watchdog);
      resolve({ code, stdout: Buffer.concat(stdout), stderr, stopped, signal, ms: Date.now() - startedAt });
    });
    if (options.input) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

/** Explains a non-zero exit in terms of what actually happened. */
function describeFailure(result: ExecResult): string {
  const seconds = Math.max(1, Math.round(result.ms / 1000));
  if (result.stopped === "idle") return `ffmpeg stopped responding: it printed nothing for ${seconds}s and was stopped`;
  if (result.stopped === "cap") return `ffmpeg was still running after ${seconds}s and was stopped`;
  if (result.signal) return `ffmpeg was killed by ${result.signal} after ${seconds}s`;
  return `ffmpeg failed (exit ${result.code})`;
}

/** Runs ffmpeg and throws with the tail of its log when it fails. */
export async function runFfmpeg(args: string[], options: FfmpegLimits & { timeoutMs?: number; input?: Buffer } = {}): Promise<ExecResult> {
  const binary = await requireFfmpeg();
  const result = await execute(binary, ["-hide_banner", "-nostdin", "-y", ...args], options);
  if (result.code !== 0) {
    const tail = result.stderr.trim().split(/\r?\n/).slice(-6).join(" | ");
    throw new Error(`${describeFailure(result)}: ${tail.slice(0, 600)}`);
  }
  return result;
}

/** A private temporary directory, removed when `work` settles. */
export async function withTempDir<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bookx-audio-"));
  try {
    return await work(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export type Loudness = { meanDb: number; peakDb: number; durationMs: number };

/** Parses ffmpeg's `volumedetect` and duration lines. Exported for tests. */
export function parseLoudness(stderr: string): Loudness {
  const mean = /mean_volume:\s*(-?[\d.]+|-inf)\s*dB/.exec(stderr)?.[1];
  const peak = /max_volume:\s*(-?[\d.]+|-inf)\s*dB/.exec(stderr)?.[1];
  const toDb = (value?: string) => (value === undefined || value === "-inf" ? -91 : Number(value));
  // The last progress "time=" is the decoded length.
  const times = [...stderr.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
  const last = times[times.length - 1];
  const durationMs = last ? Math.round(((Number(last[1]) * 60 + Number(last[2])) * 60 + Number(last[3])) * 1000) : 0;
  return { meanDb: toDb(mean), peakDb: toDb(peak), durationMs };
}

/**
 * The noise floor of a file: the loudness of its quietest stretch, which is
 * what ACX measures when it checks a submission for hiss and room tone.
 *
 * `volumedetect` reports only the whole-file mean and peak, so the floor is
 * measured with `astats` over short windows: the quietest window's RMS is the
 * noise floor. Windows shorter than a spoken syllable keep a pause from being
 * counted as speech.
 */
export type NoiseFloor = { floorDb: number | null; durationMs: number };

export function parseNoiseFloor(stderr: string): NoiseFloor {
  // astats prints one "Parsed_astats" section per window, each ending with a
  // line like "RMS level dB: -61.4".
  const levels = [...stderr.matchAll(/RMS level dB:\s*(-?[\d.]+|-inf)/g)].map(match => (match[1] === "-inf" ? -91 : Number(match[1])));
  const floor = levels.length ? Math.max(...levels) : null; // the loudest quiet window is the floor
  const times = [...stderr.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
  const last = times[times.length - 1];
  const durationMs = last ? Math.round(((Number(last[1]) * 60 + Number(last[2])) * 60 + Number(last[3])) * 1000) : 0;
  return { floorDb: floor === null ? null : Math.round(floor * 10) / 10, durationMs };
}

/** Measures a file's noise floor with ffmpeg's `astats` over 500 ms windows. */
export async function measureNoiseFloor(file: string, limits: FfmpegLimits = {}): Promise<NoiseFloor> {
  const { stderr } = await runFfmpeg(["-i", file, "-af", "astats=metadata=1:reset=500,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-", "-f", "null", "-"], { ...FILE_WORK_LIMITS, ...limits });
  return parseNoiseFloor(stderr);
}

/** Mean and peak level of an audio file, plus its decoded duration. */
export async function measureLoudness(filePath: string, limits: FfmpegLimits = {}): Promise<Loudness> {
  const { stderr } = await runFfmpeg(["-i", filePath, "-af", "volumedetect", "-f", "null", "-"], { ...FILE_WORK_LIMITS, ...limits });
  return parseLoudness(stderr);
}