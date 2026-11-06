import { describe, expect, it } from "vitest";
import {
  aiProviderStatusSchema,
  aiProviderTestSchema,
  aiProviderUpdateSchema,
  customProviderSchema,
  settingsUpdateSchema,
  telegramConnectSchema,
  telegramStatusSchema,
} from "../src/schemas";

const PROVIDER_UPDATE = { base_url: "https://api.example.com/v1", model: "gpt-4o" };
const TELEGRAM_WEBHOOK = { webhook_base_url: "https://talorys.example.com" };

describe("ai provider schemas", () => {
  it("accepts a valid provider update and makes api_key optional", () => {
    expect(aiProviderUpdateSchema.safeParse({ ...PROVIDER_UPDATE, api_key: "sk-123" }).success).toBe(true);
    expect(aiProviderUpdateSchema.safeParse(PROVIDER_UPDATE).success).toBe(true);
    expect(aiProviderUpdateSchema.safeParse({ ...PROVIDER_UPDATE, api_key: "" }).success).toBe(false);
  });

  it("rejects a non-URL or too long base_url", () => {
    expect(aiProviderUpdateSchema.safeParse({ base_url: "not-a-url", model: "gpt-4o" }).success).toBe(false);
    expect(aiProviderUpdateSchema.safeParse({ base_url: `https://${"a".repeat(500)}.example.com/v1`, model: "gpt-4o" }).success).toBe(false);
  });

  it("allows any partial field combination when testing an unsaved config", () => {
    expect(aiProviderTestSchema.safeParse({}).success).toBe(true);
    expect(aiProviderTestSchema.safeParse({ model: "gpt-4o" }).success).toBe(true);
    expect(aiProviderTestSchema.safeParse({ base_url: PROVIDER_UPDATE.base_url, api_key: "sk-123" }).success).toBe(true);
    expect(aiProviderTestSchema.safeParse({ base_url: "nope" }).success).toBe(false);
  });

  it("validates the status shape and its kind", () => {
    expect(aiProviderStatusSchema.safeParse({ kind: "workers-ai", base_url: null, model: null, has_api_key: false }).success).toBe(true);
    expect(aiProviderStatusSchema.safeParse({ kind: "custom", base_url: PROVIDER_UPDATE.base_url, model: "gpt-4o", has_api_key: true }).success).toBe(true);
    expect(aiProviderStatusSchema.safeParse({ kind: "other", base_url: null, model: null, has_api_key: false }).success).toBe(false);
  });

  it("stores a custom provider in settings and accepts an explicit null reset", () => {
    const provider = { baseUrl: "https://api.example.com/v1", model: "gpt-4o" };
    expect(customProviderSchema.safeParse(provider).success).toBe(true);
    expect(settingsUpdateSchema.safeParse({ aiProvider: provider }).success).toBe(true);
    expect(settingsUpdateSchema.safeParse({ aiProvider: null }).success).toBe(true);
    expect(settingsUpdateSchema.safeParse({ aiProvider: { baseUrl: "nope", model: "gpt-4o" } }).success).toBe(false);
  });
});

describe("telegram schemas", () => {
  it("accepts a valid bot token and webhook base url", () => {
    expect(telegramConnectSchema.safeParse({ token: "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw", ...TELEGRAM_WEBHOOK }).success).toBe(true);
  });

  it("rejects a malformed bot token", () => {
    // Too few digits before the colon.
    expect(telegramConnectSchema.safeParse({ token: "12345:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw", ...TELEGRAM_WEBHOOK }).success).toBe(false);
    // Secret part too short.
    expect(telegramConnectSchema.safeParse({ token: "123456789:short", ...TELEGRAM_WEBHOOK }).success).toBe(false);
    // Non-numeric bot id.
    expect(telegramConnectSchema.safeParse({ token: "abc:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw", ...TELEGRAM_WEBHOOK }).success).toBe(false);
  });

  it("validates the status shape", () => {
    const status = { connected: false, bot_username: null, paired: false, notify_enabled: null, webhook_base_url: null, pairing: null };
    expect(telegramStatusSchema.safeParse(status).success).toBe(true);
    expect(telegramStatusSchema.safeParse({ connected: false }).success).toBe(false);
  });
});
