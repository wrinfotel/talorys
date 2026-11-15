import { extractText, getDocumentProxy } from "unpdf";
import type { DocumentRepository, StoredDocument } from "../db/repositories/documents";

export type { StoredDocument };

/** Upload cap for a document; base64 inflates this to ~16 MB on the wire. */
export const MAX_DOCUMENT_BYTES = 12 * 1024 * 1024;
/** Extracted text cap, like note content: a turn never needs more raw text than this. */
export const MAX_DOCUMENT_TEXT = 200_000;
/** Telegram's Bot API serves files up to 20 MB through getFile; stay under it. */
export const MAX_TELEGRAM_DOCUMENT_BYTES = 20 * 1024 * 1024;

/** A file Talorys cannot extract text from (only PDF and plain text for now). */
export class UnsupportedDocumentError extends Error {}

/** Turns raw bytes into plain text. Injectable, so tests can stand in for pdf.js. */
export type TextExtractor = (bytes: Uint8Array, mime: string, name: string) => Promise<string>;

const TEXT_SUFFIXES = [".txt", ".md", ".csv", ".json", ".log", ".xml", ".yaml", ".yml", ".html", ".htm"];

function isPlainText(mime: string, name: string): boolean {
  const lower = mime.toLowerCase();
  return lower.startsWith("text/") || ["application/json", "application/xml", "application/yaml"].includes(lower) || TEXT_SUFFIXES.some((s) => name.toLowerCase().endsWith(s));
}

export async function defaultExtractor(bytes: Uint8Array, mime: string, name: string): Promise<string> {
  if (mime.toLowerCase() === "application/pdf" || name.toLowerCase().endsWith(".pdf")) {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await extractText(pdf, { mergePages: true });
    return Array.isArray(text) ? text.join("\n\n") : text;
  }
  if (isPlainText(mime, name)) return new TextDecoder().decode(bytes);
  throw new UnsupportedDocumentError("Only PDF and plain-text documents are supported for now.");
}

/**
 * Stores chat-attached documents. The original bytes are never persisted — the agent
 * reads the extracted text through the read_document tool, and 30 days later the row
 * is pruned like a pending action.
 */
export class DocumentService {
  /** Replaced in tests so a PDF fixture is never needed. */
  extractor: TextExtractor = defaultExtractor;

  constructor(private readonly repo: DocumentRepository) {}

  async ingest(input: { name: string; mime: string; bytes: Uint8Array }): Promise<StoredDocument> {
    const name = input.name.trim() || "document";
    const mime = input.mime.trim() || "application/octet-stream";
    let text: string;
    try {
      text = await this.extractor(input.bytes, mime, name);
    } catch (error) {
      if (error instanceof UnsupportedDocumentError) throw error;
      throw new UnsupportedDocumentError("I couldn't read that document — it may be corrupted or password-protected.");
    }
    text = text.replace(/\r\n/g, "\n").trim();
    if (!text) throw new UnsupportedDocumentError("That document has no readable text — it may be a scan or an image-only PDF.");
    if (text.length > MAX_DOCUMENT_TEXT) text = `${text.slice(0, MAX_DOCUMENT_TEXT)}\n\n[The document was cut off after ${MAX_DOCUMENT_TEXT} characters.]`;
    return this.repo.create({ name, mime_type: mime, size: input.bytes.byteLength, text });
  }

  get(id: string): StoredDocument | null {
    return this.repo.get(id);
  }
}
