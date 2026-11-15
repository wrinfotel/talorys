import { documentUploadSchema } from "@talorys/shared";
import { Hono } from "hono";
import type { AppEnv } from "../app";
import { AppError, ValidationError } from "../errors";
import { body } from "../middleware";
import { MAX_DOCUMENT_BYTES, UnsupportedDocumentError } from "../../services/documents";

export const documentRoutes = new Hono<AppEnv>();

/** Decodes base64 (as sent by the web composer) into bytes. */
function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Uploads a document for the next chat turn. Text is extracted here; bytes are never stored. */
documentRoutes.post("/documents", async (c) => {
  const input = await body(c, documentUploadSchema, Math.ceil(MAX_DOCUMENT_BYTES * 1.4) + 65_536);
  const bytes = decodeBase64(input.data_base64);
  if (bytes.byteLength === 0) throw new ValidationError("The document is empty.");
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) throw new AppError("VALIDATION_ERROR", "Documents are limited to 12 MB.");
  try {
    const document = await c.env.agent.services.documents.ingest({ name: input.name, mime: input.mime, bytes });
    return c.json({ id: document.id, name: document.name, chars: document.chars });
  } catch (error) {
    if (error instanceof UnsupportedDocumentError) throw new ValidationError(error.message);
    throw error;
  }
});
