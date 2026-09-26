import path from "node:path";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { bookxSoundCues, bookxStudioAssets } from "../drizzle/schema";
import { assembleAudio, scanMp3 } from "./audioAssembly";
import { measureLoudness, resolveFfmpeg, runFfmpeg, withTempDir } from "./ffmpeg";
import { assembleAndMixChapter, type ChapterPart, type CueWithSound } from "./soundDesign";
import { CUE_TIMING, builtinSoundArgs, soundTag } from "./soundLibrary";

type CueRow = typeof bookxSoundCues.$inferSelect;
type AssetRow = typeof bookxStudioAssets.$inferSelect;

const ffmpeg = await resolveFfmpeg();

async function speech(dir: string, name: string, seconds: number): Promise<Buffer> {
  const file = path.join(dir, `${name}.mp3`);
  await runFfmpeg([
    "-f", "lavfi", "-i", `aevalsrc=exprs='0.3*(0.5+0.5*sin(2*PI*4*t))*(sin(2*PI*150*t)+0.5*sin(2*PI*300*t))':s=44100:d=${seconds}`,
    "-ac", "1", "-ar", "44100", "-c:a", "libmp3lame", "-b:a", "128k", "-write_xing", "0", "-id3v2_version", "0", "-f", "mp3", file,
  ]);
  return readFile(file);
}

async function withSound(dir: string, cue: Pick<CueRow, "id" | "segmentId" | "kind" | "tag" | "placement">): Promise<CueWithSound> {
  const file = path.join(dir, `${cue.tag}.mp3`);
  await runFfmpeg(builtinSoundArgs(soundTag(cue.tag)!, file));
  const measured = await measureLoudness(file);
  const now = new Date();
  const row: CueRow = { projectId: "p", chapterId: "c", source: "keyword", note: null, enabled: 1, gainDb: 0, assetId: `asset-${cue.tag}`, createdAt: now, updatedAt: now, ...cue };
  const asset: AssetRow = {
    id: `asset-${cue.tag}`, projectId: "p", type: cue.kind === "music" ? "music" : "sound-effect", title: cue.tag, storageKey: `bookx/p/sound/${cue.tag}.mp3`,
    durationMs: measured.durationMs, promptHash: "hash", tag: cue.tag, source: "builtin",
    meanVolumeDb: Math.round(measured.meanDb), peakVolumeDb: Math.round(measured.peakDb), createdAt: now, updatedAt: now,
  };
  return { cue: row, asset, audio: await readFile(file) };
}

describe.skipIf(!ffmpeg)("chapter mixing for export", () => {
  it("makes room for its cues, and still joins with a chapter that has none", async () => {
    await withTempDir(async dir => {
      const parts: ChapterPart[] = [];
      for (const [index, seconds] of [2, 2, 2].entries()) {
        parts.push({ segmentId: `s${index}`, buffer: await speech(dir, `s${index}`, seconds), label: `Line ${index + 1}`, gapAfterMs: 350 });
      }
      const cues = [
        await withSound(dir, { id: "m", segmentId: "s0", kind: "music", tag: "music-calm", placement: "before" }),
        await withSound(dir, { id: "r", segmentId: "s1", kind: "sfx", tag: "rain", placement: "after" }),
        // Anchored to a line this chapter no longer has: ignored, not fatal.
        await withSound(dir, { id: "x", segmentId: "gone", kind: "sfx", tag: "knock", placement: "after" }),
      ];

      const plain = assembleAudio(parts, { gapMs: 350 });
      const mixed = await assembleAndMixChapter({ parts, cues, level: "very-subtle", defaultGapMs: 350 });
      expect(mixed.mixedCues).toBe(2);
      expect(mixed.container).toBe("mp3");
      // The swell's lead-in and the widened pause after line two, and nothing else.
      const added = mixed.durationMs - plain.durationMs;
      const expected = CUE_TIMING.music.gapBeforeMs + (CUE_TIMING.sfx.gapAfterMs - 350);
      expect(Math.abs(added - expected)).toBeLessThan(150);

      const quiet = await assembleAndMixChapter({ parts: parts.slice(0, 1), cues: [], level: "very-subtle", defaultGapMs: 350, target: mixed.target });
      expect(quiet.mixedCues).toBe(0);
      const book = assembleAudio([{ buffer: mixed.buffer, label: "One" }, { buffer: quiet.buffer, label: "Two" }], { gapMs: 2000 });
      expect(book.marks).toHaveLength(2);
      expect(scanMp3(book.buffer).format).toMatchObject({ sampleRate: 44100, bitrateKbps: 128, channelModeBits: 3 });
    });
  }, 120_000);
});
