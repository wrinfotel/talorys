import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { WebSearchStatus } from "@talorys/shared";
import { Trash2 } from "lucide-react";
import { Badge, Button, Card, ErrorNotice, Input } from "./ui";
import { useApiMutation } from "../hooks/queries";
import { api } from "../lib/api";

const KEY = ["web-search"] as const;

/** Settings card for the web_search backend: an optional Tavily key over the built-in Bing results. */
export function WebSearchCard() {
  const status = useQuery({ queryKey: KEY, queryFn: () => api<WebSearchStatus>("/web-search") });
  const s = status.data;
  const qc = useQueryClient();
  const [key, setKey] = useState("");

  const save = useApiMutation(
    (apiKey: string) => api<WebSearchStatus>("/web-search", { method: "PUT", body: { api_key: apiKey } }),
    {
      success: "Tavily key saved — web search now uses Tavily",
      onSuccess: (r) => {
        qc.setQueryData(KEY, r);
        setKey("");
      },
    },
  );
  const remove = useApiMutation(() => api<WebSearchStatus>("/web-search", { method: "DELETE" }), {
    success: "Tavily key removed — using the built-in search",
    onSuccess: (r) => qc.setQueryData(KEY, r),
  });

  return (
    <section className="space-y-2">
      <h2 className="px-1 text-xs font-medium uppercase tracking-wider text-fg-subtle">Web search</h2>
      <Card>
        <div className="divide-y divide-border">
          {status.error && (
            <div className="px-5 py-4">
              <ErrorNotice error={status.error} onRetry={() => void status.refetch()} />
            </div>
          )}
          <div className="flex items-center justify-between gap-3 px-5 py-4">
            <div className="min-w-0">
              <p className="text-sm font-medium">Search backend</p>
              <p className="mt-0.5 text-xs leading-5 text-fg-subtle">
                {s?.has_api_key
                  ? "Tavily (agent-grade results, free tier 1,000 searches/month)."
                  : "Built-in Bing results. Add a free Tavily key for cleaner, more relevant results."}
              </p>
            </div>
            <Badge>{s?.has_api_key ? "Tavily" : "Built-in"}</Badge>
          </div>
          <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
            <Input
              type="password"
              className="w-full"
              placeholder="Tavily API key (tvly-…)"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              autoComplete="off"
            />
            <div className="flex shrink-0 gap-2">
              <Button type="button" disabled={key.trim().length < 16 || save.isPending} onClick={() => save.mutate(key.trim())}>
                Save
              </Button>
              {s?.has_api_key && (
                <Button type="button" variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate()}>
                  <Trash2 className="size-4" /> Remove
                </Button>
              )}
            </div>
          </div>
        </div>
      </Card>
    </section>
  );
}
