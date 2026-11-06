import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { TelegramStatus } from "@talorys/shared";
import { Badge, Button, Card, ConfirmDialog, ErrorNotice, Input, Label, Switch } from "./ui";
import { useApiMutation } from "../hooks/queries";
import { api } from "../lib/api";
import { relativeTime } from "../lib/utils";
import { useI18n } from "../lib/i18n";

const KEY = ["telegram"] as const;

function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {hint && <div className="mt-0.5 text-xs leading-5 text-fg-subtle">{hint}</div>}
      </div>
      {children && <div className="shrink-0">{children}</div>}
    </div>
  );
}

/** Settings → Integrations: the owner's Telegram bot — chat with the agent and get notifications there. */
export function TelegramCard() {
  const { t } = useI18n();
  const status = useQuery({ queryKey: KEY, queryFn: () => api<TelegramStatus>("/telegram/status") });
  const s = status.data;
  return (
    <section className="space-y-2">
      <h2 className="px-1 text-xs font-medium uppercase tracking-wider text-fg-subtle">{t("telegram.heading")}</h2>
      <Card>
        <div className="divide-y divide-border">
          {status.error ? (
            <div className="px-5 py-4">
              <ErrorNotice error={status.error} onRetry={() => void status.refetch()} />
            </div>
          ) : !s ? null : (
            <Row label={t("telegram.description")} />
          )}
          {!s ? null : !s.connected ? <ConnectForm /> : <Controls status={s} />}
        </div>
      </Card>
    </section>
  );
}

/** The bot is not connected: token and webhook base URL, then connect. */
function ConnectForm() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [token, setToken] = useState("");
  const [baseUrl, setBaseUrl] = useState(() => window.location.origin);
  const connect = useApiMutation(
    (input: { token: string; webhook_base_url: string }) => api<TelegramStatus>("/telegram/config", { method: "PUT", body: input }),
    {
      success: t("telegram.connectSuccess"),
      onSuccess: (s) => qc.setQueryData(KEY, s),
    },
  );
  const ready = token.trim() && baseUrl.trim();
  return (
    <form
      className="space-y-3 bg-subtle px-5 py-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) connect.mutate({ token: token.trim(), webhook_base_url: baseUrl.trim() });
      }}
    >
      <div>
        <Label htmlFor="telegram-token" hint={t("telegram.tokenHint")}>
          {t("telegram.token")}
        </Label>
        <Input id="telegram-token" type="password" autoComplete="off" value={token} maxLength={256} placeholder="123456:AA…" onChange={(e) => setToken(e.target.value)} />
      </div>
      <div>
        <Label htmlFor="telegram-base-url" hint={t("telegram.baseUrlHint")}>
          {t("telegram.baseUrl")}
        </Label>
        <Input id="telegram-base-url" type="url" inputMode="url" value={baseUrl} maxLength={500} onChange={(e) => setBaseUrl(e.target.value)} />
      </div>
      <div className="flex justify-end">
        <Button type="submit" size="sm" loading={connect.isPending} disabled={!ready}>
          {t("telegram.connect")}
        </Button>
      </div>
    </form>
  );
}

/** The bot is connected: status, pairing (until linked), the notification toggle and disconnect. */
function Controls({ status: s }: { status: TelegramStatus }) {
  const i18n = useI18n();
  const { t } = i18n;
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const toggle = useApiMutation((notify_enabled: boolean) => api<TelegramStatus>("/telegram/config", { method: "PATCH", body: { notify_enabled } }), {
    onSuccess: (status) => qc.setQueryData(KEY, status),
  });
  const reissue = useApiMutation(() => api<{ code: string; expires_at: string }>("/telegram/pair", { method: "POST", body: {} }), {
    success: t("telegram.reissueSuccess"),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
  const disconnect = useApiMutation(() => api<TelegramStatus>("/telegram/config", { method: "DELETE" }), {
    success: t("telegram.disconnectSuccess"),
    onSuccess: (status) => {
      qc.setQueryData(KEY, status);
      setConfirming(false);
    },
  });
  return (
    <>
      <Row
        label={
          <span className="flex flex-wrap items-center gap-2">
            @{s.bot_username}
            <Badge tone={s.paired ? "success" : "warning"}>{s.paired ? t("telegram.statusPaired") : t("telegram.statusNotPaired")}</Badge>
          </span>
        }
        hint={s.notify_enabled ? t("telegram.notifyHint") : undefined}
      >
        <a href={`https://t.me/${s.bot_username}`} target="_blank" rel="noopener noreferrer" className="text-sm text-accent hover:underline">
          {t("telegram.open")}
        </a>
      </Row>
      {!s.paired && (
        <div className="space-y-3 bg-subtle px-5 py-4">
          <div className="text-sm font-medium">{t("telegram.pairingHeading")}</div>
          {s.pairing && (
            <>
              <p className="font-mono text-2xl tracking-[0.3em]">{s.pairing.code}</p>
              <p className="text-xs text-fg-subtle">{t("telegram.pairingExpires", { when: relativeTime(s.pairing.expires_at, i18n) })}</p>
            </>
          )}
          <p className="text-sm leading-5 text-fg-muted">{t("telegram.pairingInstruction")}</p>
          <div className="flex justify-end">
            <Button variant="outline" size="sm" loading={reissue.isPending} onClick={() => reissue.mutate(undefined)}>
              {t("telegram.reissue")}
            </Button>
          </div>
        </div>
      )}
      <Row label={t("telegram.notify")} hint={s.notify_enabled ? undefined : t("telegram.notifyHint")}>
        <Switch checked={s.notify_enabled === true} onChange={(on) => toggle.mutate(on)} label={t("telegram.notify")} disabled={toggle.isPending} />
      </Row>
      <div className="flex justify-end px-5 py-4">
        <Button variant="outline" size="sm" className="text-danger" onClick={() => setConfirming(true)}>
          {t("telegram.disconnect")}
        </Button>
      </div>
      <ConfirmDialog
        open={confirming}
        title={t("telegram.disconnectTitle")}
        message={t("telegram.disconnectMessage")}
        confirmLabel={t("telegram.disconnect")}
        onCancel={() => setConfirming(false)}
        onConfirm={() => disconnect.mutate(undefined)}
        loading={disconnect.isPending}
      />
    </>
  );
}
