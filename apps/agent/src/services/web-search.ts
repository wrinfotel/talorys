import { SecretBox } from "./secret-box";
import type { SettingsService } from "./settings";

const CREDENTIALS_KEY = "web-search.credentials";

/**
 * Optional Tavily API key for the web_search tool, encrypted at rest with the same
 * purpose-separated SecretBox as the other user-supplied secrets. Without a key the
 * tool falls back to its built-in Bing results.
 */
export class WebSearchService {
  constructor(
    private readonly settings: SettingsService,
    private readonly secretBox: SecretBox,
  ) {}

  /** The decrypted Tavily key, or null when none is stored or it can't be decrypted. */
  async apiKey(): Promise<string | null> {
    const stored = this.settings.getJson<{ credential?: string }>(CREDENTIALS_KEY);
    if (!stored?.credential) return null;
    return this.secretBox.decrypt("key", stored.credential);
  }

  async setApiKey(key: string): Promise<void> {
    this.secretBox.assertAvailable();
    await this.settings.setJson(CREDENTIALS_KEY, { credential: await this.secretBox.encrypt("key", key) });
  }

  async clearApiKey(): Promise<void> {
    this.settings.delete(CREDENTIALS_KEY);
  }
}
