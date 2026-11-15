// Channels: every channel with where its members come from, how long its messages are kept and its guests. The file's
// channels show their entry and change in the file; channels people or products made are set here by an admin. Legal
// requests are exported from here, with a hold that keeps the messages past their retention.
import {
  Badge,
  Button,
  Checkbox,
  DataTable,
  Dialog,
  KpiCard,
  KpiGrid,
  PageHeader,
  Panel,
  SelectField,
  Switch,
  TextField,
  cn,
  navigate,
  useLocalePreference,
  type Column,
} from "@openasy/ui";
import { FileDown, Hash, Lock, Plus, Users } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import type { Ctx } from "./App.tsx";
import type { AdminChannel, Channels, Export, FileEntry, Person } from "./api.ts";
import { bytes, Code, enc, KindIcon, longDay, Notice, num, patch, post, useLoad, when, type Note } from "./common.tsx";
import { retentionLabel, useT, type T } from "./i18n.ts";

const CHOICES = ["forever", "2y", "1y", "90d", "30d"];
const daysOf = (r: string) => {
  if (r === "forever") return Infinity;
  const m = /^(\d+)([dwmy])$/.exec(r);
  return m ? Number(m[1]) * { d: 1, w: 7, m: 30, y: 365 }[m[2] as "d"] : Infinity;
};

function yaml(e: FileEntry) {
  return [
    `- name: ${e.name}`,
    ...(e.topic ? [`  topic: ${e.topic}`] : []),
    `  private: ${e.private}`,
    `  members: ${e.members.length ? `[${e.members.join(", ")}]` : "by-hand"}`,
    ...(e.admins.length ? [`  admins: [${e.admins.join(", ")}]`] : []),
    `  retention: ${e.retention}`,
    `  guests: ${e.guests}`,
    `  posts: ${e.posts}`,
  ].join("\n");
}

const kindLabel = (k: AdminChannel["kind"], t: T) => t(`kind.${k}`);
const managedLabel = (c: AdminChannel, t: T) =>
  c.managedBy === "file" ? "chat.yaml" : c.managedBy === "api" ? (c.by ?? t("channels.byApp")) : t("channels.byMembers");

function LegalExportDialog({
  ctx,
  channels,
  open,
  onOpenChange,
  onStarted,
}: {
  ctx: Ctx;
  channels: AdminChannel[];
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onStarted: (e: Export) => void;
}) {
  const t = useT();
  const [ref, setRef] = useState("");
  const [channel, setChannel] = useState("");
  const [from, setFrom] = useState(() => new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10));
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [sender, setSender] = useState("");
  const [hold, setHold] = useState(true);
  const [people, setPeople] = useState<Person[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open)
      void ctx.call<{ people: Person[] }>("/api/v1/people").then(
        (r) => setPeople(r.people),
        () => {},
      );
  }, [open, ctx]);
  const chosen = channel || channels[0]?.id || "";
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ref.trim()) return;
    setError(null);
    try {
      const r = await ctx.call<Export>(
        "/api/v1/exports",
        post({ reference: ref.trim(), channel: chosen, from, to, ...(sender && { senders: [sender] }), hold }),
      );
      setRef("");
      onStarted(r);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("legal.title")}
      description={t("legal.description")}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t("cancel")}</Button>
          <Button type="submit" variant="primary" icon={<FileDown />}>
            {t("legal.start")}
          </Button>
        </>
      }
    >
      <TextField label={t("legal.reference")} value={ref} onChange={(e) => setRef(e.target.value)} placeholder="LR-2026-08" />
      <SelectField
        label={t("legal.channel")}
        value={chosen}
        onChange={(e) => setChannel(e.target.value)}
        options={channels.map((c) => ({ value: c.id, label: `#${c.name}` }))}
      />
      <div className="grid grid-cols-2 gap-2">
        <TextField label={t("legal.from")} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <TextField label={t("legal.to")} type="date" value={to} onChange={(e) => setTo(e.target.value)} />
      </div>
      <SelectField
        label={t("legal.only")}
        value={sender}
        onChange={(e) => setSender(e.target.value)}
        options={[{ value: "", label: t("legal.anyone") }, ...people.map((p) => ({ value: p.userId, label: p.name }))]}
      />
      <Checkbox label={t("legal.hold")} description={t("legal.holdDetail")} checked={hold} onChange={(e) => setHold(e.target.checked)} />
      {error && <Notice tone="danger">{error}</Notice>}
    </Dialog>
  );
}

function NewChannelDialog({ ctx, open, onOpenChange }: { ctx: Ctx; open: boolean; onOpenChange: (o: boolean) => void }) {
  const t = useT();
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [priv, setPriv] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const r = await ctx.call<{ id: string }>("/api/v1/channels", post({ name, ...(topic && { topic }), private: priv }));
      navigate(`/messages/${enc(r.id)}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("browse.new")}
      description={t("channels.newDetail")}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t("cancel")}</Button>
          <Button type="submit" variant="primary" icon={<Plus />} disabled={!name}>
            {t("browse.create")}
          </Button>
        </>
      }
    >
      <TextField
        label={t("browse.name")}
        value={name}
        onChange={(e) => setName(e.target.value.toLowerCase().replace(/\s+/g, "-"))}
        placeholder="project-atlas"
      />
      <TextField label={t("browse.topic")} value={topic} onChange={(e) => setTopic(e.target.value)} />
      <Switch checked={priv} onCheckedChange={setPriv} label={t("browse.private")} description={t("browse.privateDetail")} />
      {error && <Notice tone="danger">{error}</Notice>}
    </Dialog>
  );
}

function Settings({ ctx, c, onSaved }: { ctx: Ctx; c: AdminChannel; onSaved: (c: AdminChannel, note: string) => void }) {
  const t = useT();
  const [retention, setRetention] = useState(c.retention);
  const [posts, setPosts] = useState(c.posts);
  const [guests, setGuests] = useState(c.guests);
  const [error, setError] = useState<string | null>(null);
  const fromFile = c.managedBy === "file";
  const locked = fromFile || !ctx.admin;
  const shorter = daysOf(retention) < daysOf(c.retention);
  const changed = retention !== c.retention || posts !== c.posts || guests !== c.guests;
  const save = async () => {
    setError(null);
    try {
      const r = await ctx.call<AdminChannel>(`/api/v1/channels/${enc(c.id)}`, patch({ retention, posts, guests }));
      onSaved(r, t("channels.saved", { name: c.name }));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const options = [...new Set([...CHOICES, c.retention])].map((r) => ({ value: r, label: retentionLabel(r, t) }));
  return (
    <Panel
      aria-label={t("channels.settings")}
      title={`#${c.name}`}
      description={`${kindLabel(c.kind, t)} · ${t("channels.membersFrom", { count: c.members, from: c.from })}`}
    >
      <div className="flex flex-col gap-3">
        <SelectField label={t("channels.keep")} value={retention} disabled={locked} onChange={(e) => setRetention(e.target.value)} options={options} />
        {shorter && (
          <p role="status" className="rounded-md bg-warning-soft px-2.5 py-2 text-xs text-fg">
            {t("channels.deletes", { period: retentionLabel(retention, t) })}
          </p>
        )}
        {c.hold && <p className="rounded-md bg-accent-soft px-2.5 py-2 text-xs text-fg">{t("info.hold", { reference: c.hold })}</p>}
        <SelectField
          label={t("channels.posts")}
          value={posts}
          disabled={locked}
          onChange={(e) => setPosts(e.target.value as AdminChannel["posts"])}
          options={[
            { value: "everyone", label: t("channels.postsEveryone") },
            { value: "admins", label: t("channels.postsAdmins") },
          ]}
        />
        <Switch checked={guests} disabled={locked} onCheckedChange={setGuests} label={t("channels.guests")} description={t("channels.guestsDetail")} />
        {c.encrypted && <p className="rounded-md bg-subtle px-2.5 py-2 text-xs text-fg">{t("channels.encrypted")}</p>}
        {!locked && (
          <Button variant="primary" className="self-start" disabled={!changed} onClick={() => void save()}>
            {t("save")}
          </Button>
        )}
        {error && <Notice tone="danger">{error}</Notice>}
        {fromFile && c.entry ? (
          <section className="flex flex-col gap-1.5 border-t border-line pt-3">
            <h3 className="text-xs font-semibold text-fg-muted">{t("channels.inFile")}</h3>
            <Code label={t("channels.entry")}>{yaml(c.entry)}</Code>
            <p className="text-2xs text-fg-muted">{t("channels.inFileDetail")}</p>
          </section>
        ) : (
          <p className="border-t border-line pt-3 text-xs text-fg-muted">
            {c.managedBy === "api" ? t("channels.byProduct", { by: c.by ?? "" }) : t("channels.madeByMembers")}
          </p>
        )}
      </div>
    </Panel>
  );
}

export function ChannelsPage({ ctx }: { ctx: Ctx }) {
  const t = useT();
  const [locale] = useLocalePreference();
  const [data, reload] = useLoad<Channels>(ctx.call, "/api/v1/channels");
  const [exportsData, reloadExports] = useLoad<{ exports: Export[] }>(ctx.call, ctx.admin ? "/api/v1/exports" : null);
  const [active, setActive] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [making, setMaking] = useState(false);
  const [note, setNote] = useState<Note>(null);
  useEffect(() => {
    if (!exportsData?.exports.some((e) => e.state === "running")) return;
    const timer = setTimeout(reloadExports, 2000);
    return () => clearTimeout(timer);
  }, [exportsData, reloadExports]);
  if (data === undefined) return <PageHeader title={t("channels.title")} description={t("loading")} />;
  const rows = data?.channels ?? [];
  const totals = data?.totals;
  const cur = rows.find((r) => r.id === active) ?? rows.find((r) => r.managedBy === "file") ?? rows[0];
  const release = async (e: Export) => {
    try {
      await ctx.call(`/api/v1/holds/${enc(e.hold!.id)}/release`, post());
      setNote({ text: t("legal.released", { reference: e.reference }) });
      reload();
      reloadExports();
    } catch (err) {
      setNote({ text: (err as Error).message, tone: "danger" });
    }
  };
  const cols: Column<AdminChannel>[] = [
    {
      id: "name",
      header: t("channels.channel"),
      width: "30%",
      sortValue: (c) => c.name,
      cell: (c) => (
        <span className="flex min-w-0 items-center gap-1.5">
          <KindIcon kind={c.kind} className="text-fg-muted" />
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-medium">{c.name}</span>
            {c.topic && <span className="truncate text-2xs text-fg-muted">{c.topic}</span>}
          </span>
        </span>
      ),
    },
    {
      id: "kind",
      header: t("channels.type"),
      cell: (c) => <Badge tone={c.kind === "guests" ? "warning" : c.kind === "incident" ? "danger" : "neutral"}>{kindLabel(c.kind, t)}</Badge>,
    },
    {
      id: "members",
      header: t("channels.members"),
      sortValue: (c) => c.members,
      cell: (c) => (
        <span className="flex min-w-0 flex-col text-xs">
          <span className="tabular-nums">{num(c.members, locale)}</span>
          <span className="truncate text-2xs text-fg-muted">{c.from}</span>
        </span>
      ),
    },
    {
      id: "retention",
      header: t("channels.keptFor"),
      cell: (c) => (
        <span className="flex flex-wrap items-center gap-1 text-xs">
          {retentionLabel(c.retention, t)}
          {c.hold && <Badge tone="info">{t("channels.legalHold")}</Badge>}
        </span>
      ),
    },
    {
      id: "managed",
      header: t("channels.setIn"),
      cell: (c) => <span className={cn("text-xs", c.managedBy === "file" && "font-mono")}>{managedLabel(c, t)}</span>,
    },
  ];
  const stored = totals && totals.files !== null ? totals.files + (totals.messages ?? 0) : null;
  return (
    <>
      <PageHeader
        title={t("channels.title")}
        description={t("channels.description")}
        actions={
          <>
            {ctx.admin && (
              <Button icon={<FileDown />} onClick={() => setExporting(true)}>
                {t("legal.title")}
              </Button>
            )}
            <Button variant="primary" icon={<Plus />} onClick={() => setMaking(true)}>
              {t("browse.new")}
            </Button>
          </>
        }
      />
      {note && <Notice tone={note.tone}>{note.text}</Notice>}
      {totals && (
        <KpiGrid minWidth={170}>
          <KpiCard
            label={t("channels.title")}
            value={num(totals.channels, locale)}
            icon={Hash}
            delta={{ label: t("channels.fromFile", { count: totals.fromFile }), intent: "neutral" }}
          />
          <KpiCard label={t("kind.private")} value={num(totals.private, locale)} icon={Lock} />
          <KpiCard
            label={t("kind.guests")}
            value={num(totals.withGuests, locale)}
            icon={Users}
            delta={{ label: t("channels.guestsCount", { count: totals.guests }), intent: "neutral" }}
          />
          <KpiCard
            label={t("channels.stored")}
            value={stored === null ? "–" : bytes(stored, locale)}
            delta={{
              label:
                totals.files === null
                  ? t("channels.storedUnknown")
                  : totals.messages === null
                    ? t("channels.storedFiles", { files: bytes(totals.files, locale) })
                    : t("channels.storedBoth", { files: bytes(totals.files, locale), messages: bytes(totals.messages, locale) }),
              intent: "neutral",
            }}
          />
        </KpiGrid>
      )}
      <div className="chat-side-wide grid gap-2.5">
        <Panel title={t("channels.all")} flush>
          <DataTable
            label={t("channels.title")}
            columns={cols}
            rows={rows}
            getRowId={(c) => c.id}
            onRowClick={(c) => setActive(c.id)}
            activeRowId={cur?.id}
            minWidth={680}
          />
        </Panel>
        {cur && (
          <Settings
            key={`${cur.id}:${cur.retention}:${cur.posts}:${cur.guests}`}
            ctx={ctx}
            c={cur}
            onSaved={(_c, text) => {
              setNote({ text });
              reload();
            }}
          />
        )}
      </div>
      {ctx.admin && exportsData && exportsData.exports.length > 0 && (
        <Panel title={t("legal.list")} className="mt-2.5" flush>
          <ul aria-label={t("legal.list")} className="chat-list flex flex-col">
            {exportsData.exports.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-2 border-b border-subtle px-3 py-2 text-xs last:border-0">
                <span className="font-semibold text-fg">{e.reference}</span>
                <span className="text-fg-muted">
                  #{e.channel}, {longDay(e.from, locale)} – {longDay(e.to, locale)}
                </span>
                <Badge tone={e.state === "ready" ? "success" : e.state === "failed" ? "danger" : "info"}>{t(`legal.state.${e.state}`)}</Badge>
                {e.state === "ready" && (
                  <span className="text-fg-muted">
                    {t("legal.counts", { messages: num(e.messages, locale), files: num(e.files, locale), size: bytes(e.bytes, locale) })}
                  </span>
                )}
                {e.error && <span className="text-danger-text">{e.error}</span>}
                <span className="text-fg-subtle">{t("legal.by", { who: e.startedBy, when: when(e.startedAt, locale) })}</span>
                <span className="grow" />
                {e.hold && !e.hold.released && (
                  <Button size="xs" onClick={() => void release(e)}>
                    {t("legal.release")}
                  </Button>
                )}
                {e.state === "ready" && (
                  <a href={`/api/v1/exports/${enc(e.id)}/archive`} className="font-medium text-accent-text">
                    {t("legal.download")}
                  </a>
                )}
              </li>
            ))}
          </ul>
        </Panel>
      )}
      <LegalExportDialog
        ctx={ctx}
        channels={rows}
        open={exporting}
        onOpenChange={setExporting}
        onStarted={(e) => {
          setExporting(false);
          setActive(e.roomId);
          setNote({
            text: t(e.hold ? "legal.startedHold" : "legal.started", {
              reference: e.reference,
              channel: e.channel,
              from: longDay(e.from, locale),
              to: longDay(e.to, locale),
            }),
          });
          reload();
          reloadExports();
        }}
      />
      <NewChannelDialog ctx={ctx} open={making} onOpenChange={setMaking} />
    </>
  );
}
