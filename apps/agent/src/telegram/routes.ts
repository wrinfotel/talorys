import { telegramConnectSchema } from "@talorys/shared";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AppEnv } from "../api/app";
import { AppError, ValidationError } from "../api/errors";
import { body } from "../api/middleware";
import { agentDeps, processUpdate } from "./handler";

/**
 * The parts of a Telegram update Talorys reacts to; unknown fields are stripped.
 * Updates without a text message are ignored by the handler.
 */
const webhookUpdateSchema = z.object({
  message: z
    .object({
      chat: z.object({ id: z.number().int() }),
      text: z.string().optional(),
    })
    .optional(),
});

async function digest(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

function digestsEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * The webhook is public but guarded by the secret Telegram itself sends in
 * `X-Telegram-Bot-Api-Secret-Token`. Both sides are SHA-256 hashed and the digests
 * compared byte by byte, so the time to reject a wrong guess reveals nothing about
 * the secret. A match sets the `telegram` variable, which is the only thing that
 * lets a request skip the CSRF and session checks (see api/middleware.ts).
 */
export const telegramWebhookAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method !== "POST") return next();
  const provided = c.req.header("X-Telegram-Bot-Api-Secret-Token");
  const expected = await c.env.agent.services.telegram.webhookSecret();
  if (!provided || !expected || !digestsEqual(await digest(provided), await digest(expected))) {
    throw new AppError("UNAUTHORIZED", "Unauthorized.");
  }
  c.set("telegram", { chatContext: true });
  return next();
};

/** Owner routes for setup and pairing, plus the public webhook the handler answers. */
export const telegramRoutes = new Hono<AppEnv>();

telegramRoutes.get("/telegram/status", async (c) => c.json(await c.env.agent.services.telegram.status()));

telegramRoutes.put("/telegram/config", async (c) => {
  const input = await body(c, telegramConnectSchema);
  try {
    return c.json(await c.env.agent.services.telegram.connect(input.token, input.webhook_base_url));
  } catch (error) {
    // Not-configured storage keeps its own code; anything else is Telegram rejecting the setup.
    if (error instanceof AppError) throw error;
    throw new ValidationError(error instanceof Error ? error.message : "Telegram rejected the bot setup.");
  }
});

telegramRoutes.post("/telegram/pair", (c) => c.json(c.env.agent.services.telegram.reissuePairing()));

telegramRoutes.patch("/telegram/config", async (c) => {
  const { notify_enabled } = await body(c, z.object({ notify_enabled: z.boolean() }));
  await c.env.agent.services.telegram.setNotifyEnabled(notify_enabled);
  return c.json(await c.env.agent.services.telegram.status());
});

telegramRoutes.delete("/telegram/config", async (c) => c.json(await c.env.agent.services.telegram.disconnect()));

telegramRoutes.post("/telegram/webhook", async (c) => {
  const update = await body(c, webhookUpdateSchema, 64 * 1024);
  const work = processUpdate(agentDeps(c.env.agent), update).catch((error) => console.error("Telegram update processing failed", error));
  // Telegram already gets its 200 below; the Durable Object keeps the turn alive, as it does
  // for background notification sends.
  c.env.agent.services.background(work);
  return Response.json({ ok: true });
});
