import { describe, expect, it } from "vitest";

const timeoutMs = 15_000;

describe("configured narration provider credentials", () => {
  it("accepts the configured ElevenLabs credential", async () => {
    const key = process.env.ELEVENLABS_API_KEY;
    expect(key, "ELEVENLABS_API_KEY should be available to the server test runtime").toBeTruthy();
    const response = await fetch("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": key! },
      signal: AbortSignal.timeout(timeoutMs),
    });
    expect(response.ok, `ElevenLabs credential validation failed with HTTP ${response.status}`).toBe(true);
  }, 20_000);

  it("accepts the configured OpenAI credential", async () => {
    const key = process.env.OPENAI_API_KEY;
    expect(key, "OPENAI_API_KEY should be available to the server test runtime").toBeTruthy();
    const response = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    expect(response.ok, `OpenAI credential validation failed with HTTP ${response.status}`).toBe(true);
  }, 20_000);
});
