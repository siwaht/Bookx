import { describe, expect, it } from "vitest";
import { configuredProviders, resolveProvider } from "./providerRouting";

describe("provider capability routing", () => {
  it("keeps a configured requested provider when it supports the task", () => {
    expect(resolveProvider("Cloudflare", "language-model", ["Cloudflare", "OpenAI"])).toEqual({ provider: "Cloudflare", fallback: false });
  });

  it("falls back to the next compatible configured provider for an unavailable task provider", () => {
    expect(resolveProvider("Fish Audio", "text-to-speech", ["Deepgram", "OpenAI"])).toEqual({ provider: "Deepgram", fallback: true });
  });

  it("only reports configured providers from the available environment", () => {
    expect(configuredProviders({ DEEPGRAM_API_KEY: "test", CLOUDFLARE_ACCOUNT_ID: "account", CLOUDFLARE_API_TOKEN: "token" } as NodeJS.ProcessEnv)).toEqual(["Deepgram", "Cloudflare"]);
  });
});
