import type { SecretBox } from "./secret-box";
import type { SettingsService } from "./settings";

const CREDENTIALS_KEY = "web-search.credentials";

/** Search providers the owner can store a key for; both jump ahead of the keyless ring. */
export type SearchKeyProvider = "tavily" | "keenable";

interface StoredKeys {
  /** Encrypted Tavily key (or the pre-ring `credential` field, which was always Tavily). */
  tavily?: string;
  /** Encrypted Keenable key (free key: 100,000 requests a month). */
  keenable?: string;
  /** Legacy single-key storage, kept readable so existing deployments keep their Tavily key. */
  credential?: string;
}

/**
 * Optional API keys for the web_search tool, encrypted at rest with the same purpose-separated
 * SecretBox as the other user-supplied secrets. Without any key the tool runs its keyless ring
 * (Exa → Parallel → Firecrawl → Bing); a stored key moves that provider to the front.
 */
export class WebSearchService {
  constructor(
    private readonly settings: SettingsService,
    private readonly secretBox: SecretBox,
  ) {}

  private stored(): StoredKeys {
    return this.settings.getJson<StoredKeys>(CREDENTIALS_KEY) ?? {};
  }

  /** The decrypted Tavily key, or null when none is stored or it can't be decrypted. */
  async tavilyKey(): Promise<string | null> {
    const stored = this.stored();
    const cipher = stored.tavily ?? stored.credential;
    if (!cipher) return null;
    return this.secretBox.decrypt("key", cipher);
  }

  /** The decrypted Keenable key, or null when none is stored or it can't be decrypted. */
  async keenableKey(): Promise<string | null> {
    const cipher = this.stored().keenable;
    if (!cipher) return null;
    return this.secretBox.decrypt("key", cipher);
  }

  async setKey(provider: SearchKeyProvider, key: string): Promise<void> {
    this.secretBox.assertAvailable();
    const next: StoredKeys = { ...this.stored(), [provider]: await this.secretBox.encrypt("key", key) };
    // The legacy single-key field is folded into the named one on the first write.
    delete next.credential;
    await this.settings.setJson(CREDENTIALS_KEY, next);
  }

  async clearKey(provider: SearchKeyProvider): Promise<void> {
    const next: StoredKeys = { ...this.stored() };
    if (provider === "tavily") {
      delete next.tavily;
      delete next.credential;
    } else {
      delete next.keenable;
    }
    await this.settings.setJson(CREDENTIALS_KEY, next);
  }
}
