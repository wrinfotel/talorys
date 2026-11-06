import { AppError } from "../api/errors";

const VERSION = "v1";
const encoder = new TextEncoder();

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (text: string) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

/**
 * Encrypts small secrets at rest (API keys, bot tokens) with AES-256-GCM. The key is derived
 * (HKDF-SHA256) from the MCP_CREDENTIAL_KEY Worker secret; `purpose` separates derivation
 * domains, so one secret serves several features without re-deriving a shared key.
 */
export class SecretBox {
  private key: Promise<CryptoKey> | null = null;

  constructor(private readonly secret: string | undefined, private readonly purpose: string) {}

  get available(): boolean {
    return typeof this.secret === "string" && this.secret.length >= 32;
  }

  assertAvailable(): void {
    if (!this.available) {
      throw new AppError("NOT_CONFIGURED", "Secret storage isn't set up on this deployment. Run `npx create-talorys update` to add the MCP_CREDENTIAL_KEY secret.");
    }
  }

  private cryptoKey(): Promise<CryptoKey> {
    this.assertAvailable();
    this.key ??= crypto.subtle
      .importKey("raw", encoder.encode(this.secret), "HKDF", false, ["deriveKey"])
      .then((base) =>
        crypto.subtle.deriveKey(
          { name: "HKDF", hash: "SHA-256", salt: encoder.encode(`talorys-${this.purpose}`), info: encoder.encode(`${this.purpose}-v1`) },
          base,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        ),
      );
    return this.key;
  }

  async encrypt(contextId: string, plaintext: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(contextId) }, await this.cryptoKey(), encoder.encode(plaintext));
    return `${VERSION}.${b64url(iv)}.${b64url(new Uint8Array(sealed))}`;
  }

  /** The plaintext secret, or null when it can't be decrypted (a rotated or missing secret). */
  async decrypt(contextId: string, stored: string): Promise<string | null> {
    const [version, iv, sealed] = stored.split(".");
    if (version !== VERSION || !iv || !sealed || !this.available) return null;
    try {
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: fromB64url(iv), additionalData: encoder.encode(contextId) },
        await this.cryptoKey(),
        fromB64url(sealed),
      );
      return new TextDecoder().decode(plain);
    } catch {
      return null;
    }
  }
}
