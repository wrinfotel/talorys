import { describe, expect, it } from "vitest";
import { AppError } from "../src/api/errors";
import { SecretBox } from "../src/services/secret-box";

const KEY = "test-secret-box-key-0123456789abcdefghij";

describe("SecretBox", () => {
  it("encrypts and decrypts a secret bound to its context id", async () => {
    const box = new SecretBox(KEY, "ai-provider");
    const stored = await box.encrypt("ctx-1", "sk-live-123");
    expect(stored.startsWith("v1.")).toBe(true);
    expect(await box.decrypt("ctx-1", stored)).toBe("sk-live-123");
    // A fresh IV is used for every encryption.
    expect(await box.encrypt("ctx-1", "sk-live-123")).not.toBe(stored);
  });

  it("returns null for a ciphertext bound to another context id", async () => {
    const box = new SecretBox(KEY, "ai-provider");
    const stored = await box.encrypt("ctx-1", "sk-live-123");
    expect(await box.decrypt("ctx-2", stored)).toBeNull();
  });

  it("does not decrypt across purposes", async () => {
    const stored = await new SecretBox(KEY, "ai-provider").encrypt("ctx-1", "sk-live-123");
    expect(await new SecretBox(KEY, "telegram").decrypt("ctx-1", stored)).toBeNull();
  });

  it("refuses to work with a short or missing secret", async () => {
    const short = new SecretBox("too-short", "ai-provider");
    expect(short.available).toBe(false);
    try {
      short.assertAvailable();
      expect.unreachable("assertAvailable should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("NOT_CONFIGURED");
    }
    expect(await short.decrypt("ctx-1", "v1.aGVsbG8.aGVsbG8")).toBeNull();

    const missing = new SecretBox(undefined, "ai-provider");
    expect(missing.available).toBe(false);
    expect(await missing.decrypt("ctx-1", "v1.aGVsbG8.aGVsbG8")).toBeNull();
  });
});
