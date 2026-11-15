import { z } from "zod";
import { defineTool, ToolError } from "./registry";

/** How much text one read_document call returns; the model re-calls with an offset for the rest. */
const READ_CHUNK = 20_000;

export const documentTools = [
  defineTool({
    name: "read_document",
    description:
      "Read the text of a document attached to the owner's latest message (PDF or plain text, already extracted). Returns up to 20,000 characters from 'offset'; call again with the returned offset to continue.",
    permission: "read",
    maxCallsPerTurn: 8,
    input: z.object({
      document_id: z.string().min(1),
      offset: z.number().int().min(0).max(1_000_000).optional(),
    }),
    label: () => `Reading an attached document`,
    execute: async (i, ctx) => {
      const document = ctx.services.documents.get(i.document_id);
      if (!document) throw new ToolError("This document is no longer available — ask the owner to attach it again.");
      const offset = i.offset ?? 0;
      const text = document.text.slice(offset, offset + READ_CHUNK);
      return {
        document: document.name,
        total_chars: document.text.length,
        offset,
        text,
        more: offset + READ_CHUNK < document.text.length,
      };
    },
  }),
];
