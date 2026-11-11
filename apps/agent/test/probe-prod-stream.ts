/**
 * Prod-faithful probe run OUTSIDE vitest (vitest here wraps tests in a workerd sandbox
 * with no host fs/env). Bundled with esbuild, run with plain node.
 * Build: npx esbuild test/probe-prod-stream.ts --bundle --format=esm --platform=node --outfile=/tmp/probe-prod-stream.mjs
 * Run:   PROBE_MODEL=nvidia/... node /tmp/probe-prod-stream.mjs
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { streamText, type ToolSet } from "ai";
import { buildSystemPrompt } from "../src/agent/prompt";
import { ALL_TOOLS } from "../src/tools";

const NEWS_TASK =
  "Ежедневные новости AI-рынка: собери топ новостей за сегодня и коротко резюмируй каждую (2-3 предложения).";
const WEATHER_TASK = "Какая погода в Москве сегодня? Коротко.";

function stubTools(): ToolSet {
  const tools: ToolSet = {};
  for (const t of ALL_TOOLS) {
    tools[t.name] = {
      description: t.description,
      inputSchema: t.input,
      execute: async () => ({ stub: true, note: "probe stub result" }),
    } as ToolSet[string];
  }
  return tools;
}

async function runOnce(label: string, task: string, withTools: boolean, maxOutputTokens: number): Promise<void> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY missing (source /root/.hermes/.env first)");
  const model = process.env.PROBE_MODEL ?? "dots-studio/dots-3-note-preview:free";
  const provider = createOpenAICompatible({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: key,
    name: "talorys-custom",
  });
  const system = buildSystemPrompt({
    agentName: "Talorys",
    timezone: "Europe/Berlin",
    now: new Date(),
    autoMemory: false,
    memories: [],
    scheduled: true,
  });
  const maxSteps = Number(process.env.PROBE_MAX_STEPS ?? 10);
  const result = streamText({
    model: provider.chatModel(model),
    instructions: system,
    messages: [{ role: "user", content: task }],
    maxOutputTokens,
    temperature: 0.4,
    maxRetries: 0,
    ...(withTools
      ? {
          tools: stubTools(),
          stopWhen: ({ steps }: { steps: unknown[] }) => steps.length >= maxSteps,
          prepareStep: ({ stepNumber }: { stepNumber: number }) =>
            stepNumber >= maxSteps - 1 ? { toolChoice: "none" as const } : {},
        }
      : {}),
    onError: ({ error }: { error: unknown }) => console.log(`[${label}] onError:`, String(error).slice(0, 300)),
  });
  const counts: Record<string, number> = {};
  let finishReason = "";
  let usageStr = "";
  const textChunks: string[] = [];
  const reasonChunks: string[] = [];
  for await (const part of result.fullStream) {
    counts[part.type] = (counts[part.type] ?? 0) + 1;
    switch (part.type) {
      case "text-delta":
        textChunks.push(part.text);
        break;
      case "reasoning-delta":
        reasonChunks.push((part as unknown as { text: string }).text);
        break;
      case "finish-step": {
        const fr = (part as unknown as { finishReason?: unknown }).finishReason;
        finishReason += `${String(fr)};`;
        usageStr = JSON.stringify(part.usage ?? {});
        break;
      }
      case "tool-call":
        console.log(`[${label}] tool-call:`, part.toolName);
        break;
      case "error":
        console.log(`[${label}] error part:`, String(part.error).slice(0, 300));
        break;
      default:
        break;
    }
  }
  const text = textChunks.join("");
  const reasoning = reasonChunks.join("");
  console.log(
    `[${label}] parts=${JSON.stringify(counts)} finish=${finishReason || "NONE"} usage=${usageStr} textLen=${text.length} reasoningLen=${reasoning.length}`,
  );
  console.log(`[${label}] text~:`, JSON.stringify(text.slice(0, 160)));
  if (reasoning.length) console.log(`[${label}] reasoning~:`, JSON.stringify(reasoning.slice(0, 160)));
}

const cap = Number(process.env.PROBE_MAX_TOKENS ?? 2000);
async function main(): Promise<void> {
  await runOnce("news+tools", NEWS_TASK, true, cap);
  await runOnce("weather+tools", WEATHER_TASK, true, cap);
  await runOnce("news-notools", NEWS_TASK, false, cap);
  console.log("probe done");
}
void main();
