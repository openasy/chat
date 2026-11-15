// People: who is in the company and who is a guest, their presence and local time, and what a guest can see. Members
// and groups come from Identity; presence, status and time zone are what people set in their Matrix apps.
import {
  Avatar,
  Badge,
  Button,
  Callout,
  DataTable,
  Dialog,
  PageHeader,
  Panel,
  SearchInput,
  SelectField,
  Tabs,
  TextField,
  navigate,
  useLocalePreference,
  type Column,
} from "@openasy/ui";
import { MessageSquare, Plus, Video } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import type { Ctx } from "./App.tsx";
import type { Conversation, People, Person } from "./api.ts";
import { Code, enc, localTime, longDay, Notice, post, PresenceDot, tzPlace, useLoad, type Note } from "./common.tsx";
import { useT, type T } from "./i18n.ts";

const presenceLabel = (p: Person, t: T) => t(`presence.${p.presence}`);

function InviteDialog({
  ctx,
  open,
  onOpenChange,
  onDone,
}: {
  ctx: Ctx;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDone: (link: string, name: string) => void;
}) {
  const t = useT();
  const [channels, setChannels] = useState<Conversation[]>([]);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [channel, setChannel] = useState("");
  const [days, setDays] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    void ctx.call<{ conversations: Conversation[] }>("/api/v1/conversations").then((r) => {
      const ok = r.conversations.filter((c) => c.guestsAllowed && !c.invited);
      setChannels(ok);
      setChannel((x) => x || ok[0]?.id || "");
    });
  }, [open, ctx]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const r = await ctx.call<{ link: string }>(
        "/api/v1/guests",
        post({ email, name, ...(company && { company }), channel, ...(days && { days: Number(days) }) }),
      );
      onDone(r.link, name);
      setEmail("");
      setName("");
      setCompany("");
      setDays("");
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("guests.invite")}
      description={t("guests.inviteDetail")}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t("cancel")}</Button>
          <Button type="submit" variant="primary" icon={<Plus />} disabled={!channel}>
            {t("guests.inviteButton")}
          </Button>
        </>
      }
    >
      {!channels.length && (
        <Callout tone="info" title={t("guests.noChannel")}>
          {t("guests.noChannelDetail")}
        </Callout>
      )}
      <TextField label={t("guests.email")} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <TextField label={t("guests.name")} value={name} onChange={(e) => setName(e.target.value)} />
      <TextField label={t("guests.company")} value={company} onChange={(e) => setCompany(e.target.value)} />
      <SelectField
        label={t("guests.channel")}
        value={channel}
        onChange={(e) => setChannel(e.target.value)}
        options={channels.map((c) => ({ value: c.id, label: `#${c.name}` }))}
      />
      <TextField label={t("guests.days")} type="number" min={1} value={days} onChange={(e) => setDays(e.target.value)} placeholder={t("guests.daysHint")} />
      {error && <Notice tone="danger">{error}</Notice>}
    </Dialog>
  );
}

export function PeoplePage({ ctx }: { ctx: Ctx }) {
  const t = useT();
  const [locale] = useLocalePreference();
  const [data, reload] = useLoad<People>(ctx.call, "/api/v1/people");
  const [tab, setTab] = useState<"all" | "members" | "guests">("all");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const [link, setLink] = useState<string | null>(null);
  if (data === undefined) return <PageHeader title={t("people.title")} description={t("loading")} />;
  const all = data?.people ?? [];
  const rows = all.filter(
    (p) =>
      (tab === "all" || (tab === "guests" ? !!p.guest : !p.guest)) &&
      `${p.name} ${p.email ?? ""} ${p.guest?.company ?? ""} ${p.groups.join(" ")}`.toLowerCase().includes(query.toLowerCase()),
  );
  const cur = all.find((p) => p.userId === active) ?? rows[0];
  const meet = ctx.meetUrl;
  const message = async (p: Person) => {
    const r = await ctx.call<{ id: string }>("/api/v1/conversations/direct", post({ people: [p.userId] }));
    navigate(`/messages/${enc(r.id)}`);
  };
  const end = async (p: Person) => {
    if (!p.guest || !window.confirm(t("guests.endConfirm", { name: p.name }))) return;
    try {
      await ctx.call(`/api/v1/guests/${enc(p.guest.id)}`, { method: "DELETE" });
      setNote({ text: t("guests.ended", { name: p.name }) });
      reload();
    } catch (err) {
      setNote({ text: (err as Error).message, tone: "danger" });
    }
  };
  const cols: Column<Person>[] = [
    {
      id: "name",
      header: t("people.name"),
      width: "26%",
      sortValue: (p) => p.name,
      cell: (p) => (
        <span className="flex min-w-0 items-center gap-2">
          <span className="relative shrink-0">
            <Avatar name={p.name} size="sm" />
            <PresenceDot presence={p.presence} />
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-medium">{p.me ? t("message.you", { name: p.name }) : p.name}</span>
            <span className="truncate text-2xs text-fg-muted">{p.guest ? (p.guest.company ?? p.email) : p.email}</span>
          </span>
        </span>
      ),
    },
    {
      id: "status",
      header: t("people.status"),
      width: "26%",
      cell: (p) => (
        <span className="flex min-w-0 flex-col">
          <span className="text-xs text-fg">{presenceLabel(p, t)}</span>
          {p.status && <span className="truncate text-2xs text-fg-muted">{p.status}</span>}
        </span>
      ),
    },
    {
      id: "time",
      header: t("people.localTime"),
      cell: (p) => {
        const at = localTime(p.timeZone, locale);
        return at ? (
          <span className="text-xs">
            <span className="font-mono tabular-nums">{at}</span> <span className="text-fg-muted">{tzPlace(p.timeZone!)}</span>
          </span>
        ) : (
          <span className="text-xs text-fg-subtle">{t("people.noTime")}</span>
        );
      },
    },
    {
      id: "groups",
      header: t("people.groups"),
      cell: (p) =>
        p.guest ? (
          <Badge tone="warning">{t("message.guest")}</Badge>
        ) : (
          <span className="flex flex-wrap gap-1">
            {p.groups.map((g) => (
              <Badge key={g}>{g}</Badge>
            ))}
          </span>
        ),
    },
    {
      id: "channels",
      header: t("people.channels"),
      align: "right",
      sortValue: (p) => p.channels,
      cell: (p) => <span className="tabular-nums">{p.channels}</span>,
    },
  ];
  const curTime = cur && localTime(cur.timeZone, locale);
  return (
    <>
      <PageHeader
        title={t("people.title")}
        description={data?.source === "identity" ? t("people.description") : t("people.descriptionMatrix")}
        actions={
          <Button variant="primary" icon={<Plus />} onClick={() => setInviting(true)}>
            {t("guests.invite")}
          </Button>
        }
      />
      {data?.leaving.map((l) => (
        <Callout key={l.email} tone="warning" title={t("people.leaving", { name: l.name })} className="mb-2.5">
          {t("people.leavingDetail", { name: l.name, count: l.channels })}
        </Callout>
      ))}
      {note && <Notice tone={note.tone}>{note.text}</Notice>}
      {link && (
        <Panel title={t("guests.linkTitle")} description={t("guests.linkDetail", { homeserver: ctx.me.homeserver })} className="mb-2.5">
          <Code label={t("guests.linkTitle")}>{link}</Code>
        </Panel>
      )}
      <div className="chat-side-wide grid gap-2.5">
        <Panel flush>
          <div className="flex flex-wrap items-end justify-between gap-2 px-3 pt-2">
            <Tabs
              label={t("people.title")}
              value={tab}
              onChange={setTab}
              items={[
                { value: "all", label: t("people.everyone"), count: all.length },
                { value: "members", label: t("people.members"), count: all.filter((p) => !p.guest).length },
                { value: "guests", label: t("people.guests"), count: all.filter((p) => p.guest).length },
              ]}
              className="border-b-0"
            />
            <SearchInput
              label={t("people.search")}
              placeholder={t("people.searchHint")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="mb-1.5 w-56"
            />
          </div>
          <div className="border-t border-line">
            <DataTable
              label={t("people.title")}
              columns={cols}
              rows={rows}
              getRowId={(p) => p.userId}
              onRowClick={(p) => setActive(p.userId)}
              activeRowId={cur?.userId}
              minWidth={680}
            />
          </div>
        </Panel>
        {cur && (
          <Panel aria-label={t("people.person")}>
            <div className="flex flex-col gap-3 text-sm">
              <div className="flex items-center gap-2.5">
                <span className="relative">
                  <Avatar name={cur.name} />
                  <PresenceDot presence={cur.presence} />
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-base font-semibold text-fg">{cur.name}</span>
                  <span className="truncate text-xs text-fg-muted">{cur.guest ? (cur.guest.company ?? t("message.guest")) : cur.groups.join(", ")}</span>
                </span>
              </div>
              {!cur.me && (
                <div className="flex gap-1.5">
                  <Button
                    size="sm"
                    icon={<MessageSquare />}
                    onClick={() => void message(cur).catch((err: Error) => setNote({ text: err.message, tone: "danger" }))}
                  >
                    {t("people.message")}
                  </Button>
                  {meet && (
                    <Button size="sm" icon={<Video />} onClick={() => window.open(`${meet}/?with=${enc(cur.userId)}`, "_blank", "noopener")}>
                      {t("people.call")}
                    </Button>
                  )}
                </div>
              )}
              <dl className="chat-person grid gap-x-2 gap-y-1.5 text-xs">
                <dt className="text-fg-muted">{t("people.status")}</dt>
                <dd className="m-0 text-fg">
                  {presenceLabel(cur, t)}
                  {cur.status && `, ${cur.status}`}
                </dd>
                <dt className="text-fg-muted">{t("people.localTime")}</dt>
                <dd className="m-0 text-fg">{curTime ? t("people.timeIn", { time: curTime, place: tzPlace(cur.timeZone!) }) : t("people.noTime")}</dd>
                <dt className="text-fg-muted">{t("people.email")}</dt>
                <dd className="m-0 truncate font-mono text-fg">{cur.email ?? cur.userId}</dd>
                <dt className="text-fg-muted">{t("people.matrix")}</dt>
                <dd className="m-0 truncate font-mono text-fg">{cur.userId}</dd>
                {!cur.guest && cur.groups.length > 0 && (
                  <>
                    <dt className="text-fg-muted">{t("people.groups")}</dt>
                    <dd className="m-0 text-fg">{t("people.fromIdentity", { groups: cur.groups.join(", ") })}</dd>
                  </>
                )}
              </dl>
              {cur.guest && (
                <section className="flex flex-col gap-1.5 border-t border-line pt-3">
                  <h2 className="text-xs font-semibold text-fg-muted">{t("guests.access")}</h2>
                  <dl className="chat-person grid gap-x-2 gap-y-1.5 text-xs">
                    <dt className="text-fg-muted">{t("guests.canSee")}</dt>
                    <dd className="m-0 text-fg">{t("guests.sees", { channel: `#${cur.guest.channel}` })}</dd>
                    <dt className="text-fg-muted">{t("guests.invitedBy")}</dt>
                    <dd className="m-0 text-fg">{cur.guest.invitedBy}</dd>
                    <dt className="text-fg-muted">{t("guests.ends")}</dt>
                    <dd className="m-0 text-fg">{longDay(cur.guest.endsAt, locale)}</dd>
                    <dt className="text-fg-muted">{t("guests.signsIn")}</dt>
                    <dd className="m-0 text-fg">{cur.guest.welcomed ? t("guests.signsInElement") : t("guests.notWelcomed")}</dd>
                  </dl>
                  <Button size="sm" variant="danger" className="self-start" onClick={() => void end(cur)}>
                    {t("guests.end")}
                  </Button>
                </section>
              )}
            </div>
          </Panel>
        )}
      </div>
      <InviteDialog
        ctx={ctx}
        open={inviting}
        onOpenChange={setInviting}
        onDone={(l, name) => {
          setInviting(false);
          setLink(l);
          setNote({ text: t("guests.invited", { name }) });
          reload();
        }}
      />
    </>
  );
}
