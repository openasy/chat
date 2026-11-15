// The Messages page: the conversations on the left, a channel's messages in the middle, and its thread or details on
// the right. Everything is read from and written to the Matrix server as the signed-in person, so Element on their
// phone shows the same messages, reactions and threads.
import {
  Avatar,
  Badge,
  Button,
  Checkbox,
  cn,
  Dialog,
  EmptyState,
  IconButton,
  navigate,
  PageHeader,
  SearchInput,
  SelectField,
  SeverityBadge,
  StatusBadge,
  Switch,
  TextField,
  useLocalePreference,
} from "@openasy/ui";
import { AtSign, FileText, Info, Lock, MessageSquare, Paperclip, Pin, Plus, SendHorizontal, Smile, Video, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import type { Ctx } from "./App.tsx";
import { type Card, type Conversation, type ConversationDetail, type FileRef, type Message, type Person, type Reaction, type Thread } from "./api.ts";
import { bytes, dayLabel, enc, fileKind, KindIcon, longDay, Notice, post, PresenceDot, Rich, time, Who, type Note } from "./common.tsx";
import { retentionLabel, useT, type T } from "./i18n.ts";

const QUICK = ["👍", "🙏", "➕", "💯", "🎉", "👀", "✅", "❤️"];

const label = (c: { kind: string; name: string }) => (c.kind === "dm" ? c.name : `#${c.name}`);

function fileHref(f: FileRef) {
  const [server, media] = f.uri.slice(6).split("/");
  return `/api/v1/files/${enc(server ?? "")}/${enc(media ?? "")}?name=${enc(f.name)}`;
}

function MessageCard({ card }: { card: Card }) {
  return (
    <div className="chat-card mt-1.5 flex max-w-md flex-col gap-1.5 rounded-md border border-line bg-canvas px-3 py-2">
      <span className="flex flex-wrap items-center gap-1.5">
        <span className="text-sm font-semibold text-fg">{card.title}</span>
        {card.severity && <SeverityBadge severity={card.severity} />}
        {card.status && <StatusBadge tone={card.status.tone}>{card.status.label}</StatusBadge>}
      </span>
      {card.fields.length > 0 && (
        <dl className="grid grid-cols-3 gap-2 text-xs">
          {card.fields.map(([k, v]) => (
            <div key={k} className="flex min-w-0 flex-col">
              <dt className="text-fg-muted">{k}</dt>
              <dd className="truncate font-medium text-fg">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {card.link && (
        <a href={card.link.url} target="_blank" rel="noreferrer" className="self-start text-xs font-medium text-accent-text">
          {card.link.label}
        </a>
      )}
    </div>
  );
}

function Reactions({ list, onToggle, t }: { list: Reaction[]; onToggle: (emoji: string) => void; t: T }) {
  return (
    <span className="mt-1 flex flex-wrap gap-1">
      {list.map((r) => (
        <button
          key={r.emoji}
          type="button"
          aria-pressed={r.mine}
          title={r.by.join(", ")}
          aria-label={`${r.emoji} ${r.count}`}
          onClick={() => onToggle(r.emoji)}
          className={cn(
            "flex h-6 items-center gap-1 rounded-full border px-2 text-xs tabular-nums",
            r.mine ? "border-accent bg-accent-soft text-accent-text" : "border-line bg-surface text-fg-muted hover:bg-subtle",
          )}
        >
          <span>{r.emoji}</span>
          {r.count}
          <span className="sr-only">{r.mine ? `, ${t("message.youReacted")}` : ""}</span>
        </button>
      ))}
    </span>
  );
}

function ReactButton({ onPick, t }: { onPick: (emoji: string) => void; t: T }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="chat-react relative">
      <IconButton label={t("message.react")} size="xs" onClick={() => setOpen((o) => !o)}>
        <Smile className="size-3.5" />
      </IconButton>
      {open && (
        <span role="menu" aria-label={t("message.react")} className="chat-pop flex gap-0.5 rounded-md border border-line bg-surface p-1">
          {QUICK.map((e) => (
            <button
              key={e}
              type="button"
              role="menuitem"
              className="grid size-7 place-items-center rounded hover:bg-subtle"
              onClick={() => {
                setOpen(false);
                onPick(e);
              }}
            >
              {e}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

function MessageRow({
  m,
  me,
  compact,
  active,
  onThread,
  onReact,
  channels,
}: {
  m: Message;
  me: string;
  compact?: boolean;
  active?: boolean;
  onThread?: () => void;
  onReact?: (emoji: string) => void;
  channels: Map<string, string>;
}) {
  const t = useT();
  const [locale] = useLocalePreference();
  const replies = m.thread;
  return (
    <li
      className={cn(
        "flex gap-2.5 px-3 py-2",
        m.mentionsMe && "border-l-2 border-warning bg-warning-soft/40 pl-2.5",
        active && "bg-accent-soft/40",
        !m.mentionsMe && !active && "hover:bg-canvas",
      )}
    >
      <Who sender={m.sender} size={compact ? "sm" : "md"} />
      <div className="flex min-w-0 grow flex-col">
        <span className="flex flex-wrap items-baseline gap-x-1.5">
          <span className="text-sm font-semibold text-fg">{m.sender.name === me ? t("message.you", { name: me }) : m.sender.name}</span>
          {m.sender.app && <Badge className="self-center">{t("message.app")}</Badge>}
          {m.sender.guest && (
            <Badge tone="warning" className="self-center">
              {t("message.guest")}
            </Badge>
          )}
          <time dateTime={m.ts} className="text-2xs text-fg-subtle tabular-nums">
            {time(m.ts, locale)}
          </time>
          {m.edited && <span className="text-2xs text-fg-subtle">{t("message.edited")}</span>}
          {onReact && !m.deleted && !m.encrypted && <ReactButton onPick={onReact} t={t} />}
        </span>
        {m.deleted ? (
          <p className="text-sm leading-snug text-fg-subtle">{t("message.deleted")}</p>
        ) : m.encrypted ? (
          <p className="flex items-center gap-1 text-sm leading-snug text-fg-subtle">
            <Lock aria-hidden className="size-3.5" />
            {t("message.encrypted")}
          </p>
        ) : (
          m.text && (
            <p className="chat-text text-sm leading-snug text-fg">
              <Rich text={m.text} me={me} channels={channels} />
            </p>
          )
        )}
        {m.card && <MessageCard card={m.card} />}
        {m.file && (
          <a
            href={fileHref(m.file)}
            className="mt-1.5 flex max-w-xs items-center gap-2 rounded-md border border-line bg-surface px-2.5 py-2 no-underline hover:bg-canvas"
          >
            <span className="grid size-8 shrink-0 place-items-center rounded bg-danger-soft text-danger-text">
              <FileText aria-hidden className="size-4" />
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-medium text-fg">{m.file.name}</span>
              <span className="text-2xs text-fg-muted">
                {[fileKind(m.file.name), m.file.size !== null ? bytes(m.file.size, locale) : null, t("message.keptHere")].filter(Boolean).join(" · ")}
              </span>
            </span>
          </a>
        )}
        {m.reactions.length > 0 && <Reactions list={m.reactions} onToggle={(e) => onReact?.(e)} t={t} />}
        {onThread && replies && replies.count > 0 && (
          <span className="mt-1 flex items-center gap-2">
            <span aria-hidden className="flex -space-x-1">
              {replies.participants.slice(0, 3).map((p) => (
                <Who key={p.userId} sender={p} size="sm" />
              ))}
            </span>
            <button type="button" aria-pressed={active} onClick={onThread} className="text-xs font-semibold text-accent-text hover:underline">
              {t("thread.replies", { count: replies.count })}
            </button>
            {replies.lastTs && <span className="text-2xs text-fg-subtle">{t("thread.lastReply", { time: time(replies.lastTs, locale) })}</span>}
          </span>
        )}
        {onThread && (!replies || replies.count === 0) && !m.deleted && !m.encrypted && (
          <button type="button" onClick={onThread} className="chat-reply self-start text-2xs font-medium text-fg-subtle hover:underline">
            {t("thread.reply")}
          </button>
        )}
      </div>
    </li>
  );
}

function Composer({
  placeholder,
  name,
  button,
  onSend,
  onUpload,
  extra,
  disabled,
}: {
  placeholder: string;
  name: string;
  button: string;
  onSend: (text: string, file: FileRef | null) => Promise<void>;
  onUpload: (f: File) => Promise<FileRef>;
  extra?: ReactNode;
  disabled?: boolean;
}) {
  const t = useT();
  const [text, setText] = useState("");
  const [file, setFile] = useState<FileRef | null>(null);
  const [busy, setBusy] = useState(false);
  const [emoji, setEmoji] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const id = `composer-${name.replace(/\W+/g, "-")}`;
  const insert = (s: string) => {
    setText((x) => x + s);
    area.current?.focus();
  };
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if ((!text.trim() && !file) || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSend(text.trim(), file);
      setText("");
      setFile(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const keys = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-1.5 border-t border-line p-2.5">
      <div className="flex flex-col rounded-md border border-line bg-surface focus-within:border-accent">
        <label htmlFor={id} className="sr-only">
          {name}
        </label>
        <textarea
          id={id}
          ref={area}
          rows={1}
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={keys}
          placeholder={placeholder}
          className="w-full resize-none bg-transparent px-2.5 pt-2 text-sm text-fg outline-none placeholder:text-fg-subtle"
        />
        {file && (
          <span className="flex items-center gap-1.5 px-2.5 pt-1 text-xs text-fg-muted">
            <FileText aria-hidden className="size-3.5" />
            <span className="truncate">{file.name}</span>
            <IconButton label={t("composer.removeFile")} size="xs" onClick={() => setFile(null)}>
              <X className="size-3.5" />
            </IconButton>
          </span>
        )}
        <span className="relative flex items-center gap-0.5 px-1.5 pb-1.5">
          <IconButton label={t("composer.attach")} size="xs" disabled={disabled || busy} onClick={() => picker.current?.click()}>
            <Paperclip className="size-3.5" />
          </IconButton>
          <input
            ref={picker}
            type="file"
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              setBusy(true);
              onUpload(f).then(
                (r) => (setFile(r), setBusy(false)),
                (err: Error) => (setError(err.message), setBusy(false)),
              );
            }}
          />
          <IconButton label={t("composer.mention")} size="xs" disabled={disabled} onClick={() => insert(text && !text.endsWith(" ") ? " @" : "@")}>
            <AtSign className="size-3.5" />
          </IconButton>
          <IconButton label={t("composer.emoji")} size="xs" disabled={disabled} onClick={() => setEmoji((o) => !o)}>
            <Smile className="size-3.5" />
          </IconButton>
          {emoji && (
            <span role="menu" aria-label={t("composer.emoji")} className="chat-pop chat-pop-up flex gap-0.5 rounded-md border border-line bg-surface p-1">
              {QUICK.map((q) => (
                <button
                  key={q}
                  type="button"
                  role="menuitem"
                  className="grid size-7 place-items-center rounded hover:bg-subtle"
                  onClick={() => (insert(q), setEmoji(false))}
                >
                  {q}
                </button>
              ))}
            </span>
          )}
          <span className="grow" />
          <Button type="submit" size="xs" variant="primary" icon={<SendHorizontal />} disabled={disabled || busy}>
            {button}
          </Button>
        </span>
      </div>
      {error && (
        <p role="alert" className="text-xs text-danger-text">
          {error}
        </p>
      )}
      {extra}
    </form>
  );
}

function Sidebar({
  list,
  active,
  onOpen,
  onBrowse,
  onNew,
  presence,
}: {
  list: Conversation[];
  active: string | null;
  onOpen: (id: string) => void;
  onBrowse: () => void;
  onNew: () => void;
  presence: Map<string, Person>;
}) {
  const t = useT();
  const row = (c: Conversation) => {
    const n = c.unread;
    const on = c.id === active;
    const other = c.with[0];
    return (
      <li key={c.id}>
        <button
          type="button"
          aria-current={on ? "page" : undefined}
          onClick={() => onOpen(c.id)}
          className={cn(
            "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-sm",
            on ? "bg-accent-soft font-medium text-accent-text" : n ? "font-semibold text-fg hover:bg-subtle" : "text-fg-muted hover:bg-subtle",
          )}
        >
          {c.kind === "dm" ? (
            <span className="relative grid size-5 shrink-0 place-items-center">
              <Avatar name={other?.name ?? c.name} size="sm" className="size-5 text-[8px]" />
              {c.with.length === 1 && other && <PresenceDot presence={presence.get(other.userId)?.presence ?? "offline"} className="size-2" />}
            </span>
          ) : (
            <KindIcon kind={c.kind} />
          )}
          <span className="min-w-0 grow truncate">{c.name}</span>
          {c.kind === "guests" && (
            <Badge tone="warning" className="px-1">
              {t("channel.guestsShort")}
            </Badge>
          )}
          {c.kind === "dm" && c.with.length === 1 && other?.guest && (
            <Badge tone="warning" className="px-1">
              {t("message.guest")}
            </Badge>
          )}
          {c.invited && (
            <Badge tone="info" className="px-1">
              {t("channel.invited")}
            </Badge>
          )}
          {n > 0 && !c.invited && (
            <span
              className={cn("rounded-full px-1.5 text-2xs font-semibold tabular-nums", c.mentions ? "bg-danger text-accent-contrast" : "bg-subtle text-fg")}
            >
              {n}
              <span className="sr-only"> {c.mentions ? t("channel.unreadMentions") : t("channel.unread")}</span>
            </span>
          )}
        </button>
      </li>
    );
  };
  return (
    <nav aria-label={t("channel.conversations")} className="flex min-h-0 flex-col gap-3 overflow-y-auto rounded-lg border border-line bg-surface p-2">
      <section className="flex flex-col gap-0.5">
        <h2 className="flex items-center justify-between px-2 pb-0.5 text-2xs font-semibold tracking-wide text-fg-muted uppercase">
          {t("channel.channels")}
          <IconButton label={t("channel.browse")} size="xs" onClick={onBrowse}>
            <Plus className="size-3.5" />
          </IconButton>
        </h2>
        <ul aria-label={t("channel.channels")} className="flex flex-col gap-0.5">
          {list.filter((c) => c.kind !== "dm").map(row)}
        </ul>
      </section>
      <section className="flex flex-col gap-0.5">
        <h2 className="flex items-center justify-between px-2 pb-0.5 text-2xs font-semibold tracking-wide text-fg-muted uppercase">
          {t("channel.direct")}
          <IconButton label={t("channel.newMessage")} size="xs" onClick={onNew}>
            <Plus className="size-3.5" />
          </IconButton>
        </h2>
        <ul aria-label={t("channel.direct")} className="flex flex-col gap-0.5">
          {list.filter((c) => c.kind === "dm").map(row)}
        </ul>
      </section>
    </nav>
  );
}

function ChannelInfo({ c, me, channels }: { c: ConversationDetail; me: string; channels: Map<string, string> }) {
  const t = useT();
  const [locale] = useLocalePreference();
  const items: Array<[string, string]> =
    c.kind === "dm"
      ? [
          [t("info.with"), c.with.map((w) => w.name).join(", ")],
          [t("info.kept"), retentionLabel(c.retention, t)],
        ]
      : [
          [t("info.members"), c.from ? `${c.members}, ${c.from}` : String(c.members)],
          [t("info.kept"), retentionLabel(c.retention, t)],
          [
            t("info.guests"),
            c.guests.length
              ? c.guests.map((g) => (g.company ? `${g.name}, ${g.company}` : g.name)).join("; ")
              : c.guestsAllowed
                ? t("info.guestsNone")
                : t("info.guestsNo"),
          ],
        ];
  const ends = c.guests.map((g) => g.endsAt).sort()[0];
  return (
    <section
      aria-label={c.kind === "dm" ? t("info.aboutConversation") : t("info.aboutChannel")}
      className="flex min-h-0 flex-col gap-3 overflow-y-auto rounded-lg border border-line bg-surface p-3"
    >
      <h2 className="text-sm font-semibold text-fg">{c.kind === "dm" ? t("info.aboutConversation") : t("info.aboutChannel")}</h2>
      {c.topic && <p className="text-sm text-fg">{c.topic}</p>}
      <dl className="chat-info grid gap-x-2 gap-y-1.5 text-xs">
        {items.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-fg-muted">{k}</dt>
            <dd className="m-0 text-fg">{v}</dd>
          </div>
        ))}
      </dl>
      {c.guests.length > 0 && ends && (
        <p className="rounded-md bg-warning-soft px-2.5 py-2 text-xs text-fg">
          {t("info.guestsSee", { date: longDay(ends, locale), who: c.guests[0]!.invitedBy })}
        </p>
      )}
      {c.hold && <p className="rounded-md bg-accent-soft px-2.5 py-2 text-xs text-fg">{t("info.hold", { reference: c.hold })}</p>}
      {c.encrypted && <p className="rounded-md bg-subtle px-2.5 py-2 text-xs text-fg">{t("info.encrypted")}</p>}
      <section className="flex flex-col gap-1.5 border-t border-line pt-3">
        <h3 className="text-xs font-semibold text-fg-muted">{t("info.pinned")}</h3>
        {c.pinned.length ? (
          <ul aria-label={t("info.pinned")} className="flex flex-col gap-1 text-xs text-fg">
            {c.pinned.map((p) => (
              <li key={p.id} className="truncate">
                {p.file ? p.file.name : <Rich text={p.text} me={me} channels={channels} />}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-fg-muted">{t("info.noPins")}</p>
        )}
      </section>
    </section>
  );
}

function ThreadPanel({
  thread,
  channel,
  me,
  channels,
  onClose,
  onReply,
  onReact,
  onUpload,
}: {
  thread: Thread;
  channel: ConversationDetail;
  me: string;
  channels: Map<string, string>;
  onClose: () => void;
  onReply: (text: string, file: FileRef | null, alsoChannel: boolean) => Promise<void>;
  onReact: (id: string, emoji: string) => void;
  onUpload: (f: File) => Promise<FileRef>;
}) {
  const t = useT();
  const [also, setAlso] = useState(false);
  const replies = thread.replies;
  return (
    <section aria-label={t("thread.title")} className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-line bg-surface">
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="flex min-w-0 grow flex-col">
          <h2 className="text-sm font-semibold text-fg">{t("thread.title")}</h2>
          <span className="truncate text-xs text-fg-muted">{label(channel)}</span>
        </span>
        <IconButton label={t("thread.close")} size="sm" onClick={onClose}>
          <X className="size-4" />
        </IconButton>
      </header>
      <div tabIndex={0} role="log" aria-label={t("thread.repliesLog")} className="flex min-h-0 grow flex-col overflow-y-auto">
        <ol className="chat-list flex flex-col py-1">
          <MessageRow m={{ ...thread.root, thread: null, reactions: [] }} me={me} compact channels={channels} />
          <li className="flex items-center gap-2 px-3 py-1 text-2xs font-medium text-fg-muted">
            {t("thread.replies", { count: replies.length })}
            <span aria-hidden className="h-px grow bg-line" />
          </li>
          {replies.map((r) => (
            <MessageRow key={r.id} m={r} me={me} compact channels={channels} onReact={(e) => onReact(r.id, e)} />
          ))}
        </ol>
      </div>
      {channel.canPost && !channel.encrypted && (
        <Composer
          name={t("thread.replyIn")}
          placeholder={t("thread.reply")}
          button={t("thread.reply")}
          onUpload={onUpload}
          onSend={(text, file) => onReply(text, file, also)}
          extra={
            <Checkbox label={t("thread.also", { channel: label(channel) })} checked={also} onChange={(e) => setAlso(e.target.checked)} className="text-xs" />
          }
        />
      )}
    </section>
  );
}

/** Days between messages, as separators. */
function withDays(list: Message[], words: { today: string; yesterday: string }, locale: string): Array<Message | { day: string }> {
  const out: Array<Message | { day: string }> = [];
  let last = "";
  for (const m of list) {
    const d = new Date(m.ts).toDateString();
    if (d !== last) out.push({ day: dayLabel(m.ts, words, locale) });
    last = d;
    out.push(m);
  }
  return out;
}

function BrowseDialog({ ctx, open, onOpenChange, onJoined }: { ctx: Ctx; open: boolean; onOpenChange: (o: boolean) => void; onJoined: (id: string) => void }) {
  const t = useT();
  const [list, setList] = useState<Array<{ id: string; name: string; topic: string | null; members: number; joined: boolean }>>();
  const [q, setQ] = useState("");
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [priv, setPriv] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open)
      void ctx.call<{ channels: NonNullable<typeof list> }>("/api/v1/directory").then(
        (r) => setList(r.channels),
        () => setList([]),
      );
  }, [open, ctx]);
  const make = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const r = await ctx.call<{ id: string }>("/api/v1/channels", post({ name, ...(topic && { topic }), private: priv }));
      setName("");
      setTopic("");
      onJoined(r.id);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const shown = (list ?? []).filter((c) => `${c.name} ${c.topic ?? ""}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("browse.title")}
      description={t("browse.description")}
      onSubmit={make}
      footer={<Button onClick={() => onOpenChange(false)}>{t("close")}</Button>}
    >
      <SearchInput label={t("browse.search")} value={q} onChange={(e) => setQ(e.target.value)} />
      <ul aria-label={t("browse.list")} className="chat-browse flex flex-col gap-1 overflow-y-auto">
        {list === undefined ? (
          <li className="text-xs text-fg-muted">{t("loading")}</li>
        ) : (
          shown.map((c) => (
            <li key={c.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-canvas">
              <KindIcon kind="public" className="text-fg-muted" />
              <span className="flex min-w-0 grow flex-col">
                <span className="truncate text-sm font-medium text-fg">{c.name}</span>
                <span className="truncate text-2xs text-fg-muted">{[c.topic, t("browse.members", { count: c.members })].filter(Boolean).join(" · ")}</span>
              </span>
              {c.joined ? (
                <Button size="xs" variant="ghost" onClick={() => onJoined(c.id)}>
                  {t("browse.open")}
                </Button>
              ) : (
                <Button
                  size="xs"
                  onClick={() =>
                    void ctx.call(`/api/v1/conversations/${enc(c.id)}/join`, post()).then(
                      () => onJoined(c.id),
                      (err: Error) => setError(err.message),
                    )
                  }
                >
                  {t("browse.join")}
                </Button>
              )}
            </li>
          ))
        )}
      </ul>
      <fieldset className="flex flex-col gap-2 border-t border-line pt-3">
        <legend className="text-xs font-semibold text-fg-muted">{t("browse.new")}</legend>
        <TextField
          label={t("browse.name")}
          value={name}
          onChange={(e) => setName(e.target.value.toLowerCase().replace(/\s+/g, "-"))}
          placeholder="project-atlas"
        />
        <TextField label={t("browse.topic")} value={topic} onChange={(e) => setTopic(e.target.value)} />
        <Switch checked={priv} onCheckedChange={setPriv} label={t("browse.private")} description={t("browse.privateDetail")} />
        {error && <Notice tone="danger">{error}</Notice>}
        <Button type="submit" variant="primary" icon={<Plus />} className="self-start" disabled={!name}>
          {t("browse.create")}
        </Button>
      </fieldset>
    </Dialog>
  );
}

function NewMessageDialog({
  ctx,
  people,
  open,
  onOpenChange,
  onOpened,
}: {
  ctx: Ctx;
  people: Person[];
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onOpened: (id: string) => void;
}) {
  const t = useT();
  const [who, setWho] = useState("");
  const [error, setError] = useState<string | null>(null);
  const options = people.filter((p) => !p.me);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!who) return;
    try {
      const r = await ctx.call<{ id: string }>("/api/v1/conversations/direct", post({ people: [who] }));
      onOpened(r.id);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("newMessage.title")}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t("cancel")}</Button>
          <Button type="submit" variant="primary" icon={<MessageSquare />} disabled={!who}>
            {t("newMessage.open")}
          </Button>
        </>
      }
    >
      <SelectField
        label={t("newMessage.to")}
        value={who}
        onChange={(e) => setWho(e.target.value)}
        options={[
          { value: "", label: t("newMessage.pick") },
          ...options.map((p) => ({ value: p.userId, label: p.guest ? `${p.name} (${t("message.guest")})` : p.name })),
        ]}
      />
      {error && <Notice tone="danger">{error}</Notice>}
    </Dialog>
  );
}

export function MessagesPage({ ctx, roomId }: { ctx: Ctx; roomId: string | null }) {
  const t = useT();
  const [locale] = useLocalePreference();
  const { call, me } = ctx;
  const [list, setList] = useState<Conversation[]>();
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [page, setPage] = useState<{ messages: Message[]; before: string | null } | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [thread, setThread] = useState<Thread | null>(null);
  const [panel, setPanel] = useState<"thread" | "info">("info");
  const [people, setPeople] = useState<Person[]>([]);
  const [browse, setBrowse] = useState(false);
  const [newDm, setNewDm] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const active = roomId ?? list?.find((c) => c.kind !== "dm")?.id ?? null;
  const current = useRef(active);
  current.current = active;
  const threadRef = useRef(threadId);
  threadRef.current = threadId;

  const loadList = useCallback(
    () =>
      call<{ conversations: Conversation[] }>("/api/v1/conversations").then(
        (r) => setList(r.conversations),
        () => setList((l) => l ?? []),
      ),
    [call],
  );
  const loadRoom = useCallback(
    async (id: string) => {
      const [d, p] = await Promise.all([
        call<ConversationDetail>(`/api/v1/conversations/${enc(id)}`),
        call<{ messages: Message[]; before: string | null }>(`/api/v1/conversations/${enc(id)}/messages`),
      ]);
      if (current.current !== id) return;
      setDetail(d);
      setPage(p);
      const last = p.messages.at(-1);
      if (last) void call(`/api/v1/conversations/${enc(id)}/read`, post({ eventId: last.id })).then(loadList, () => {});
    },
    [call, loadList],
  );
  const loadThread = useCallback(
    (id: string, root: string) =>
      call<Thread>(`/api/v1/conversations/${enc(id)}/threads/${enc(root)}`).then(
        (th) => current.current === id && setThread(th),
        () => setThread(null),
      ),
    [call],
  );

  useEffect(() => {
    void loadList();
    void call<{ people: Person[] }>("/api/v1/people").then(
      (r) => setPeople(r.people),
      () => {},
    );
  }, [call, loadList]);

  useEffect(() => {
    setDetail(null);
    setPage(null);
    setThreadId(null);
    setThread(null);
    setPanel("info");
    setNote(null);
    if (active && !list?.find((c) => c.id === active)?.invited) void loadRoom(active).catch((err: Error) => setNote({ text: err.message, tone: "danger" }));
    // Only when the conversation changes; the list is read for whether it is an invitation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, loadRoom]);

  // New messages, from the Matrix server's own sync: the list and the open conversation follow within a second.
  useEffect(() => {
    let live = true;
    let since: string | null = null;
    const loop = async () => {
      while (live) {
        try {
          const r: { since: string; changed: string[] } = await call(`/api/v1/wait${since ? `?since=${enc(since)}` : ""}`);
          if (!live) return;
          if (since && r.changed.length) {
            void loadList();
            const id = current.current;
            if (id && r.changed.includes(id)) {
              void loadRoom(id).catch(() => {});
              if (threadRef.current) void loadThread(id, threadRef.current);
            }
          }
          since = r.since;
        } catch {
          await new Promise((res) => setTimeout(res, 5000));
        }
      }
    };
    void loop();
    return () => {
      live = false;
    };
  }, [call, loadList, loadRoom, loadThread]);

  const conv = list?.find((c) => c.id === active);
  const channels = useMemo(() => new Map((list ?? []).filter((c) => c.kind !== "dm").map((c) => [c.name, c.id])), [list]);
  const presence = useMemo(() => new Map(people.map((p) => [p.userId, p])), [people]);
  const open = (id: string) => navigate(`/messages/${enc(id)}`);
  const upload = (f: File) =>
    call<FileRef>("/api/v1/files", { method: "POST", body: f, headers: { "content-type": f.type || "application/octet-stream", "x-file-name": enc(f.name) } });
  const send = async (text: string, file: FileRef | null) => {
    if (!active) return;
    const m = await call<Message>(`/api/v1/conversations/${enc(active)}/messages`, post({ text, ...(file && { file }) }));
    setPage((p) => (p ? { ...p, messages: [...p.messages.filter((x) => x.id !== m.id), m] } : p));
  };
  const reply = async (text: string, file: FileRef | null, also: boolean) => {
    if (!active || !threadId) return;
    await call<Message>(`/api/v1/conversations/${enc(active)}/messages`, post({ text, threadRoot: threadId, alsoInChannel: also, ...(file && { file }) }));
    await Promise.all([loadThread(active, threadId), loadRoom(active)]);
  };
  const react = async (id: string, emoji: string) => {
    if (!active) return;
    const r = await call<{ reactions: Reaction[] }>(`/api/v1/conversations/${enc(active)}/messages/${enc(id)}/reactions`, post({ emoji })).catch(
      (err: Error) => {
        setNote({ text: err.message, tone: "danger" });
        return null;
      },
    );
    if (!r) return;
    setPage((p) => (p ? { ...p, messages: p.messages.map((m) => (m.id === id ? { ...m, reactions: r.reactions } : m)) } : p));
    setThread((th) => (th ? { ...th, replies: th.replies.map((m) => (m.id === id ? { ...m, reactions: r.reactions } : m)) } : th));
  };
  const openThread = (id: string) => {
    if (!active) return;
    setThreadId(id);
    setPanel("thread");
    void loadThread(active, id);
  };
  const older = async () => {
    if (!active || !page?.before) return;
    const p = await call<{ messages: Message[]; before: string | null }>(`/api/v1/conversations/${enc(active)}/messages?before=${enc(page.before)}`);
    setPage((cur) => (cur ? { messages: [...p.messages, ...cur.messages.filter((m) => !p.messages.some((x) => x.id === m.id))], before: p.before } : cur));
  };
  const join = async () => {
    if (!active) return;
    await call(`/api/v1/conversations/${enc(active)}/join`, post());
    await loadList();
    await loadRoom(active);
  };

  // Browsing channels and starting a message work from the empty page too: a new member starts there.
  const dialogs = (
    <>
      <BrowseDialog
        ctx={ctx}
        open={browse}
        onOpenChange={setBrowse}
        onJoined={(id) => {
          setBrowse(false);
          void loadList().then(() => open(id));
        }}
      />
      <NewMessageDialog
        ctx={ctx}
        people={people}
        open={newDm}
        onOpenChange={setNewDm}
        onOpened={(id) => {
          setNewDm(false);
          void loadList().then(() => open(id));
        }}
      />
    </>
  );

  if (list === undefined) return <PageHeader title={t("nav.messages")} description={t("loading")} />;
  if (!active)
    return (
      <>
        <PageHeader title={t("nav.messages")} />
        <EmptyState
          icon={<MessageSquare />}
          title={t("channel.none")}
          action={
            <span className="flex flex-wrap justify-center gap-1.5">
              <Button variant="primary" onClick={() => setBrowse(true)}>
                {t("channel.browse")}
              </Button>
              <Button onClick={() => setNewDm(true)}>{t("channel.newMessage")}</Button>
            </span>
          }
        >
          {t("channel.noneDetail")}
        </EmptyState>
        {dialogs}
      </>
    );

  const name = detail?.name ?? conv?.name ?? "";
  const kind = detail?.kind ?? conv?.kind ?? "public";
  const c = { kind, name };
  const companies = [...new Set((detail?.guests ?? []).map((g) => g.company).filter((x): x is string => !!x))];
  const meet = ctx.meetUrl;
  const words = { today: t("day.today"), yesterday: t("day.yesterday") };
  const items = withDays(page?.messages ?? [], words, locale);

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-1.5">
            {kind === "dm" ? <MessageSquare aria-hidden className="size-5 text-fg-muted" /> : <KindIcon kind={kind} className="size-5 text-fg-muted" />}
            {name}
          </span>
        }
        description={kind === "dm" ? t("channel.directMessage") : (detail?.topic ?? conv?.topic ?? undefined)}
        meta={
          detail && (
            <>
              {detail.reference && <Badge tone="danger">{detail.reference}</Badge>}
              {detail.guests.length > 0 && (
                <Badge tone="warning">
                  {companies.length === 1
                    ? t("channel.guestsFrom", { count: detail.guests.length, company: companies[0]! })
                    : t("channel.guestsCount", { count: detail.guests.length })}
                </Badge>
              )}
              {kind === "private" && <Badge>{t("channel.private")}</Badge>}
              {detail.encrypted && <Badge tone="info">{t("channel.encrypted")}</Badge>}
            </>
          )
        }
        actions={
          detail && (
            <>
              <Button variant="ghost" onClick={() => navigate("/people")}>
                <span aria-hidden className="flex -space-x-1.5">
                  {detail.someMembers.map((p) => (
                    <Avatar key={p.userId} name={p.name} size="sm" className="ring-2 ring-surface" />
                  ))}
                </span>
                {detail.members}
                <span className="sr-only"> {t("channel.members")}</span>
              </Button>
              <Button icon={<Pin />} onClick={() => setPanel("info")}>
                {t("channel.pinned")}
              </Button>
              {meet && (
                <Button icon={<Video />} onClick={() => window.open(`${meet}/?room=${enc(detail.alias ?? detail.name)}`, "_blank", "noopener")}>
                  {t("channel.call")}
                </Button>
              )}
              <IconButton label={t("channel.details")} onClick={() => setPanel("info")}>
                <Info className="size-4" />
              </IconButton>
            </>
          )
        }
      />
      {note && <Notice tone={note.tone}>{note.text}</Notice>}
      <div className="chat-layout grid gap-2.5">
        <Sidebar list={list} active={active} onOpen={open} onBrowse={() => setBrowse(true)} onNew={() => setNewDm(true)} presence={presence} />
        <section aria-label={t("channel.conversation")} className="chat-main flex min-h-0 flex-col overflow-hidden rounded-lg border border-line bg-surface">
          {conv?.invited ? (
            <div className="flex grow flex-col items-center justify-center gap-2 p-6 text-center">
              <p className="text-sm text-fg">{t("channel.invitedTo", { name: label(c) })}</p>
              <Button variant="primary" onClick={() => void join()}>
                {t("browse.join")}
              </Button>
            </div>
          ) : (
            <>
              <div tabIndex={0} role="log" aria-label={t("channel.log", { name: label(c) })} className="flex min-h-0 grow flex-col-reverse overflow-y-auto">
                <ol className="chat-list flex flex-col py-1">
                  {page?.before && (
                    <li className="flex justify-center py-1">
                      <Button size="xs" variant="ghost" onClick={() => void older()}>
                        {t("channel.older")}
                      </Button>
                    </li>
                  )}
                  {page && !page.messages.length && <li className="px-3 py-6 text-center text-sm text-fg-muted">{t("channel.empty")}</li>}
                  {items.map((i, k) =>
                    "day" in i ? (
                      <li key={`d${k}`} className="flex items-center gap-2 px-3 pt-3 pb-1 text-2xs font-semibold text-fg-muted">
                        <span aria-hidden className="h-px grow bg-line" />
                        {i.day}
                        <span aria-hidden className="h-px grow bg-line" />
                      </li>
                    ) : (
                      <MessageRow
                        key={i.id}
                        m={i}
                        me={me.name}
                        channels={channels}
                        active={panel === "thread" && threadId === i.id}
                        onThread={() => openThread(i.id)}
                        onReact={(e) => void react(i.id, e)}
                      />
                    ),
                  )}
                </ol>
              </div>
              {detail?.encrypted ? (
                <p className="border-t border-line p-2.5 text-xs text-fg-muted">{t("channel.encryptedDetail")}</p>
              ) : detail && !detail.canPost ? (
                <p className="border-t border-line p-2.5 text-xs text-fg-muted">{t("channel.adminsPost")}</p>
              ) : (
                <Composer
                  key={active}
                  name={t("composer.to", { name: label(c) })}
                  placeholder={t("composer.to", { name: label(c) })}
                  button={t("composer.send")}
                  onSend={send}
                  onUpload={upload}
                  disabled={!detail}
                  extra={
                    detail && detail.guests.length > 0 ? (
                      <p className="text-xs text-fg-muted">
                        {companies.length === 1 ? t("composer.guestsSee", { company: companies[0]! }) : t("composer.guestsSeeAll")}
                      </p>
                    ) : (
                      <p className="text-xs text-fg-subtle">{t("composer.hint")}</p>
                    )
                  }
                />
              )}
            </>
          )}
        </section>
        {detail && panel === "thread" && thread ? (
          <ThreadPanel
            key={thread.root.id}
            thread={thread}
            channel={detail}
            me={me.name}
            channels={channels}
            onClose={() => (setPanel("info"), setThreadId(null))}
            onReply={reply}
            onReact={(id, e) => void react(id, e)}
            onUpload={upload}
          />
        ) : detail ? (
          <ChannelInfo c={detail} me={me.name} channels={channels} />
        ) : (
          <section aria-label={t("info.aboutChannel")} className="rounded-lg border border-line bg-surface p-3 text-xs text-fg-muted">
            {t("loading")}
          </section>
        )}
      </div>
      {dialogs}
    </>
  );
}
