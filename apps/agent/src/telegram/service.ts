import { type Notification, randomToken, type TelegramStatus } from "@talorys/shared";
import { telegramHtmlChunks } from "./markdown";
import type { SecretBox } from "../services/secret-box";
import type { SettingsService } from "../services/settings";
import { clip } from "../services/text";

/** The bot's non-secret configuration. No secrets here: only ciphertext lives in `telegram.secrets`. */
interface TelegramConfig {
  bot_username: string;
  webhook_base_url: string;
  allowed_chat_id: number | null;
  notify_enabled: boolean;
  /** Which BOT_COMMANDS version Telegram last accepted; a mismatch re-registers the menu. */
  commands_version?: string;
}

/** Token and webhook secret at rest, both SecretBox ciphertexts bound to their context ids. */
interface TelegramSecrets {
  token: string;
  webhook_secret: string;
}

interface TelegramPairing {
  code: string;
  expires_at: string;
}

export interface BotApiResult {
  ok: boolean;
  result?: unknown;
  description?: string;
}

const CONFIG_KEY = "telegram.config";
const SECRETS_KEY = "telegram.secrets";
const PAIRING_KEY = "telegram.pairing";
const CONVERSATION_KEY = "telegram.conversation_id";

const API_TIMEOUT_MS = 10_000;
const PAIRING_TTL_MS = 15 * 60_000;
/** Telegram accepts one message of up to 4096 UTF-16 code units; notifications are trimmed below this. */
const TELEGRAM_MESSAGE_LIMIT = 4096;
const NOTIFY_BODY_LIMIT = 3500;

/** Code alphabet without 0/1/I/O, so a misread digit can't point at another valid code. */
const PAIRING_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/** The "/" menu Telegram shows above the keyboard: English by default, Russian for ru clients. */
const BOT_COMMANDS = [
  { command: "new", en: "Start a fresh conversation", ru: "Начать новый диалог" },
  { command: "resume", en: "Continue a recent conversation", ru: "Вернуться к недавнему диалогу" },
  { command: "context", en: "How full the conversation's context is", ru: "Заполненность контекста диалога" },
  { command: "compact", en: "Fold older messages into the summary", ru: "Сжать историю в краткую выжимку" },
  { command: "status", en: "Model, web search and notifications", ru: "Модель, поиск и уведомления" },
  { command: "help", en: "What this bot can do", ru: "Что умеет этот бот" },
] as const;

/**
 * Bumped whenever BOT_COMMANDS changes: bots whose stored menu version differs re-register
 * on their next message, so already-connected bots pick up new commands without reconnecting.
 */
const COMMANDS_VERSION = "3";

/**
 * Markdown for a Telegram notification: the title in bold over the body. Unlike push
 * messages, the body keeps its Markdown and its line breaks — the send path converts it
 * to Telegram HTML like a chat reply. The raw body is clipped so an overlong
 * automation result stays a bounded, readable message.
 */
export function telegramNotificationText(n: Pick<Notification, "title" | "body">): string {
  const title = n.title.replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim();
  const shortTitle = title.length > 100 ? `${clip(title, 99)}…` : title;
  const body = n.body.trim();
  const clipped = body.length > NOTIFY_BODY_LIMIT ? `${clip(body, NOTIFY_BODY_LIMIT - 1)}…` : body;
  return shortTitle ? `**${shortTitle}**\n\n${clipped}` : clipped;
}

/** Splits into pieces of at most `max` characters, preferring a line boundary over a mid-word cut. */
export function splitMessage(text: string, max = TELEGRAM_MESSAGE_LIMIT): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const lineBreak = window.lastIndexOf("\n");
    const at = lineBreak > max / 2 ? lineBreak : max;
    chunks.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  if (rest.length) chunks.push(rest);
  return chunks;
}

function randomPairingCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => PAIRING_ALPHABET[b % PAIRING_ALPHABET.length]).join("");
}

/**
 * Lets the owner talk to the agent from Telegram. The bot is single-owner: one chat links to
 * this deployment through a pairing code, every other chat is ignored. Like PushService,
 * delivery runs in the background and never fails the work that produced the notification.
 */
export class TelegramService {
  /** Replaced in tests; Bot API requests never follow redirects to another host. */
  fetcher: typeof fetch = (input, init) => fetch(input, init);
  private readonly pending = new Set<Promise<void>>();

  constructor(
    /** Exposed (as PushService exposes its repository) so tests can seed and inspect state keys. */
    readonly settings: SettingsService,
    private readonly secretBox: SecretBox,
    private readonly background: (work: Promise<unknown>) => void,
  ) {}

  private config(): TelegramConfig | null {
    return this.settings.getJson<TelegramConfig>(CONFIG_KEY);
  }

  private secrets(): TelegramSecrets | null {
    return this.settings.getJson<TelegramSecrets>(SECRETS_KEY);
  }

  /** The decrypted bot token, or null when absent or undecryptable (a rotated or missing secret). */
  async token(): Promise<string | null> {
    const stored = this.secrets()?.token;
    return stored ? this.secretBox.decrypt("token", stored) : null;
  }

  /** The decrypted webhook secret, or null when absent or undecryptable. */
  async webhookSecret(): Promise<string | null> {
    const stored = this.secrets()?.webhook_secret;
    return stored ? this.secretBox.decrypt("webhook", stored) : null;
  }

  /** The linked chat id, or null while the bot is not paired. */
  allowedChatId(): number | null {
    return this.config()?.allowed_chat_id ?? null;
  }

  /** The conversation the Telegram chat maps to, if one was started. */
  conversationId(): string | undefined {
    return this.settings.getJson<string>(CONVERSATION_KEY) ?? undefined;
  }

  /** Persists the conversation id once the runner created it, so later messages continue it. */
  rememberConversation(conversationId: string): void {
    this.settings.setJson(CONVERSATION_KEY, conversationId);
  }

  /** Drops the conversation mapping; the next message starts a fresh conversation. */
  forgetConversation(): void {
    this.settings.delete(CONVERSATION_KEY);
  }

  /** The outstanding pairing code, or null when none was issued or it has expired. */
  activePairing(): TelegramPairing | null {
    const pairing = this.settings.getJson<TelegramPairing>(PAIRING_KEY);
    if (!pairing) return null;
    if (new Date(pairing.expires_at).getTime() <= Date.now()) return null;
    return pairing;
  }

  /** One Bot API call. Never follows redirects (Cloudflare runtime limit, as in push/service.ts). */
  private async apiCall(token: string, method: string, payload: Record<string, unknown>): Promise<unknown> {
    const res = await this.fetcher(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
      redirect: "manual",
    });
    let body: BotApiResult;
    try {
      body = (await res.json()) as BotApiResult;
    } catch {
      throw new Error(`Telegram API returned an invalid response (${res.status})`);
    }
    if (!body.ok) throw new Error(body.description || `Telegram API call ${method} failed (${res.status})`);
    return body.result;
  }

  /**
   * Validates the token with getMe, registers the webhook, stores the encrypted secrets and
   * issues a pairing code. Telegram rejects webhook secrets outside [-_A-Za-z0-9]; `randomToken`
   * is base64url (43 characters for 32 bytes), which is inside that set and well under the cap.
   */
  async connect(token: string, webhookBaseUrl: string): Promise<TelegramStatus> {
    this.secretBox.assertAvailable();
    const webhookSecret = randomToken(32);
    const me = (await this.apiCall(token, "getMe", {})) as { username?: string } | undefined;
    await this.apiCall(token, "setWebhook", {
      url: `${webhookBaseUrl.replace(/\/+$/, "")}/api/telegram/webhook`,
      secret_token: webhookSecret,
      allowed_updates: ["message"],
      drop_pending_updates: true,
    });
    // SetWebhook is validated before anything is stored, so a bad URL leaves no half-connected state.
    this.settings.setJson(SECRETS_KEY, {
      token: await this.secretBox.encrypt("token", token),
      webhook_secret: await this.secretBox.encrypt("webhook", webhookSecret),
    });
    this.settings.setJson(CONFIG_KEY, {
      bot_username: me?.username ?? "",
      webhook_base_url: webhookBaseUrl,
      allowed_chat_id: null,
      notify_enabled: true,
    });
    await this.ensureCommands();
    this.issuePairing();
    return this.status();
  }

  /** Deletes the webhook best-effort and removes every Telegram key; the bot disappears entirely. */
  async disconnect(): Promise<TelegramStatus> {
    const token = await this.token();
    if (token) {
      try {
        await this.apiCall(token, "deleteWebhook", {});
      } catch (error) {
        console.warn("Telegram deleteWebhook failed", error instanceof Error ? error.message : String(error));
      }
    }
    for (const key of [CONFIG_KEY, SECRETS_KEY, PAIRING_KEY, CONVERSATION_KEY]) this.settings.delete(key);
    return this.status();
  }

  /** Issues (or re-issues) a one-time pairing code valid for 15 minutes. */
  reissuePairing(): TelegramPairing {
    return this.issuePairing();
  }

  private issuePairing(): TelegramPairing {
    const pairing = { code: randomPairingCode(), expires_at: new Date(Date.now() + PAIRING_TTL_MS).toISOString() };
    this.settings.setJson(PAIRING_KEY, pairing);
    return pairing;
  }

  /** Links the chat that presented a valid pairing code; the code is spent. */
  setPaired(chatId: number): void {
    const config = this.config();
    if (!config) return;
    this.settings.setJson(CONFIG_KEY, { ...config, allowed_chat_id: chatId });
    this.settings.delete(PAIRING_KEY);
  }

  async setNotifyEnabled(enabled: boolean): Promise<void> {
    const config = this.config();
    if (!config) return;
    this.settings.setJson(CONFIG_KEY, { ...config, notify_enabled: enabled });
  }

  /** True once Telegram accepted the current "/" command menu for this connection. */
  commandsRegistered(): boolean {
    return this.config()?.commands_version === COMMANDS_VERSION;
  }

  /**
   * Registers the "/" menu in the background when it isn't registered yet, so bots connected
   * before the menu existed pick it up on their next message instead of reconnecting.
   * Registration failures only delay the menu; they never touch the update being handled.
   */
  ensureCommandsInBackground(): void {
    if (this.commandsRegistered()) return;
    const work: Promise<void> = this.ensureCommands().finally(() => this.pending.delete(work));
    this.pending.add(work);
    this.background(work);
  }

  private async ensureCommands(): Promise<void> {
    const config = this.config();
    if (!config || config.commands_version === COMMANDS_VERSION) return;
    try {
      await this.setCommands();
    } catch (error) {
      console.warn("Telegram command menu registration failed", error instanceof Error ? error.message : String(error));
      return;
    }
    this.settings.setJson(CONFIG_KEY, { ...config, commands_version: COMMANDS_VERSION });
  }

  /** Two setMyCommands calls: the English default, then the Russian override for ru clients. */
  private async setCommands(): Promise<void> {
    const token = await this.token();
    if (!token) return;
    const commands = (lang: "en" | "ru") => BOT_COMMANDS.map(({ command, en, ru }) => ({ command, description: lang === "ru" ? ru : en }));
    await this.apiCall(token, "setMyCommands", { commands: commands("en") });
    await this.apiCall(token, "setMyCommands", { commands: commands("ru"), language_code: "ru" });
  }

  async status(): Promise<TelegramStatus> {
    const config = this.config();
    const connected = !!(await this.token());
    return {
      connected,
      bot_username: connected ? (config?.bot_username ?? null) : null,
      paired: connected && config?.allowed_chat_id != null,
      notify_enabled: connected ? (config?.notify_enabled ?? null) : null,
      webhook_base_url: connected ? (config?.webhook_base_url ?? null) : null,
      pairing: connected && !config?.allowed_chat_id ? this.activePairing() : null,
    };
  }

  /** Called for every new notification. Returns at once; delivery continues in the background. */
  notify(n: Notification): void {
    if (!this.secretBox.available || this.allowedChatId() == null || this.config()?.notify_enabled !== true) return;
    const work: Promise<void> = this.deliverNotification(n)
      .catch((error) => console.warn("Telegram delivery failed", error instanceof Error ? error.message : String(error)))
      .finally(() => this.pending.delete(work));
    this.pending.add(work);
    this.background(work);
  }

  /** Resolves when every background delivery started so far has finished (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  private async deliverNotification(n: Notification): Promise<void> {
    const chatId = this.allowedChatId();
    const token = await this.token();
    if (chatId == null || !token) return;
    await this.sendMessage(chatId, telegramNotificationText(n), { token, html: true });
  }

  /** Sends one chat message, splitting anything over Telegram's 4096-character limit. */
  async sendMessage(chatId: number, text: string, opts: { token?: string; html?: boolean } = {}): Promise<void> {
    const bearer = opts.token ?? (await this.token());
    if (!bearer) return;
    for (const chunk of opts.html ? telegramHtmlChunks(text) : splitMessage(text)) {
      await this.sendChunk(bearer, chatId, chunk, opts.html === true);
    }
  }

  /**
   * One chunk of a chat message. HTML chunks are sent with parse_mode so bold, code and
   * links render; a chunk Telegram refuses to parse still gets delivered, just unformatted.
   */
  private async sendChunk(token: string, chatId: number, text: string, html: boolean): Promise<void> {
    try {
      await this.apiCall(token, "sendMessage", html ? { chat_id: chatId, text, parse_mode: "HTML" } : { chat_id: chatId, text });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!html || !/parse/i.test(message)) throw error;
      console.warn("Telegram HTML message fell back to plain text", message);
      await this.apiCall(token, "sendMessage", { chat_id: chatId, text });
    }
  }

  /** Best-effort typing indicator; a failure here must never break the turn it precedes. */
  async sendChatAction(chatId: number, action: "typing"): Promise<void> {
    try {
      const token = await this.token();
      if (!token) return;
      await this.apiCall(token, "sendChatAction", { chat_id: chatId, action });
    } catch {
      /* the indicator is cosmetic */
    }
  }
}
