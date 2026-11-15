// Integrations (the Matrix server and its apps, Identity, the apps' webhooks, and what other products call) and the
// read-only settings file.
import { Badge, Button, Callout, PageHeader, Panel, StatusBadge, useLocalePreference } from "@openasy/ui";
import { useState } from "react";
import type { Ctx } from "./App.tsx";
import type { Config, Integrations, SyncResult } from "./api.ts";
import { Code, enc, Notice, post, useLoad, when, type Note } from "./common.tsx";
import { FileSettingsPage } from "./FileSettings.tsx";
import { retentionLabel, useT } from "./i18n.ts";

export function IntegrationsPage({ ctx }: { ctx: Ctx }) {
  const t = useT();
  const [locale] = useLocalePreference();
  const [data, reload] = useLoad<Integrations>(ctx.call, "/api/v1/integrations");
  const [hook, setHook] = useState<{ app: string; url: string } | null>(null);
  const [note, setNote] = useState<Note>(null);
  const origin = window.location.origin;
  if (data === undefined) return <PageHeader title={t("integrations.title")} description={t("loading")} />;
  const make = async (app: string) => {
    try {
      setHook(await ctx.call<{ app: string; url: string }>(`/api/v1/apps/${enc(app)}/hook`, post()));
      reload();
    } catch (err) {
      setNote({ text: (err as Error).message, tone: "danger" });
    }
  };
  return (
    <>
      <PageHeader title={t("integrations.title")} description={t("integrations.description")} />
      {note && <Notice tone={note.tone}>{note.text}</Notice>}
      <div className="chat-halves grid gap-2.5">
        <Panel
          title={t("integrations.matrix")}
          description={t("integrations.matrixDetail")}
          actions={<StatusBadge tone={data?.matrix.ok ? "success" : "danger"}>{data?.matrix.ok ? t("integrations.ok") : t("integrations.down")}</StatusBadge>}
        >
          {data && (
            <dl className="chat-settings-list grid gap-x-3 gap-y-2 text-xs">
              <dt className="text-fg-muted">{t("integrations.homeserver")}</dt>
              <dd className="m-0 font-mono text-fg">{data.matrix.homeserver}</dd>
              <dt className="text-fg-muted">{t("integrations.serverName")}</dt>
              <dd className="m-0 font-mono text-fg">{data.matrix.serverName ?? "–"}</dd>
              <dt className="text-fg-muted">{t("integrations.version")}</dt>
              <dd className="m-0 font-mono text-fg">{data.matrix.version ?? "–"}</dd>
              <dt className="text-fg-muted">{t("integrations.service")}</dt>
              <dd className="m-0 font-mono text-fg">{data.matrix.user ?? "–"}</dd>
            </dl>
          )}
          <p className="mt-2 text-xs text-fg-muted">{t("integrations.element", { homeserver: data?.matrix.homeserver ?? "" })}</p>
        </Panel>
        <Panel
          title="Identity"
          description={t("integrations.identity")}
          actions={
            <StatusBadge tone={!data?.identity.configured ? "neutral" : data.identity.ok ? "success" : data.identity.at ? "danger" : "warning"}>
              {!data?.identity.configured
                ? t("integrations.off")
                : data.identity.ok
                  ? t("integrations.ok")
                  : data.identity.at
                    ? t("integrations.failing")
                    : t("integrations.waiting")}
            </StatusBadge>
          }
        >
          {data?.identity.configured ? (
            <div className="flex flex-col gap-1 text-xs text-fg-muted">
              <span>{t("integrations.people", { count: data.identity.people })}</span>
              {data.identity.at && <span>{t("integrations.okAt", { when: when(data.identity.at, locale) })}</span>}
              {data.identity.error && <span className="text-danger-text">{data.identity.error}</span>}
            </div>
          ) : (
            <Code label="Identity">{`CHAT_IDENTITY_URL=https://login.example.com
CHAT_IDENTITY_TOKEN_FILE=/run/secrets/identity-token   # an Identity token with the viewer role`}</Code>
          )}
        </Panel>
        <Panel title={t("integrations.apps")} description={t("integrations.appsDetail")} className="chat-span2">
          {hook && (
            <div className="mb-2 flex flex-col gap-1.5">
              <Notice>{t("integrations.hookMade", { app: hook.app })}</Notice>
              <Code label={t("integrations.hookUrl")}>{hook.url}</Code>
            </div>
          )}
          {data?.apps.length ? (
            <ul aria-label={t("integrations.apps")} className="chat-list flex flex-col gap-2">
              {data.apps.map((a) => (
                <li key={a.name} className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-sm font-semibold text-fg">{a.name}</span>
                  <Badge>{t("message.app")}</Badge>
                  <span className="text-fg-muted">{a.channels.map((c) => `#${c}`).join(", ")}</span>
                  <span className="text-fg-subtle">
                    {a.hook
                      ? a.hook.usedAt
                        ? t("integrations.usedAt", { when: when(a.hook.usedAt, locale) })
                        : t("integrations.notUsed")
                      : t("integrations.noHook")}
                  </span>
                  <span className="grow" />
                  {ctx.admin && (
                    <Button size="xs" onClick={() => void make(a.name)}>
                      {a.hook ? t("integrations.newHook") : t("integrations.makeHook")}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <Code label={t("integrations.apps")}>{`apps:
  - name: Alerts
    channels: [ops-oncall]`}</Code>
          )}
          <Code label={t("integrations.post")}>{`curl -X POST <webhook address> -H 'content-type: application/json' -d '{
  "channel": "ops-oncall",
  "text": "@here p95 latency on api-prod-03 above 2 s",
  "card": { "title": "API latency high", "severity": "high",
            "fields": [["Host", "api-prod-03"]], "link": { "label": "Open in Alerts", "url": "https://alerts.example.com/a/1" } }
}'`}</Code>
        </Panel>
        <Panel title="Incidents" description={t("integrations.incidents")}>
          <Code label="Incidents">{`POST ${origin}/api/v1/channels
Authorization: Bearer <a Chat token with the editor role>
{ "name": "inc-2041-api-latency", "kind": "incident", "reference": "INC-2041",
  "members": ["ben@example.com"] }`}</Code>
          <a href="/api/docs/" className="mt-2 block text-xs">
            {t("integrations.reference")}
          </a>
        </Panel>
        <Panel
          title="Meet"
          description={t("integrations.meet")}
          actions={<StatusBadge tone={ctx.meetUrl ? "success" : "neutral"}>{ctx.meetUrl ? t("integrations.ok") : t("integrations.off")}</StatusBadge>}
        >
          <Code label="Meet">{ctx.meetUrl ?? "OPENASY_PRODUCTS=meet=https://meet.example.com,..."}</Code>
        </Panel>
      </div>
    </>
  );
}

export function SettingsFilePage({ ctx }: { ctx: Ctx }) {
  const t = useT();
  const [locale] = useLocalePreference();
  const [config] = useLoad<Config>(ctx.call, "/api/v1/config");
  const [sync, reloadSync] = useLoad<{ last: SyncResult | null }>(ctx.call, "/api/v1/sync");
  const [busy, setBusy] = useState(false);
  if (!config) return <PageHeader title={t("settings.title")} description={t("loading")} />;
  const file = config.file;
  const last = sync?.last;
  const problems = (
    <>
      {file?.error && (
        <Callout tone="danger" title={t("file.notApplied")} className="mb-2.5">
          {file.error}
        </Callout>
      )}
      {last && !last.ok && (
        <Callout tone="danger" title={t("settings.syncFailed")} className="mb-2.5">
          {last.error}
        </Callout>
      )}
      {last && last.warnings.length > 0 && (
        <Callout tone="warning" title={t("settings.warnings")} className="mb-2.5">
          <ul className="flex list-disc flex-col gap-0.5 pl-4">
            {last.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Callout>
      )}
      {ctx.admin && (
        <div className="mb-2.5 flex items-center gap-2 text-xs text-fg-muted">
          <Button
            size="sm"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void ctx.call("/api/v1/sync", post()).finally(() => (setBusy(false), reloadSync()));
            }}
          >
            {t("settings.syncNow")}
          </Button>
          {last && t("settings.lastSync", { when: when(last.at, locale) })}
        </div>
      )}
    </>
  );
  return (
    <FileSettingsPage
      file="chat.yaml"
      applied={file?.appliedAt ? when(file.appliedAt, locale) : t("settings.never")}
      yaml={file?.text || t("settings.empty")}
      problems={problems}
      groups={[
        {
          title: t("settings.channels"),
          description: t("settings.channelsDetail"),
          items: config.channels.map((c, i) => ({
            label: `#${c.name}`,
            path: `channels[${i}]`,
            value: [
              c.private ? t("kind.private") : t("kind.public"),
              c.members.length ? c.members.join(", ") : t("settings.byChoice"),
              retentionLabel(c.retention, t),
              c.guests ? t("settings.guestsOn") : null,
              c.posts === "admins" ? t("channels.postsAdmins") : null,
            ]
              .filter(Boolean)
              .join(" · "),
          })),
        },
        {
          title: t("settings.rules"),
          items: [
            { label: t("settings.defaultRetention"), path: "defaults.retention", value: retentionLabel(config.defaults.retention, t) },
            { label: t("settings.guestDays"), path: "guests.days", value: t("settings.days", { count: config.guests.days }) },
          ],
        },
        {
          title: t("integrations.apps"),
          items: config.apps.map((a, i) => ({ label: a.name, path: `apps[${i}]`, value: a.channels.map((c) => `#${c}`).join(", ") })),
        },
      ]}
    />
  );
}
