import type { TalorysAgent } from "../agent/talorys-agent";
import type { AgentRunner } from "../agent/runner";
import type { Services } from "../services/container";

/** The part of a Telegram update this handler reacts to. Everything else is ignored. */
export interface TelegramUpdateMessage {
  chat: { id: number };
  text?: string;
}

export interface TelegramUpdate {
  message?: TelegramUpdateMessage;
}

/** Everything the handler needs from the agent; a real TalorysAgent satisfies it directly. */
export interface UpdateHandlerDeps {
  services: Services;
  /** Async since the custom-provider work: the agent resolves its AI provider per turn. */
  runner: () => Promise<AgentRunner>;
  /** In-flight chat turns keyed by conversation id, as in the web chat routes. */
  activeRuns: Map<string, AbortController>;
  /** Resolves to the stored custom-provider API key (null when absent or unreadable); the real agent satisfies this. */
  customProviderKey?: () => Promise<string | null>;
}

const PAIRED_REPLY = "Paired! This chat is now linked to your Talorys agent.";
/** Also the answer to any non-`/start` message from an unlinked chat, so a stranger learns why it is silent. */
const PRIVATE_HINT =
  "This bot is private. Generate a pairing code in Talorys → Settings → Integrations and send /start <code>.";
const BUSY_REPLY = "I'm still answering your previous message — one at a time for now.";
const NEW_CONVERSATION_REPLY = "Started a new conversation.";
const HELP_REPLY = [
  "You can send me messages in plain text — I answer like the chat in Talorys, with the same tools and memories.",
  "/new — start a fresh conversation (the old one stays in Talorys).",
  "/status — the model I'm running on, and whether web search and notifications are on.",
  "/help — this text.",
  "Reminders and automation results are also delivered to this chat while notifications are on.",
].join("\n");
const AI_ERROR_REPLY = "The AI model could not respond. Try again in a moment.";
const FAILED_REPLY = "Something went wrong.";

/** One-time pairing codes: 8 characters from the digits-and-uppercase alphabet. */
const PAIRING_CODE = /^\/start\s+([A-Z2-9]{8})$/;

/** The "/status" answer: what the assistant is running on, in the same voice as the web UI. */
async function statusReply(deps: UpdateHandlerDeps): Promise<string> {
  const custom = deps.services.settings.get().aiProvider;
  let model = "Cloudflare Workers AI (the built-in free model)";
  if (custom) {
    const readable = deps.customProviderKey ? (await deps.customProviderKey()) !== null : true;
    model = readable
      ? `${custom.model} (your custom provider)`
      : `${custom.model} (custom provider — the API key is unreadable, save it again in Settings → AI)`;
  }
  const search = (await deps.services.webSearch.apiKey()) ? "Tavily" : "built-in (no API key)";
  const notifications = (await deps.services.telegram.status()).notify_enabled === true ? "on" : "off";
  return [
    "Here's how I'm set up:",
    `• Model: ${model}`,
    `• Web search: ${search}`,
    `• Notifications to this chat: ${notifications}`,
  ].join("\n");
}

/**
 * Handles one Telegram webhook update. Telegram already got its 200 by the time this runs, so
 * nothing here throws: failures are logged and, when the chat can be reached, answered with a
 * short apology instead.
 */
export async function processUpdate(deps: UpdateHandlerDeps, update: TelegramUpdate): Promise<void> {
  const text = update.message?.text?.trim();
  const chatId = update.message?.chat.id;
  if (!text || chatId === undefined) return;
  const telegram = deps.services.telegram;
  try {
    // 1. Unlinked chats may only pair via /start <code>; every other message is ignored.
    const allowedChatId = telegram.allowedChatId();
    if (allowedChatId == null) {
      const match = PAIRING_CODE.exec(text);
      if (!match) return;
      const pairing = telegram.activePairing();
      if (pairing && pairing.code === match[1]) {
        telegram.setPaired(chatId);
        await telegram.sendMessage(chatId, PAIRED_REPLY);
      } else {
        await telegram.sendMessage(chatId, PRIVATE_HINT);
      }
      return;
    }

    // 2. The bot is single-owner: a different chat is silently ignored, but the attempt is logged.
    if (chatId !== allowedChatId) {
      deps.services.activity.record("telegram.stranger", `Ignored a message from unlinked Telegram chat ${chatId}`);
      return;
    }

    // 3. Owner commands. The "/" menu above the keyboard is registered in the background
    //    when needed, so bots connected before the menu existed pick it up on this message.
    telegram.ensureCommandsInBackground();
    if (text === "/new") {
      telegram.forgetConversation();
      await telegram.sendMessage(chatId, NEW_CONVERSATION_REPLY);
      return;
    }
    if (text === "/status") {
      await telegram.sendMessage(chatId, await statusReply(deps));
      return;
    }
    if (text === "/help") {
      await telegram.sendMessage(chatId, HELP_REPLY);
      return;
    }

    // 4. A regular message: one agent turn, keyed by conversation id exactly like the web chat,
    //    so /api/chat/cancel also cancels a Telegram turn.
    const remembered = telegram.conversationId();
    // A conversation deleted in the web UI must not wedge the chat; start a fresh one instead.
    const storedConversationId = remembered && deps.services.conversations.get(remembered) ? remembered : undefined;
    if (remembered && !storedConversationId) telegram.forgetConversation();
    if (storedConversationId && deps.activeRuns.has(storedConversationId)) {
      await telegram.sendMessage(chatId, BUSY_REPLY);
      return;
    }
    await telegram.sendChatAction(chatId, "typing");

    const controller = new AbortController();
    let conversationId: string | undefined = storedConversationId;
    if (conversationId) deps.activeRuns.set(conversationId, controller);
    let reply = "";
    let errorReply: string | null = null;
    try {
      for await (const event of (await deps.runner()).chat({ conversationId, message: text, signal: controller.signal })) {
        if (event.type === "start") {
          // The web routes move their claim to the new conversation id; so do we, and remember it.
          conversationId = event.conversation_id;
          deps.activeRuns.set(conversationId, controller);
          if (event.conversation_id !== storedConversationId) telegram.rememberConversation(event.conversation_id);
        } else if (event.type === "text") {
          reply += event.delta;
        } else if (event.type === "error") {
          errorReply = event.message;
        }
        // title, tool and done events don't contribute to the reply; done confirms persistence.
      }
    } finally {
      if (conversationId && deps.activeRuns.get(conversationId) === controller) deps.activeRuns.delete(conversationId);
    }

    // A cancelled turn sends nothing: the owner already aborted it (e.g. from the web UI).
    if (controller.signal.aborted) return;
    if (reply.trim()) await telegram.sendMessage(chatId, reply.trim());
    else await telegram.sendMessage(chatId, errorReply ?? AI_ERROR_REPLY);
  } catch (error) {
    console.error("Telegram update processing failed", error);
    // The webhook already answered 200; best-effort apology, itself never throwing.
    await telegram.sendMessage(chatId, FAILED_REPLY).catch(() => {});
  }
}

/** Convenience for the webhook route: the real agent carries services, a runner and activeRuns. */
export function agentDeps(agent: TalorysAgent): UpdateHandlerDeps {
  return { services: agent.services, runner: () => agent.runner(), activeRuns: agent.activeRuns, customProviderKey: () => agent.customProviderKey() };
}
