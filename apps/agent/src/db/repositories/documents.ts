import type { Database } from "../database";

/** A document attached to a chat turn; only its extracted text is stored, never the bytes. */
export interface StoredDocument {
  id: string;
  name: string;
  mime_type: string;
  size: number;
  chars: number;
  text: string;
  created_at: string;
}

/** Keeps documents for 30 days, like pending actions: they serve their turn, then go. */
const RETENTION_DAYS = 30;

export class DocumentRepository {
  constructor(private readonly db: Database) {}

  create(input: { name: string; mime_type: string; size: number; text: string }): StoredDocument {
    const document: StoredDocument = {
      id: crypto.randomUUID(),
      name: input.name,
      mime_type: input.mime_type,
      size: input.size,
      chars: input.text.length,
      text: input.text,
      created_at: new Date().toISOString(),
    };
    this.db.run(
      `INSERT INTO tal_documents (id, name, mime_type, size, chars, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      document.id,
      document.name,
      document.mime_type,
      document.size,
      document.chars,
      document.text,
      document.created_at,
    );
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    this.db.run(`DELETE FROM tal_documents WHERE created_at < ?`, cutoff);
    return document;
  }

  get(id: string): StoredDocument | null {
    return this.db.one<StoredDocument>(`SELECT * FROM tal_documents WHERE id = ?`, id) ?? null;
  }
}
