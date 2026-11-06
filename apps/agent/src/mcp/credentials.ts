import { AppError } from "../api/errors";

const VERSION = "v1";
const encoder = new TextEncoder();

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (text: string) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

/**
 * Encrypts MCP credentials at rest with AES-256-GCM. The key is derived (HKDF-SHA256) from the
 * dedicated MCP_CREDENTIAL_KEY Worker secret, and the server id is bound as associated data, so
 * a ciphertext copied onto another server's row does not decrypt. Without the secret, servers
 * that need a credential can't be added; servers without authentication still work.
 */
export class McpCredentials {
  private key: Promise<CryptoKey> | null = null;

  constructor(private readonly secret: string | undefined) {}

  get available(): boolean {
    return typeof this.secret === "string" && this.secret.length >= 32;
  }

  assertAvailable(): void {
    if (!this.available) {
      throw new AppError("NOT_CONFIGURED", "Credential storage isn't set up on this deployment. Re-run the Talorys installer update (its `update` command) to add the MCP_CREDENTIAL_KEY secret.");
    }
  }

  private cryptoKey(): Promise<CryptoKey> {
    this.assertAvailable();
    this.key ??= crypto.subtle
      .importKey("raw", encoder.encode(this.secret), "HKDF", false, ["deriveKey"])
      .then((base) =>
        crypto.subtle.deriveKey(
          { name: "HKDF", hash: "SHA-256", salt: encoder.encode("talorys-mcp"), info: encoder.encode("credentials-v1") },
          base,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        ),
      );
    return this.key;
  }

  async encrypt(serverId: string, plaintext: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(serverId) }, await this.cryptoKey(), encoder.encode(plaintext));
    return `${VERSION}.${b64url(iv)}.${b64url(new Uint8Array(sealed))}`;
  }

  /** The plaintext credential, or null when it can't be decrypted (a rotated or missing secret). */
  async decrypt(serverId: string, stored: string): Promise<string | null> {
    const [version, iv, sealed] = stored.split(".");
    if (version !== VERSION || !iv || !sealed || !this.available) return null;
    try {
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: fromB64url(iv), additionalData: encoder.encode(serverId) },
        await this.cryptoKey(),
        fromB64url(sealed),
      );
      return new TextDecoder().decode(plain);
    } catch {
      return null;
    }
  }
}
