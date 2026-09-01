import { describe, expect, it } from "vitest";
import { needs, unconfigured } from "./testEnv";

const timeoutMs = 15_000;

describe("configured audio provider credentials", () => {
  it.skipIf(unconfigured("DEEPGRAM_API_KEY"))(
    `authenticates to Deepgram (${needs("DEEPGRAM_API_KEY")})`,
    async () => {
      const response = await fetch("https://api.deepgram.com/v1/projects", {
        headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` },
        signal: AbortSignal.timeout(timeoutMs),
      });

      expect(response.ok, `Deepgram validation returned HTTP ${response.status}`).toBe(true);
    },
    20_000,
  );

  it.skipIf(unconfigured("CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"))(
    `authenticates to Cloudflare Workers AI (${needs("CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN")})`,
    async () => {
      const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/models/search?per_page=1`,
        {
          headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` },
          signal: AbortSignal.timeout(timeoutMs),
        },
      );

      expect(response.ok, `Cloudflare validation returned HTTP ${response.status}`).toBe(true);
    },
    20_000,
  );
});
