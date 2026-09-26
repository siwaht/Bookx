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

type ExecResult = { code: number | null; stdout: Buffer; stderr: string };

function execute(binary: string, args: string[], options: { timeoutMs?: number; input?: Buffer } = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const stdout: Buffer[] = [];
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 120_000);
    child.stdout.on("data", chunk => stdout.push(chunk as Buffer));
    child.stderr.on("data", chunk => {
      // Keep the tail only; ffmpeg can be chatty on long files.
      stderr = (stderr + chunk.toString()).slice(-20_000);
    });
    child.on("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", code => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(stdout), stderr });
    });
    if (options.input) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

/** Runs ffmpeg and throws with the tail of its log when it fails. */
export async function runFfmpeg(args: string[], options: { timeoutMs?: number; input?: Buffer } = {}): Promise<ExecResult> {
  const binary = await requireFfmpeg();
  const result = await execute(binary, ["-hide_banner", "-nostdin", "-y", ...args], options);
  if (result.code !== 0) {
    const tail = result.stderr.trim().split(/\r?\n/).slice(-6).join(" | ");
    throw new Error(`ffmpeg failed (exit ${result.code}): ${tail.slice(0, 600)}`);
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

/** Mean and peak level of an audio file, plus its decoded duration. */
export async function measureLoudness(filePath: string): Promise<Loudness> {
  const { stderr } = await runFfmpeg(["-i", filePath, "-af", "volumedetect", "-f", "null", "-"], { timeoutMs: 180_000 });
  return parseLoudness(stderr);
}
