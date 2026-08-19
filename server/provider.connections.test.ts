import { describe, expect, it } from "vitest";

const timeoutMs = 15_000;

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

describe("configured audio provider credentials", () => {
  it("authenticates to Deepgram", async () => {
    const response = await fetch("https://api.deepgram.com/v1/projects", {
      headers: { Authorization: `Token ${required("DEEPGRAM_API_KEY")}` },
      signal: AbortSignal.timeout(timeoutMs),
    });

    expect(response.ok, `Deepgram validation returned HTTP ${response.status}`).toBe(true);
  }, 20_000);

  it("authenticates to Cloudflare Workers AI", async () => {
    const accountId = required("CLOUDFLARE_ACCOUNT_ID");
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/models/search?per_page=1`,
      {
        headers: { Authorization: `Bearer ${required("CLOUDFLARE_API_TOKEN")}` },
        signal: AbortSignal.timeout(timeoutMs),
      },
    );

    expect(response.ok, `Cloudflare validation returned HTTP ${response.status}`).toBe(true);
  }, 20_000);
});
