import { describe, expect, it } from "vitest";
import { resolveNarrationPlan, resolveNarrationVoice } from "./routers/bookx";

describe("Bookx multi-cast narration routing", () => {
  it("uses the persisted character assignment when no explicit voice override is supplied", () => {
    expect(resolveNarrationVoice({ characterVoiceId: "Iris" })).toBe("Iris");
  });

  it("honors an explicit creator override ahead of the persisted character voice", () => {
    expect(resolveNarrationVoice({ explicitVoiceId: "Noor", characterVoiceId: "Iris" })).toBe("Noor");
  });

  it("retains the selected compatible provider and its requested model for a persisted cast assignment", () => {
    expect(resolveNarrationPlan({
      provider: "Cloudflare",
      characterVoiceId: "Iris",
      requestedModel: "@cf/myshell-ai/melotts",
      projectModel: "eleven_multilingual_v2",
    })).toEqual({ provider: "Cloudflare", voiceId: "Iris", model: "@cf/myshell-ai/melotts" });
  });
});
