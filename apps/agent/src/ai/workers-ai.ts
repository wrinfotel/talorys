import { generateText, streamText, type ToolSet } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import type { AgentEvent, AIProvider, GenerateRequest, ToolRequest } from "./provider";
import { classifyAiError, withUsage } from "./provider";
import { meteredBinding, stepUsage, type StepMeter } from "./workers-ai-usage";

/**
 * Cloudflare Workers AI through the AI SDK's official Workers AI provider.
 * Reasoning ("thinking") is disabled by default to keep Neuron usage low.
 */
export class CloudflareWorkersAIProvider implements AIProvider {
  readonly id = "workers-ai";
  readonly billable = true;

  constructor(
    private readonly binding: Ai,
    readonly model: string,
  ) {}

  private createModel(steps: StepMeter[]) {
    const workersai = createWorkersAI({ binding: meteredBinding(this.binding, steps) });
    return workersai(this.model as Parameters<typeof workersai>[0], {
      chat_template_kwargs: { enable_thinking: false },
    });
  }

  async generate(req: GenerateRequest) {
    const steps: StepMeter[] = [];
    try {
      const result = await generateText({
        model: this.createModel(steps),
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
        usage: stepUsage(this.model, steps[0]!, result.text.length + (result.reasoningText?.length ?? 0)),
      };
    } catch (error) {
      // A call that reached the binding is metered even when it fails (docs/architecture.md).
      throw withUsage(classifyAiError(error), steps[0] && stepUsage(this.model, steps[0], 0));
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
    const steps: StepMeter[] = [];
    let stepIndex = 0;
    let stepOutputChars = 0;
    const result = streamText({
      model: this.createModel(steps),
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
          case "reasoning-delta":
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
            // An "error" step still ran: its prompt was processed and any received counts are kept.
            if (steps[stepIndex]) {
              yield { type: "usage", usage: stepUsage(this.model, steps[stepIndex]!, stepOutputChars), finishReason: part.finishReason };
            }
            stepIndex++;
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
    // Every binding call that started and has no finish-step yet is metered before any error is
    // rethrown: after a quiet abort, a stream error or a failed call (docs/architecture.md).
    for (; stepIndex < steps.length; stepIndex++) {
      yield { type: "usage", usage: stepUsage(this.model, steps[stepIndex]!, stepOutputChars) };
      stepOutputChars = 0;
    }
    if (failure) throw classifyAiError(failure);
  }
}
