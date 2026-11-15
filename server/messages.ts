// Matrix events as the pages show them: a message with its sender, text, file or card, the latest edit, the reactions
// on it and its thread's summary. Edits (m.replace), reactions (m.annotation) and thread replies (m.thread) are events
// of their own in Matrix; they are folded into the message they belong to here.
import type { MatrixEvent } from "./matrix.ts";

export interface Sender {
  userId: string;
  name: string;
  /** The app's name when an app of the file posted it through its webhook. */
  app: string | null;
  guest: boolean;
}

export interface Card {
  title: string;
  severity: "critical" | "high" | "medium" | "low" | "info" | null;
  status: { label: string; tone: "success" | "warning" | "danger" | "info" | "neutral" } | null;
  fields: Array<[string, string]>;
  link: { label: string; url: string } | null;
}

export interface FileRef {
  /** The mxc:// address Matrix keeps it under. */
  uri: string;
  name: string;
  size: number | null;
  type: string | null;
}

export interface Reaction {
  emoji: string;
  count: number;
  mine: boolean;
  by: string[];
}

export interface Message {
  id: string;
  sender: Sender;
  ts: string;
  text: string;
  edited: boolean;
  deleted: boolean;
  /** Sent end-to-end encrypted: only the people's own Matrix apps can read it. */
  encrypted: boolean;
  file: FileRef | null;
  card: Card | null;
  reactions: Reaction[];
  thread: { count: number; lastTs: string | null; participants: Sender[] } | null;
  /** The thread it is a reply in, by the first message's id. */
  threadRoot: string | null;
  mentionsMe: boolean;
}

/** The custom part of a message an app sends with a card: Element shows the text, the pages show the card. */
export const CARD = "org.openasy.card";

export interface Who {
  name(userId: string): string;
  app(userId: string): string | null;
  guest(userId: string): boolean;
}

export const senderOf = (userId: string, who: Who): Sender => ({ userId, name: who.name(userId), app: who.app(userId), guest: who.guest(userId) });

const SEVERITIES = ["critical", "high", "medium", "low", "info"];
const TONES = ["success", "warning", "danger", "info", "neutral"];

/** A card from an app's message, kept to what the pages draw. */
export function cardOf(v: unknown): Card | null {
  if (!v || typeof v !== "object") return null;
  const c = v as Record<string, any>;
  if (typeof c.title !== "string" || !c.title.trim()) return null;
  const fields = Array.isArray(c.fields)
    ? c.fields
        .filter((f: unknown) => Array.isArray(f) && f.length === 2)
        .slice(0, 6)
        .map((f: unknown[]) => [String(f[0]).slice(0, 64), String(f[1]).slice(0, 200)] as [string, string])
    : [];
  const link =
    c.link && typeof c.link.url === "string" && /^https?:\/\//.test(c.link.url)
      ? { label: String(c.link.label ?? c.link.url).slice(0, 64), url: c.link.url }
      : null;
  return {
    title: c.title.slice(0, 200),
    severity: SEVERITIES.includes(c.severity) ? c.severity : null,
    status:
      c.status && typeof c.status.label === "string"
        ? { label: c.status.label.slice(0, 64), tone: TONES.includes(c.status.tone) ? c.status.tone : "neutral" }
        : null,
    fields,
    link,
  };
}

const relation = (e: MatrixEvent) => (e.content?.["m.relates_to"] ?? {}) as { rel_type?: string; event_id?: string; key?: string };

/** The text of a message, without the quoted reply Element puts before it in older clients. */
function bodyOf(content: Record<string, any>): string {
  const body = typeof content.body === "string" ? content.body : "";
  return body.replace(/^(> .*\n)+\n/, "");
}

/** One event as the pages show it, without reactions and thread replies, which are added from their own events. */
export function toMessage(e: MatrixEvent, me: string, who: Who): Message {
  const redacted = !!e.unsigned?.redacted_because || (e.type === "m.room.message" && !e.content?.msgtype);
  const encrypted = e.type === "m.room.encrypted";
  const latestEdit = e.unsigned?.["m.relations"]?.["m.replace"] as MatrixEvent | undefined;
  const content = (latestEdit?.content?.["m.new_content"] as Record<string, any> | undefined) ?? e.content ?? {};
  const isFile = ["m.file", "m.image", "m.video", "m.audio"].includes(content.msgtype) && typeof content.url === "string";
  const name = isFile ? String(content.filename ?? content.body ?? "file") : "";
  const text = redacted || encrypted ? "" : isFile ? (content.filename && content.body !== content.filename ? bodyOf(content) : "") : bodyOf(content);
  const thread = e.unsigned?.["m.relations"]?.["m.thread"] as { count?: number; latest_event?: MatrixEvent } | undefined;
  const mentions = e.content?.["m.mentions"] as { user_ids?: string[]; room?: boolean } | undefined;
  return {
    id: e.event_id,
    sender: senderOf(e.sender, who),
    ts: new Date(e.origin_server_ts).toISOString(),
    text,
    edited: !!latestEdit,
    deleted: redacted,
    encrypted,
    file: isFile
      ? {
          uri: content.url,
          name,
          size: typeof content.info?.size === "number" ? content.info.size : null,
          type: typeof content.info?.mimetype === "string" ? content.info.mimetype : null,
        }
      : null,
    card: redacted ? null : cardOf(e.content?.[CARD]),
    reactions: [],
    thread: thread?.count
      ? {
          count: thread.count,
          lastTs: thread.latest_event ? new Date(thread.latest_event.origin_server_ts).toISOString() : null,
          participants: thread.latest_event ? [senderOf(thread.latest_event.sender, who)] : [],
        }
      : null,
    threadRoot: relation(e).rel_type === "m.thread" ? (relation(e).event_id ?? null) : null,
    mentionsMe: !!mentions?.user_ids?.includes(me) || !!mentions?.room,
  };
}

/** Reactions on messages, from m.reaction events that were not taken back. */
export function reactionsOf(events: MatrixEvent[], me: string, who: Who): Map<string, Reaction[]> {
  const by = new Map<string, Map<string, string[]>>();
  for (const e of events) {
    if (e.type !== "m.reaction" || e.unsigned?.redacted_because) continue;
    const r = relation(e);
    if (r.rel_type !== "m.annotation" || !r.event_id || !r.key) continue;
    const keys = by.get(r.event_id) ?? new Map<string, string[]>();
    const list = keys.get(r.key) ?? [];
    if (!list.includes(e.sender)) list.push(e.sender);
    keys.set(r.key, list);
    by.set(r.event_id, keys);
  }
  const out = new Map<string, Reaction[]>();
  for (const [id, keys] of by)
    out.set(
      id,
      [...keys].map(([emoji, senders]) => ({ emoji, count: senders.length, mine: senders.includes(me), by: senders.map((s) => who.name(s)) })),
    );
  return out;
}

const SHOWN = new Set(["m.room.message", "m.room.encrypted"]);

/**
 * A page of a room's timeline, oldest first, as the pages show it: messages with their latest edit and the reactions
 * on them; thread replies are counted on the thread's first message and not shown in the channel.
 */
export function timeline(events: MatrixEvent[], me: string, who: Who): Message[] {
  const chronological = [...events].sort((a, b) => a.origin_server_ts - b.origin_server_ts);
  const reactions = reactionsOf(chronological, me, who);
  const edits = new Map<string, MatrixEvent>();
  const replies = new Map<string, MatrixEvent[]>();
  for (const e of chronological) {
    const r = relation(e);
    if (r.rel_type === "m.replace" && r.event_id) edits.set(r.event_id, e);
    if (r.rel_type === "m.thread" && r.event_id && SHOWN.has(e.type)) replies.set(r.event_id, [...(replies.get(r.event_id) ?? []), e]);
  }
  const out: Message[] = [];
  for (const e of chronological) {
    if (!SHOWN.has(e.type)) continue;
    const r = relation(e);
    if (r.rel_type === "m.replace" || r.rel_type === "m.thread") continue;
    const edit = edits.get(e.event_id);
    const withEdit =
      edit && !e.unsigned?.["m.relations"]?.["m.replace"]
        ? { ...e, unsigned: { ...e.unsigned, "m.relations": { ...e.unsigned?.["m.relations"], "m.replace": edit } } }
        : e;
    const m = toMessage(withEdit, me, who);
    m.reactions = reactions.get(e.event_id) ?? [];
    const seen = replies.get(e.event_id) ?? [];
    if (seen.length || m.thread) {
      const people = [...new Set([...seen.map((x) => x.sender), ...(m.thread?.participants.map((p) => p.userId) ?? [])])];
      const last = seen.at(-1);
      m.thread = {
        count: Math.max(m.thread?.count ?? 0, seen.length),
        lastTs: m.thread?.lastTs ?? (last ? new Date(last.origin_server_ts).toISOString() : null),
        participants: people.slice(0, 3).map((p) => senderOf(p, who)),
      };
    }
    out.push(m);
  }
  return out;
}

/** "@Jane Doe" in a message becomes a mention Matrix apps notify: m.mentions and a link in the formatted body. */
export function withMentions(text: string, members: Array<{ userId: string; name: string }>): Record<string, unknown> {
  const userIds: string[] = [];
  let html = escapeHtml(text);
  const byLength = [...members].filter((m) => m.name).sort((a, b) => b.name.length - a.name.length);
  for (const m of byLength) {
    const at = `@${m.name}`;
    if (!text.includes(at)) continue;
    userIds.push(m.userId);
    html = html.split(escapeHtml(at)).join(`<a href="https://matrix.to/#/${encodeURIComponent(m.userId)}">${escapeHtml(m.name)}</a>`);
  }
  const room = /(^|\s)@(here|room|channel)\b/.test(text);
  const content: Record<string, unknown> = {
    msgtype: "m.text",
    body: text,
    "m.mentions": { ...(userIds.length && { user_ids: userIds }), ...(room && { room: true }) },
  };
  if (userIds.length) Object.assign(content, { format: "org.matrix.custom.html", formatted_body: html.replace(/\n/g, "<br>") });
  return content;
}

export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
