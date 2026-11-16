import { describe, expect, it } from "vitest";
import { WebSearchService } from "../src/services/web-search";
import { SecretBox } from "../src/services/secret-box";
import type { SettingsService } from "../src/services/settings";

const SECRET = "unit-test-secret-0123456789abcdef-unit";
const box = new SecretBox(SECRET, "web-search");
const cipherOf = (plain: string) => box.encrypt("key", plain);

const service = () => new WebSearchService(new FakeSettings() as unknown as SettingsService, new SecretBox(SECRET, "web-search"));

class FakeSettings {
  private store = new Map<string, unknown>();
  getJson<T>(key: string): T | null {
    return (this.store.get(key) as T) ?? null;
  }
  async setJson(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
  }
  delete(key: string): void {
    this.store.delete(key);
  }
}

/** Pre-seeds the service's settings with a raw (already-encrypted) record, like a previous version wrote. */
async function withStored(s: WebSearchService, value: Record<string, string>): Promise<void> {
  await (s as unknown as { settings: FakeSettings }).settings.setJson("web-search.credentials", value);
}

const storedKeys = (s: WebSearchService) => (s as unknown as { settings: FakeSettings }).settings.getJson<Record<string, string>>("web-search.credentials");

describe("WebSearchService", () => {
  it("starts with no keys", async () => {
    const s = service();
    expect(await s.tavilyKey()).toBeNull();
    expect(await s.keenableKey()).toBeNull();
  });

  it("stores both keys encrypted and reads them back", async () => {
    const s = service();
    await s.setKey("tavily", "tvly-live-key-0000000000000000");
    await s.setKey("keenable", "keenable-live-key-0000000000");
    const stored = storedKeys(s);
    expect(stored?.tavily).toBeTruthy();
    expect(stored?.tavily).not.toContain("tvly-live-key");
    expect(stored?.keenable).toBeTruthy();
    expect(stored?.keenable).not.toContain("keenable-live-key");
    expect(await s.tavilyKey()).toBe("tvly-live-key-0000000000000000");
    expect(await s.keenableKey()).toBe("keenable-live-key-0000000000");
  });

  it("reads the legacy single-key storage as the Tavily key", async () => {
    const s = service();
    await withStored(s, { credential: await cipherOf("tvly-legacy-key-000000000") });
    expect(await s.tavilyKey()).toBe("tvly-legacy-key-000000000");
    expect(await s.keenableKey()).toBeNull();
  });

  it("folds the legacy field away on the next write", async () => {
    const s = service();
    await withStored(s, { credential: await cipherOf("tvly-legacy-key-000000000") });
    await s.setKey("tavily", "tvly-new-key-000000000000000");
    const stored = storedKeys(s);
    expect(stored?.credential).toBeUndefined();
    expect(stored?.tavily).toBeTruthy();
    expect(await s.tavilyKey()).toBe("tvly-new-key-000000000000000");
  });

  it("returns null for a key encrypted with a different secret", async () => {
    const s = service();
    await s.setKey("tavily", "tvly-live-key-0000000000000000");
    const rotated = new WebSearchService((s as unknown as { settings: FakeSettings }).settings as unknown as SettingsService, new SecretBox(SECRET + "x", "web-search"));
    expect(await rotated.tavilyKey()).toBeNull();
    expect(await rotated.keenableKey()).toBeNull();
  });

  it("clears each key separately", async () => {
    const s = service();
    await s.setKey("tavily", "tvly-live-key-0000000000000000");
    await s.setKey("keenable", "keenable-live-key-0000000000");
    await s.clearKey("tavily");
    expect(await s.tavilyKey()).toBeNull();
    expect(await s.keenableKey()).toBe("keenable-live-key-0000000000");
    await s.clearKey("keenable");
    expect(await s.keenableKey()).toBeNull();
  });
});
