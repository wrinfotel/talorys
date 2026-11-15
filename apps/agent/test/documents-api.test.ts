import { beforeEach, describe, expect, it } from "vitest";
import { defaultExtractor } from "../src/services/documents";
import { client, inAgent, loggedIn } from "./helpers";

beforeEach(async () => {
  await inAgent((agent) => {
    agent.services.db.run(`DELETE FROM tal_documents`);
    agent.services.documents.extractor = defaultExtractor;
  });
});

const errorBody = async (res: Response) => (await res.json()) as { error: { code: string; message: string } };

describe("documents api", () => {
  it("requires a session", async () => {
    const c = client();
    const res = await c.call("/api/documents", { method: "POST", body: { name: "a.txt", mime: "text/plain", data_base64: btoa("x") } });
    expect(res.status).toBe(401);
  });

  it("uploads a text document and answers a reference", async () => {
    const c = await loggedIn();
    const res = await c.call("/api/documents", { method: "POST", body: { name: "notes.txt", mime: "text/plain", data_base64: btoa("hello world") } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; name: string; chars: number };
    expect(body).toMatchObject({ name: "notes.txt", chars: 11 });
    expect(body.id).toEqual(expect.any(String));
  });

  it("rejects an unsupported kind with a clear message", async () => {
    const c = await loggedIn();
    const res = await c.call("/api/documents", { method: "POST", body: { name: "prog.exe", mime: "application/octet-stream", data_base64: btoa("MZ") } });
    expect(res.status).toBe(400);
    const body = await errorBody(res);
    expect(body.error.message).toContain("Only PDF and plain-text");
  });

  it("rejects a payload over the schema cap before touching storage", async () => {
    const c = await loggedIn();
    const res = await c.call("/api/documents", { method: "POST", body: { name: "big.txt", mime: "text/plain", data_base64: "A".repeat(18_000_000) } });
    expect(res.status).toBe(400);
  });
});
