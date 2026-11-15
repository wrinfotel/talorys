import { beforeEach, describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/runner";
import type { AgentEvent, AIProvider, GenerateRequest, ToolRequest } from "../src/ai/provider";
import { ALL_TOOLS, ToolExecutor } from "../src/tools";
import { defaultExtractor, MAX_DOCUMENT_TEXT } from "../src/services/documents";
import { inAgent } from "./helpers";

beforeEach(async () => {
  await inAgent((agent) => {
    agent.services.db.run(`DELETE FROM tal_documents`);
    agent.services.db.run(`DELETE FROM tal_messages`);
    agent.services.db.run(`DELETE FROM tal_conversations`);
    // The service instance (and a stubbed extractor from another test) persists across tests.
    agent.services.documents.extractor = defaultExtractor;
  });
});

/** Assembles a small but structurally valid one-page PDF with one line of text. */
function minimalPdf(text: string): Uint8Array {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) out += `${String(at).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(out);
}

describe("document ingestion", () => {
  it("stores plain text as-is and answers a reference", async () => {
    await inAgent(async (agent) => {
      const d = agent.services.documents;
      const doc = await d.ingest({ name: "notes.txt", mime: "text/plain", bytes: new TextEncoder().encode("hello world") });
      expect(doc.chars).toBe(11);
      expect(d.get(doc.id)!.text).toBe("hello world");
      expect(d.get(doc.id)!.name).toBe("notes.txt");
    });
  });

  it("extracts text from a real PDF through unpdf", async () => {
    await inAgent(async (agent) => {
      const doc = await agent.services.documents.ingest({ name: "report.pdf", mime: "application/pdf", bytes: minimalPdf("Hello Talorys PDF") });
      expect(doc.text).toContain("Hello Talorys PDF");
      expect(doc.mime_type).toBe("application/pdf");
    });
  });

  it("rejects kinds it cannot read with a clear message", async () => {
    await inAgent(async (agent) => {
      const d = agent.services.documents;
      await expect(d.ingest({ name: "program.exe", mime: "application/octet-stream", bytes: new Uint8Array([0x4d, 0x5a]) })).rejects.toThrow(
        "Only PDF and plain-text documents are supported",
      );
    });
  });

  it("caps the extracted text so a turn cannot be buried in it", async () => {
    await inAgent(async (agent) => {
      const d = agent.services.documents;
      d.extractor = async () => "x".repeat(MAX_DOCUMENT_TEXT + 5_000);
      const doc = await d.ingest({ name: "big.txt", mime: "text/plain", bytes: new Uint8Array(10) });
      expect(doc.chars).toBeLessThanOrEqual(MAX_DOCUMENT_TEXT + 200);
      expect(doc.text.endsWith("[The document was cut off")).toBe(false);
      expect(doc.text).toContain("[The document was cut off after");
    });
  });
});

describe("read_document tool and turn wiring", () => {
  it("returns chunks with offsets and refuses a gone document", async () => {
    await inAgent(async (agent) => {
      const s = agent.services;
      const doc = await s.documents.ingest({ name: "doc.txt", mime: "text/plain", bytes: new TextEncoder().encode("a".repeat(25_000)) });
      const executor = new ToolExecutor(ALL_TOOLS, { services: s, timezone: "UTC", mode: "chat" }, { maxToolCalls: 10 });
      const first = (await executor.execute("read_document", { document_id: doc.id }, "c1")) as { text: string; total_chars: number; more: boolean };
      expect(first.text).toHaveLength(20_000);
      expect(first.total_chars).toBe(25_000);
      expect(first.more).toBe(true);
      const second = (await executor.execute("read_document", { document_id: doc.id, offset: 20_000 }, "c2")) as { text: string; more: boolean };
      expect(second.text).toHaveLength(5_000);
      expect(second.more).toBe(false);
      await expect(executor.execute("read_document", { document_id: "nope" }, "c3")).rejects.toThrow("no longer available");
    });
  });

  it("a turn with documents stores the attachment note and offers the section to the model", async () => {
    await inAgent(async (agent) => {
      const s = agent.services;
      const doc = await s.documents.ingest({ name: "contract.txt", mime: "text/plain", bytes: new TextEncoder().encode("The fee is 42 euros.") });
      let seenSystem = "";
      const provider: AIProvider = {
        id: "workers-ai",
        model: "m",
        billable: false,
        async generate(_req: GenerateRequest) {
          return { text: "ok", usage: { model: "m", billable: false, inputTokens: { reported: 1, estimated: 0 }, outputTokens: { reported: 1, estimated: 0 }, cachedInputTokens: 0 } };
        },
        async *stream(): AsyncIterable<AgentEvent> {
          yield* this.generateWithTools({} as ToolRequest);
        },
        async *generateWithTools(req: ToolRequest): AsyncIterable<AgentEvent> {
          seenSystem = req.system;
          yield { type: "text", delta: "The fee is 42 euros." };
        },
      };
      const runner = new AgentRunner(s, provider);
      for await (const _ of runner.chat({ message: "what's the fee?", documentIds: [doc.id], signal: new AbortController().signal })) {
        /* drain */
      }
      // The user message in the conversation carries the attachment note, so later turns still see it.
      const last = s.conversations.messages(s.conversations.list({ limit: 1 })[0]!.id).find((m) => m.role === "user")!;
      expect(last.content).toContain(`[Attached document "contract.txt" — id ${doc.id}`);
      expect(last.content).toContain("read_document");
      // The system prompt told the model the document exists and how to read it.
      expect(seenSystem).toContain("Documents attached to the owner's latest message");
      expect(seenSystem).toContain(doc.id);
    });
  });

  it("a turn naming a missing document fails before anything is stored", async () => {
    await inAgent(async (agent) => {
      const s = agent.services;
      const provider: AIProvider = {
        id: "workers-ai",
        model: "m",
        billable: false,
        async generate() {
          throw new Error("should not be called");
        },
        async *stream(): AsyncIterable<AgentEvent> {
          yield* this.generateWithTools({} as ToolRequest);
        },
        // biome-ignore lint/correctness/useYield: the turn must fail before the provider is reached.
        async *generateWithTools(): AsyncIterable<AgentEvent> {
          throw new Error("should not be called");
        },
      };
      const runner = new AgentRunner(s, provider);
      await expect((async () => {
        for await (const _ of runner.chat({ message: "hi", documentIds: ["missing"], signal: new AbortController().signal })) {
          /* drain */
        }
      })()).rejects.toThrow("no longer available");
      expect(s.conversations.list({ limit: 1 })).toHaveLength(0);
    });
  });

  it("a retry cannot carry document_ids and is refused before anything is stored", async () => {
    await inAgent(async (agent) => {
      const s = agent.services;
      const doc = await s.documents.ingest({ name: "retry.txt", mime: "text/plain", bytes: new TextEncoder().encode("hello again") });
      const provider: AIProvider = {
        id: "workers-ai",
        model: "m",
        billable: false,
        async generate() {
          throw new Error("should not be called");
        },
        async *stream(): AsyncIterable<AgentEvent> {
          yield* this.generateWithTools({} as ToolRequest);
        },
        // biome-ignore lint/correctness/useYield: the turn must fail before the provider is reached.
        async *generateWithTools(): AsyncIterable<AgentEvent> {
          throw new Error("should not be called");
        },
      };
      const runner = new AgentRunner(s, provider);
      await expect((async () => {
        for await (const _ of runner.chat({ retry: true, conversationId: "no-such-conversation", message: "x", documentIds: [doc.id], signal: new AbortController().signal })) {
          /* drain */
        }
      })()).rejects.toThrow("can't be re-attached");
      expect(s.conversations.list({ limit: 1 })).toHaveLength(0);
    });
  });
});
