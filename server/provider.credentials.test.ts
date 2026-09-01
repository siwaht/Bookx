import { describe, expect, it } from "vitest";
import { needs, unconfigured } from "./testEnv";

const timeoutMs = 15_000;

describe("configured narration provider credentials", () => {
  it.skipIf(unconfigured("ELEVENLABS_API_KEY"))(
    `accepts the configured ElevenLabs credential (${needs("ELEVENLABS_API_KEY")})`,
    async () => {
      const response = await fetch("https://api.elevenlabs.io/v1/voices", {
        headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY! },
        signal: AbortSignal.timeout(timeoutMs),
      });
      expect(
        response.ok,
        `ElevenLabs credential validation failed with HTTP ${response.status}`,
      ).toBe(true);
    },
    20_000,
  );

  it.skipIf(unconfigured("OPENAI_API_KEY"))(
    `accepts the configured OpenAI credential (${needs("OPENAI_API_KEY")})`,
    async () => {
      const response = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      expect(
        response.ok,
        `OpenAI credential validation failed with HTTP ${response.status}`,
      ).toBe(true);
    },
    20_000,
  );
});
