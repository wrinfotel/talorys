import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, streamText, type LanguageModelUsage, type ToolSet } from "ai";
import { AppError } from "../api/errors";
import type { AgentEvent, AIProvider, GenerateRequest, ToolRequest } from "./provider";
import { estimateTokens, modelUsage, tokenCount, tokens, type Usage } from "./provider";

/**
 * Any OpenAI-compatible chat completions API (OpenRouter, OpenAI, Groq, Ollama, ...)
 * through the AI SDK's OpenAI-compatible provider. Selected in Settings → AI;
 * Workers AI stays the default and the fallback.
 */
export class OpenAICompatibleProvider implements AIProvider {
  readonly id = "openai-compatible";
  // An external paid API: the daily request budget still applies.
  readonly billable = true;

  constructor(
    private readonly config: {
      baseUrl: string;
      apiKey: string;
      model: string;
      /** Fetch override for the connectivity test and unit tests; production uses the global fetch. */
      fetch?: typeof globalThis.fetch;
    },
  ) {}

  get model(): string {
    return this.config.model;
  }

  private createModel() {
    const provider = createOpenAICompatible({ baseURL: this.config.baseUrl, apiKey: this.config.apiKey, name: "talorys-custom", fetch: this.config.fetch });
    return provider.chatModel(this.config.model);
  }

  /** Maps the SDK's step usage onto Talorys' Usage, estimating whichever direction the provider did not report. */
  private usage(sdk: LanguageModelUsage | undefined, inputChars: number, outputChars: number): Usage {
    return modelUsage(
      this.model,
      true,
      tokens(tokenCount(sdk?.inputTokens), estimateTokens(inputChars)),
      tokens(tokenCount(sdk?.outputTokens), estimateTokens(outputChars)),
      tokenCount(sdk?.inputTokenDetails?.cacheReadTokens) ?? 0,
    );
  }

  async generate(req: GenerateRequest) {
    const inputChars = req.system.length + JSON.stringify(req.messages).length;
    try {
      const result = await generateText({
        model: this.createModel(),
        instructions: req.system,
        messages: req.messages,
        maxOutputTokens: req.maxOutputTokens,
        temperature: req.temperature,
        abortSignal: req.signal,
        // Retries would be model calls the daily budget cannot see; the UI offers Retry instead.
        maxRetries: 0,
      });
      return {
        text: result.text,
        usage: this.usage(result.usage, inputChars, result.text.length + (result.reasoningText?.length ?? 0)),
      };
    } catch (error) {
      throw classifyOpenAiCompatibleError(error);
    }
  }

  async *stream(req: GenerateRequest): AsyncIterable<AgentEvent> {
    yield* this.generateWithTools({ ...req, tools: [], maxIterations: 1, toolBudgetExhausted: () => true });
  }

  async *generateWithTools(req: ToolRequest): AsyncIterable<AgentEvent> {
    const tools: ToolSet = {};
    for (const t of req.tools) {
      tools[t.name] = {
        description: t.description,
        inputSchema: t.inputSchema,
        execute: async (input: unknown, options: { toolCallId: string }) => t.execute(input, options.toolCallId),
      } as ToolSet[string];
    }
    const hasTools = req.tools.length > 0;
    let streamError: unknown = null;
    const inputChars = req.system.length + JSON.stringify(req.messages).length;
    // Usage comes from each step's finish event; started steps without one (abort, quiet
    // stream error) are closed with estimates before the failure is rethrown.
    let started = 0;
    let reported = 0;
    let stepOutputChars = 0;
    const result = streamText({
      model: this.createModel(),
      instructions: req.system,
      messages: req.messages,
      maxOutputTokens: req.maxOutputTokens,
      temperature: req.temperature,
      abortSignal: req.signal,
      // Retries would be model calls the daily budget cannot see; the UI offers Retry instead.
      maxRetries: 0,
      ...(hasTools
        ? {
            tools,
            // Every further step is another model call: stop at the step cap or when the daily budget is spent.
            stopWhen: ({ steps }: { steps: unknown[] }) =>
              steps.length >= req.maxIterations || (req.reserveNextStep ? !req.reserveNextStep() : false),
            // On the last allowed step, or once the tool budget is spent, force a plain-text answer.
            prepareStep: ({ stepNumber }: { stepNumber: number }) =>
              stepNumber >= req.maxIterations - 1 || req.toolBudgetExhausted() ? { toolChoice: "none" as const } : {},
          }
        : {}),
      onError: ({ error }: { error: unknown }) => {
        streamError = error;
      },
    });

    let failure: unknown = null;
    try {
      for await (const part of result.fullStream) {
        switch (part.type) {
          case "start-step":
            started++;
            break;
          case "reasoning-delta":
            // Counted for the usage estimate but never streamed to the owner.
            stepOutputChars += part.text.length;
            break;
          case "text-delta":
            stepOutputChars += part.text.length;
            if (part.text) yield { type: "text", delta: part.text };
            break;
          case "tool-call":
            stepOutputChars += JSON.stringify({ name: part.toolName, input: part.input }).length;
            yield { type: "tool-start", id: part.toolCallId, name: part.toolName, input: part.input };
            break;
          case "tool-result":
            yield { type: "tool-end", id: part.toolCallId, name: part.toolName, output: part.output };
            break;
          case "tool-error":
            yield {
              type: "tool-end",
              id: part.toolCallId,
              name: part.toolName,
              output: null,
              error: part.error instanceof Error ? part.error.message : String(part.error),
            };
            break;
          case "finish-step":
            yield { type: "usage", usage: this.usage(part.usage, inputChars, stepOutputChars) };
            reported++;
            stepOutputChars = 0;
            break;
          case "error":
            throw part.error;
          default:
            break;
        }
      }
    } catch (error) {
      failure = error;
    }
    failure ??= streamError;
    // Every model call that started and has no finish-step yet is estimated before any error
    // is rethrown: after a quiet abort, a stream error or a failed call.
    for (; reported < started; reported++) {
      yield { type: "usage", usage: this.usage(undefined, inputChars, stepOutputChars) };
      stepOutputChars = 0;
    }
    if (failure) throw classifyOpenAiCompatibleError(failure);
  }
}

/**
 * Maps OpenAI-compatible API failures onto stable application errors, with messages that
 * point the owner at Settings → AI where the base URL, model and key can be fixed.
 */
export function classifyOpenAiCompatibleError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const status = apiStatus(error);
  const text = apiErrorText(error);
  const lower = text.toLowerCase();
  if (status === 401 || status === 403) {
    return new AppError("AI_UNAVAILABLE", "The custom provider rejected the API key. Check it in Settings → AI.");
  }
  if (status === 402 || /quota|credit|insufficient/.test(lower)) {
    return new AppError("AI_QUOTA_EXHAUSTED", "The custom provider reports an exhausted balance or quota. Top it up on the provider's dashboard, then try again.");
  }
  if (status === 429) {
    return new AppError("AI_UNAVAILABLE", "The custom provider is rate limited right now. Please try again in a moment.");
  }
  if (status === 404 || /unknown model|model not found|no such model|no endpoints found|does not exist/.test(lower)) {
    return new AppError("AI_UNAVAILABLE", "The configured model is not available on the custom provider. Check it in Settings → AI.");
  }
  if (lower.includes("abort")) {
    return new AppError("AI_UNAVAILABLE", "The response was cancelled.");
  }
  console.error("Custom AI provider error", status ?? "", text);
  return new AppError("AI_UNAVAILABLE", "The custom AI provider could not respond. Please try again.");
}

/** HTTP status of an AI SDK API failure, when the request reached the provider. */
function apiStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const status = (error as { statusCode?: unknown }).statusCode ?? (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

/** Message plus the raw response body, so provider-specific failure reasons stay visible. */
function apiErrorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const body = (error as { responseBody?: unknown }).responseBody;
  const cause = (error as { cause?: unknown }).cause;
  return `${error.name}: ${error.message}${typeof body === "string" && body ? ` (${body.slice(0, 500)})` : ""}${cause ? ` (${apiErrorText(cause)})` : ""}`;
}
