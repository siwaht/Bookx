import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { bookxProjects } from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";
import { getDb } from "./db";
import { resolveFfmpeg } from "./ffmpeg";
import { appRouter } from "./routers";
import { soundDesignReadiness } from "./soundDesign";

// No language model: planning must fall back to the keyword rules, and the
// suite never spends provider credits.
vi.mock("./languageModel", async importOriginal => ({
  ...(await importOriginal<typeof import("./languageModel")>()),
  resolveLanguageModel: async () => null,
}));

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function caller(id: number, openId: string) {
  const user: AuthenticatedUser = {
    id, openId, email: `${openId}@example.com`, name: openId, loginMethod: "manus", role: "user",
    createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(),
  };
  return appRouter.createCaller({ user, req: { protocol: "https", headers: {} } as TrpcContext["req"], res: {} as TrpcContext["res"] });
}

const MANUSCRIPT = [
  "Chapter 1",
  "",
  "The rain came down hard over the valley, drumming on the slate roofs.",
  "",
  "“We should wait until it passes,” said Anna.",
  "",
  "Tom shook his head and pulled on his coat.",
  "",
  "* * *",
  "",
  "Hours later, somebody knocked twice at the door.",
  "",
  "Anna set down her cup and listened.",
].join("\n");

const setup = {
  author: "Bookx QA",
  kind: "audiobook" as const,
  narrationStyle: "narrator-cast" as const,
  voiceProvider: "Cloudflare",
  voiceModel: "@cf/deepgram/aura-2-en",
  languageModelProvider: "Cloudflare",
  languageModel: "@cf/openai/gpt-oss-120b",
  language: "English",
};

const hasFfmpeg = Boolean(await resolveFfmpeg());

describe(`Bookx sound design`, () => {
  it("plans cues from the text, keeps the creator's edits, and guards every cue", async () => {
    const owner = caller(990_101, "sound-owner");
    const intruder = caller(990_102, "sound-intruder");
    const stamp = Date.now();
    const { id: projectId } = await owner.bookx.createProject({ ...setup, title: `Sound QA ${stamp}` });
    const { id: foreignId } = await intruder.bookx.createProject({ ...setup, title: `Sound QA intruder ${stamp}` });

    const waitFor = async (kind: "scenes" | "sounds") => {
      for (let attempt = 0; attempt < 120; attempt++) {
        const status = await owner.bookx.analysisStatus({ projectId, kind });
        if (!["queued", "running"].includes(status.status)) return status;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      throw new Error(`${kind} run did not finish`);
    };
    const cues = async () => (await owner.bookx.soundDesign({ projectId })).chapters.flatMap(chapter => chapter.cues);
    const project = async () => {
      const db = (await getDb())!;
      return (await db.select().from(bookxProjects).where(eq(bookxProjects.id, projectId)).limit(1))[0]!;
    };

    try {
      await owner.bookx.importManuscript({ projectId, filename: "storm.txt", base64: Buffer.from(MANUSCRIPT).toString("base64"), mode: "replace" });
      await owner.bookx.resegmentChapters({ projectId });

      // Off by default: nothing to plan, nothing blocks an export.
      const initial = await owner.bookx.soundDesign({ projectId });
      expect(initial.settings).toEqual({ effects: false, music: false, level: "extra-subtle", source: "auto" });
      expect(await soundDesignReadiness((await getDb())!, await project(), 990_101)).toEqual({ ready: true });

      await owner.bookx.updateSoundSettings({ projectId, effects: true, music: true, source: "builtin" });
      const blocked = await soundDesignReadiness((await getDb())!, await project(), 990_101);
      expect(blocked.ready).toBe(false);
      if (!blocked.ready) expect(blocked.reason).toMatch(hasFfmpeg ? /no sound plan/ : /ffmpeg/);

      await owner.bookx.startScenePlan({ projectId });
      const planned = await waitFor("scenes");
      expect(planned.status).toBe("completed");

      const overview = await owner.bookx.soundDesign({ projectId });
      expect(overview.availability.languageModel).toBeNull();
      expect(overview.totals).toMatchObject({ unplannedChapters: 0, sfx: 2, music: 2 });
      const all = await cues();
      const rain = all.find(cue => cue.tag === "rain")!;
      const knock = all.find(cue => cue.tag === "knock")!;
      expect(rain).toMatchObject({ kind: "sfx", placement: "after", source: "keyword", enabled: true });
      expect(rain.anchorText).toContain("The rain came down hard");
      expect(knock.anchorText).toContain("knocked twice");
      expect(all.filter(cue => cue.kind === "music").every(cue => cue.placement === "before")).toBe(true);
      if (hasFfmpeg) {
        expect(overview.totals.missingSounds).toBe(0);
        expect(rain.sound).toMatchObject({ source: "builtin" });
        expect(await soundDesignReadiness((await getDb())!, await project(), 990_101)).toEqual({ ready: true });
      }

      // The creator mutes one cue and trims another; re-planning keeps both.
      await owner.bookx.updateSoundCue({ projectId, cueId: rain.id, enabled: false });
      await owner.bookx.updateSoundCue({ projectId, cueId: knock.id, gainDb: -6 });
      await owner.bookx.startScenePlan({ projectId, replan: true });
      expect((await waitFor("scenes")).status).toBe("completed");
      const replanned = await cues();
      const onRainLine = replanned.filter(cue => cue.kind === "sfx" && cue.anchorText === rain.anchorText);
      expect(onRainLine).toEqual([expect.objectContaining({ id: rain.id, enabled: false, source: "manual" })]);
      expect(replanned.find(cue => cue.id === knock.id)).toMatchObject({ gainDb: -6, source: "manual" });
      expect((await owner.bookx.soundDesign({ projectId })).totals.sfx).toBe(1);

      // Re-tagging swaps the sound.
      await owner.bookx.updateSoundCue({ projectId, cueId: knock.id, tag: "door" });
      await expect(owner.bookx.updateSoundCue({ projectId, cueId: knock.id, tag: "kazoo" })).rejects.toThrow(/not in the sound library/);
      await expect(owner.bookx.updateSoundCue({ projectId, cueId: knock.id, tag: "music-calm" })).rejects.toThrow(/not in the sound library/);
      if (hasFfmpeg) {
        await owner.bookx.prepareSounds({ projectId });
        expect((await waitFor("sounds")).status).toBe("completed");
        expect((await cues()).find(cue => cue.id === knock.id)).toMatchObject({ tag: "door", sound: expect.objectContaining({ source: "builtin" }) });

        const alone = await owner.bookx.previewSoundCue({ projectId, cueId: knock.id, inContext: false });
        expect(alone.url).toContain(`bookx/${projectId}/sound/door-`);
        await expect(owner.bookx.previewSoundCue({ projectId, cueId: knock.id, inContext: true })).rejects.toThrow(/Render the narration/);
        const chapterId = (await owner.bookx.soundDesign({ projectId })).chapters[0]!.id;
        await expect(owner.bookx.previewChapterSound({ projectId, chapterId })).rejects.toThrow(/no narration yet/);
      }

      // Another user can reach no cue, through their own project or this one.
      await expect(intruder.bookx.updateSoundCue({ projectId: foreignId, cueId: knock.id, enabled: false })).rejects.toThrow(/Sound cue not found/);
      await expect(intruder.bookx.updateSoundCue({ projectId, cueId: knock.id, enabled: false })).rejects.toThrow(/Project not found/);
      await expect(intruder.bookx.previewSoundCue({ projectId: foreignId, cueId: knock.id, inContext: false })).rejects.toThrow(/Sound cue not found/);
      await expect(intruder.bookx.soundDesign({ projectId })).rejects.toThrow(/Project not found/);

      // Both off again: the export gate no longer cares about sound.
      await owner.bookx.updateSoundSettings({ projectId, effects: false, music: false });
      expect(await soundDesignReadiness((await getDb())!, await project(), 990_101)).toEqual({ ready: true });
      expect((await owner.bookx.exportReadiness({ projectId })).soundDesign).toMatchObject({ effects: false, music: false });
    } finally {
      await owner.bookx.deleteProject({ projectId });
      await intruder.bookx.deleteProject({ projectId: foreignId });
    }
  }, 120_000);
});
