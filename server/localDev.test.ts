import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _internals, signinConfigured, signinEmail } from "./_core/passwordAuth";
import { isSafeStorageKey, localObject, localPathForKey, localStorageRoot, storageGetBuffer, storageGetSignedUrl, storageMode, storagePut } from "./storage";
import { buildElevenLabsBody, deepgramModelFor, supportsElevenLabsContinuity } from "./ttsRender";

describe("the one account's sign-in", () => {
  it("is configured only when both an email and a password are set", () => {
    expect(signinConfigured()).toBe(true); // .env provides both
    expect(signinEmail()).toBe(process.env.BOOKX_SIGNIN_EMAIL!.trim().toLowerCase());
  });

  it("hashes with scrypt so the password is never stored in plain form", async () => {
    const { hashPassword, verifyPassword } = _internals;
    // A sample password, never the account's real one.
    const sample = "sample-Passw0rd!";
    const stored = await hashPassword(sample);
    expect(stored).toMatch(/^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);
    expect(stored).not.toContain(sample);
    expect(await verifyPassword(sample, stored)).toBe(true);
    expect(await verifyPassword("wrong", stored)).toBe(false);
    // A fresh salt every time: two hashes of the same password differ.
    expect(await hashPassword(sample)).not.toBe(stored);
  }, 30_000);
});

describe("local storage keys", () => {
  it("refuses keys that could leave the storage root", () => {
    expect(isSafeStorageKey("bookx/p1/sound/rain-1a2b3c4d.mp3")).toBe(true);
    for (const key of ["", "../etc/passwd", "bookx/../../secret", "bookx//double", "bookx/./here", "C:/Windows/win.ini", "bookx/a\0b", "x".repeat(513)]) {
      expect(isSafeStorageKey(key), key).toBe(false);
    }
  });

  it("maps safe keys inside the root and unsafe ones to nothing", () => {
    const root = localStorageRoot();
    expect(localPathForKey("bookx/p1/a.mp3")).toBe(path.join(root, "bookx", "p1", "a.mp3"));
    expect(localPathForKey("\\bookx\\p1\\a.mp3")).toBe(path.join(root, "bookx", "p1", "a.mp3"));
    expect(localPathForKey("bookx/../../a.mp3")).toBeNull();
  });
});

describe("local storage round trip", () => {
  let dir = "";
  const previous = process.env.BOOKX_LOCAL_STORAGE_DIR;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "bookx-storage-"));
    process.env.BOOKX_LOCAL_STORAGE_DIR = dir;
  });
  afterAll(async () => {
    if (previous === undefined) delete process.env.BOOKX_LOCAL_STORAGE_DIR;
    else process.env.BOOKX_LOCAL_STORAGE_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });

  it("stores, serves and reads back an object under a unique key", async () => {
    if (storageMode() !== "local") return; // Forge is configured on this machine
    const data = Buffer.from("not really audio");
    const first = await storagePut("bookx/p1/preview/cue-1.mp3", data, "audio/mpeg");
    const second = await storagePut("bookx/p1/preview/cue-1.mp3", data, "audio/mpeg");
    expect(first.key).toMatch(/^bookx\/p1\/preview\/cue-1_[0-9a-f]{8}\.mp3$/);
    expect(second.key).not.toBe(first.key);
    expect(await storageGetSignedUrl(first.key)).toBe(`/api/storage/${first.key}`);
    expect((await storageGetBuffer(first.key)).equals(data)).toBe(true);
    expect((await localObject(first.key))?.size).toBe(data.length);
    expect(await localObject("bookx/p1/missing.mp3")).toBeNull();
  });
});

describe("TTS request helpers", () => {
  it("sends neighbouring text to ElevenLabs models that support it, trimmed to size", () => {
    const body = buildElevenLabsBody({ text: "Middle.", model: "eleven_multilingual_v2", previousText: "  Before.  ", nextText: "After." });
    expect(body).toMatchObject({ text: "Middle.", model_id: "eleven_multilingual_v2", previous_text: "Before.", next_text: "After." });
    const long = buildElevenLabsBody({ text: "x", model: "eleven_turbo_v2_5", previousText: "a".repeat(5_000), nextText: "b".repeat(5_000) });
    expect(String(long.previous_text).length).toBeLessThan(5_000);
    expect(String(long.next_text).length).toBeLessThan(5_000);
  });

  it("leaves context out for Eleven v3 and when there is none", () => {
    expect(supportsElevenLabsContinuity("eleven_v3")).toBe(false);
    expect(supportsElevenLabsContinuity("eleven_multilingual_v2")).toBe(true);
    expect(buildElevenLabsBody({ text: "x", model: "eleven_v3", previousText: "Before.", nextText: "After." })).not.toHaveProperty("previous_text");
    expect(buildElevenLabsBody({ text: "x", model: "eleven_multilingual_v2", previousText: "   " })).not.toHaveProperty("previous_text");
  });

  it("uses a character's Deepgram voice as the model, and nothing else", () => {
    expect(deepgramModelFor("aura-2-thalia-en", "aura-2-zeus-en")).toBe("aura-2-zeus-en");
    expect(deepgramModelFor("aura-2-thalia-en", "aura-asteria-en")).toBe("aura-asteria-en");
    expect(deepgramModelFor("aura-2-thalia-en", "zeus")).toBe("aura-2-thalia-en");
    expect(deepgramModelFor("aura-2-thalia-en", null)).toBe("aura-2-thalia-en");
  });
});
