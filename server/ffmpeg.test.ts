import path from "node:path";
import { stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { resolveFfmpeg, runFfmpeg, withTempDir } from "./ffmpeg";

/**
 * How long ffmpeg may run.
 *
 * A whole-chapter export is minutes of work on a shared CPU, and it reports
 * progress the whole way. Guarding it with a stopwatch stopped healthy encodes
 * whenever the machine was busy, and the export failed with "ffmpeg failed
 * (exit null)" — a SIGKILL — for no better reason than the clock. These tests
 * pin the behaviour that replaced it: progress keeps a job alive, silence stops
 * it, and a stopped job says why.
 */

const hasFfmpeg = Boolean(await resolveFfmpeg());

/** A tone long enough that encoding it outlasts the idle window in these tests. */
const toneArgs = (seconds: number, file: string) => [
  "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`,
  "-c:a", "libmp3lame", "-b:a", "192k",
  file,
];

describe.skipIf(!hasFfmpeg)("ffmpeg time limits", () => {
  it("keeps a slow job alive while it is still printing progress", async () => {
    await withTempDir(async dir => {
      const target = path.join(dir, "tone.mp3");
      // The idle window is far shorter than the encode. Only a job whose timer
      // resets on output can finish; an absolute stopwatch would kill it.
      await runFfmpeg(toneArgs(120, target), { idleMs: 2_000, maxMs: 10 * 60_000 });
      const { size } = await stat(target);
      expect(size).toBeGreaterThan(1_000);
    });
  }, 60_000);

  it("stops a job that never finishes, and says it ran out of time", async () => {
    await withTempDir(async dir => {
      const target = path.join(dir, "endless.mp3");
      await expect(runFfmpeg(toneArgs(3_600, target), { idleMs: 0, maxMs: 1_500 }))
        .rejects.toThrow(/still running after \d+s and was stopped/);
    });
  }, 60_000);

  it("reports a killed job as a kill rather than a bare null exit", async () => {
    await withTempDir(async dir => {
      const target = path.join(dir, "stopped.mp3");
      let message = "";
      await runFfmpeg(toneArgs(3_600, target), { idleMs: 0, maxMs: 1_500 }).catch((reason: unknown) => {
        message = reason instanceof Error ? reason.message : String(reason);
      });
      expect(message).not.toContain("exit null");
      expect(message).toMatch(/stopped|killed/);
    });
  }, 60_000);
});
