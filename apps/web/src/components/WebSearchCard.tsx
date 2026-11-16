import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { WebSearchStatus } from "@talorys/shared";
import { Trash2 } from "lucide-react";
import { Badge, Button, Card, ErrorNotice, Input } from "./ui";
import { useApiMutation } from "../hooks/queries";
import { api } from "../lib/api";

const KEY = ["web-search"] as const;

const STATUS_TEXT: Record<WebSearchStatus["provider"], string> = {
  tavily: "Tavily first (agent-grade results, free tier 1,000 searches/month), then the free ring: Exa → Parallel → Firecrawl → Bing.",
  keenable: "Keenable first (100,000 searches/month with the free key), then the free ring: Exa → Parallel → Firecrawl → Bing.",
  keyless: "Free keyless ring: Exa → Parallel → Firecrawl → Bing. Add an API key below to put that provider first.",
};

/** Settings card for the web_search providers: optional Tavily and Keenable keys over the keyless ring. */
export function WebSearchCard() {
  const status = useQuery({ queryKey: KEY, queryFn: () => api<WebSearchStatus>("/web-search") });
  const s = status.data;
  const qc = useQueryClient();
  const [tavilyKey, setTavilyKey] = useState("");
  const [keenableKey, setKeenableKey] = useState("");

  const save = useApiMutation(
    (input: { provider: "tavily" | "keenable"; api_key: string }) => api<WebSearchStatus>("/web-search", { method: "PUT", body: input }),
    {
      success: "API key saved — web search updated",
      onSuccess: (r) => {
        qc.setQueryData(KEY, r);
        setTavilyKey("");
        setKeenableKey("");
      },
    },
  );
  const remove = useApiMutation((provider: "tavily" | "keenable") => api<WebSearchStatus>(`/web-search/${provider}`, { method: "DELETE" }), {
    success: "API key removed — web search updated",
    onSuccess: (r) => qc.setQueryData(KEY, r),
  });

  const keyRow = (provider: "tavily" | "keenable", placeholder: string, hasKey: boolean, value: string, setValue: (v: string) => void) => (
    <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
      <Input
        type="password"
        className="w-full"
        placeholder={placeholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        autoComplete="off"
      />
      <div className="flex shrink-0 gap-2">
        <Button type="button" disabled={value.trim().length < 16 || save.isPending} onClick={() => save.mutate({ provider, api_key: value.trim() })}>
          Save
        </Button>
        {hasKey && (
          <Button type="button" variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate(provider)}>
            <Trash2 className="size-4" /> Remove
          </Button>
        )}
      </div>
    </div>
  );

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
              <p className="text-sm font-medium">Search providers</p>
              <p className="mt-0.5 text-xs leading-5 text-fg-subtle">{s ? STATUS_TEXT[s.provider] : ""}</p>
            </div>
            <Badge>{s?.provider === "keyless" ? "Keyless ring" : s?.provider === "tavily" ? "Tavily" : s?.provider === "keenable" ? "Keenable" : "…"}</Badge>
          </div>
          {keyRow("tavily", "Tavily API key (tvly-…) — optional", s?.has_tavily_key ?? false, tavilyKey, setTavilyKey)}
          {keyRow("keenable", "Keenable API key — optional, free 100k requests/month", s?.has_keenable_key ?? false, keenableKey, setKeenableKey)}
        </div>
      </Card>
    </section>
  );
}
