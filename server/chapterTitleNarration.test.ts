import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function createAuthContext(): TrpcContext {
  const user: AuthenticatedUser = {
    id: 1,
    openId: "sample-user",
    email: "sample@example.com",
    name: "Sample User",
    loginMethod: "manus",
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };
  return { user, req: { protocol: "https", headers: {} } as TrpcContext["req"], res: {} as TrpcContext["res"] };
}

async function createProject(caller: ReturnType<typeof appRouter.createCaller>, kind: "audiobook" | "podcast") {
  return caller.bookx.createProject({
    title: `Title narration QA ${Date.now()}`,
    kind,
    narrationStyle: "single",
    voiceProvider: "Cloudflare",
    voiceModel: "@cf/deepgram/aura-2-en",
    languageModelProvider: "Cloudflare",
    languageModel: "@cf/openai/gpt-oss-120b",
    language: "English",
  });
}

describe("chapter titles in the narration", () => {
  it("reads the chapter's name from the title instead of a copy left in its body", async () => {
    const caller = appRouter.createCaller(createAuthContext());
    const created = await createProject(caller, "audiobook");
    try {
      await caller.bookx.createChapter({ projectId: created.id, title: "Chapter 1 — The Scribe", body: "The ink was wrong, and the scribe knew it." });
      await caller.bookx.resegmentChapters({ projectId: created.id });

      const workspace = await caller.bookx.getWorkspace({ projectId: created.id });
      const texts = (workspace.segments ?? []).map(segment => segment.text);
      const spoken = texts.join("\n");
      // Announced once, and read from the title rather than from a second copy in the body.
      expect(texts.filter(text => text.includes("Chapter 1 — The Scribe"))).toHaveLength(1);
      expect(spoken).toContain("The ink was wrong, and the scribe knew it.");
    } finally {
      await caller.bookx.deleteProject({ projectId: created.id });
    }
  }, 20_000);

  it("leaves a podcast's chapter names out of the read, since they are labels", async () => {
    const caller = appRouter.createCaller(createAuthContext());
    const created = await createProject(caller, "podcast");
    try {
      await caller.bookx.createChapter({ projectId: created.id, title: "Segment 1", body: "Welcome back to the show." });
      await caller.bookx.resegmentChapters({ projectId: created.id });

      const workspace = await caller.bookx.getWorkspace({ projectId: created.id });
      const spoken = (workspace.segments ?? []).map(segment => segment.text).join("\n");
      expect(spoken).toContain("Welcome back to the show.");
      expect(spoken).not.toContain("Segment 1");
    } finally {
      await caller.bookx.deleteProject({ projectId: created.id });
    }
  }, 20_000);
});