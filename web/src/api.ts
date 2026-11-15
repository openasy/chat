// The UI is an ordinary client of the public API (ADR 0014, 0018). Types follow openapi.json; the messages themselves
// are on the Matrix server, and every conversation route acts there as the signed-in person.

/** Another OpenAsy product of this install, from OPENASY_PRODUCTS. */
export interface ProductLink {
  id: string;
  url: string;
}

export type Role = "user" | "viewer" | "editor" | "admin" | "owner";
export type Kind = "public" | "private" | "guests" | "incident" | "dm";
export type Presence = "online" | "away" | "busy" | "offline";
export type Severity = "critical" | "high" | "medium" | "low" | "info";
export type Tone = "success" | "warning" | "danger" | "info" | "neutral";

export interface Me {
  userId: string;
  email: string;
  name: string;
  role: Role;
  homeserver: string;
  serverName: string;
}

export interface Sender {
  userId: string;
  name: string;
  app: string | null;
  guest: boolean;
}

export interface FileRef {
  uri: string;
  name: string;
  size: number | null;
  type: string | null;
}

export interface Card {
  title: string;
  severity: Severity | null;
  status: { label: string; tone: Tone } | null;
  fields: Array<[string, string]>;
  link: { label: string; url: string } | null;
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
  encrypted: boolean;
  file: FileRef | null;
  card: Card | null;
  reactions: Reaction[];
  thread: { count: number; lastTs: string | null; participants: Sender[] } | null;
  threadRoot: string | null;
  mentionsMe: boolean;
}

export interface Conversation {
  id: string;
  name: string;
  kind: Kind;
  topic: string | null;
  members: number;
  unread: number;
  mentions: number;
  encrypted: boolean;
  guestsAllowed: boolean;
  with: Sender[];
  lastTs: string | null;
  invited: boolean;
}

export interface ConversationDetail {
  id: string;
  name: string;
  alias: string | null;
  kind: Kind;
  topic: string | null;
  members: number;
  someMembers: Sender[];
  with: Sender[];
  from: string;
  managedBy: "file" | "people" | "api";
  reference: string | null;
  retention: string;
  hold: string | null;
  guestsAllowed: boolean;
  guests: Array<{ id: string; name: string; company: string | null; endsAt: string; invitedBy: string }>;
  encrypted: boolean;
  canPost: boolean;
  pinned: Message[];
}

export interface Thread {
  root: Message;
  replies: Message[];
}

export interface RoomRef {
  id: string;
  name: string;
  kind: Kind;
}

export interface SearchResults {
  messages: Array<Message & { room: RoomRef }>;
  files: Array<{ id: string; file: FileRef; room: RoomRef; sender: Sender; ts: string }>;
  count: number;
}

export interface Person {
  userId: string;
  name: string;
  email: string | null;
  presence: Presence;
  status: string | null;
  timeZone: string | null;
  groups: string[];
  channels: number;
  guest: { id: string; company: string | null; channel: string; roomId: string; invitedBy: string; endsAt: string; welcomed: boolean } | null;
  me: boolean;
}

export interface People {
  source: "identity" | "matrix";
  people: Person[];
  leaving: Array<{ name: string; email: string; channels: number }>;
}

export interface FileEntry {
  name: string;
  topic: string | null;
  private: boolean;
  members: string[];
  admins: string[];
  retention: string;
  guests: boolean;
  posts: "everyone" | "admins";
}

export interface AdminChannel {
  id: string;
  name: string;
  alias: string | null;
  kind: Exclude<Kind, "dm">;
  topic: string | null;
  members: number;
  from: string;
  managedBy: "file" | "people" | "api";
  by: string | null;
  reference: string | null;
  retention: string;
  hold: string | null;
  guests: boolean;
  guestCount: number;
  posts: "everyone" | "admins";
  encrypted: boolean;
  entry: FileEntry | null;
}

export interface Channels {
  channels: AdminChannel[];
  totals: { channels: number; fromFile: number; private: number; withGuests: number; guests: number; files: number | null; messages: number | null };
}

export interface Export {
  id: string;
  reference: string;
  channel: string;
  roomId: string;
  from: string;
  to: string;
  senders: string[];
  startedBy: string;
  startedAt: string;
  finishedAt: string | null;
  state: "running" | "ready" | "failed";
  messages: number;
  files: number;
  bytes: number;
  sha256: string | null;
  error: string | null;
  hold: { id: string; released: boolean } | null;
}

export interface FileState {
  path: string;
  appliedAt: string | null;
  channels: number;
  apps: number;
  error: string | null;
  text: string | null;
}

export interface SyncResult {
  at: string;
  ok: boolean;
  created: string[];
  updated: string[];
  removed: string[];
  released: string[];
  warnings: string[];
  error: string | null;
}

export interface Config {
  channels: FileEntry[];
  apps: Array<{ name: string; channels: string[] }>;
  defaults: { retention: string };
  guests: { days: number };
  file: FileState | null;
}

export interface Summary {
  channels: number;
  apps: number;
  file: FileState | null;
  sync: SyncResult | null;
  homeserver: string;
}

export interface Integrations {
  matrix: { homeserver: string; serverName: string | null; version: string | null; ok: boolean; user: string | null };
  identity: { configured: boolean; ok: boolean; error: string | null; people: number; at: string | null };
  apps: Array<{ name: string; userId: string | null; channels: string[]; hook: { createdAt: string; usedAt: string | null } | null }>;
}

export class Unauthorized extends Error {}
/** The signed-in owner or admin has no second factor yet; the sign-in gate asks for one. */
export class MfaSetupRequired extends Error {}
export class ApiError extends Error {
  status: number;
  code: string;
  constructor(message: string, status: number, code = "") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// The session is an HttpOnly cookie set by sign-in (@openasy/auth); the browser sends it, nothing is stored here.
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { ...(typeof init.body === "string" ? { "content-type": "application/json" } : {}), ...init.headers },
  });
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { code?: string; detail?: string };
    if (res.status === 401) throw new Unauthorized(problem.detail);
    if (problem.code === "mfa-setup-required") throw new MfaSetupRequired(problem.detail);
    throw new ApiError(problem.detail ?? `${path}: ${res.status}`, res.status, problem.code);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}
