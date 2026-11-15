// What the routes call: keeping the Matrix server in step with the file, a person's conversations, messages, threads,
// reactions, files and search, the people and guests, the channels with their retention and legal holds, exports for
// a legal request, and the apps' webhooks. The messages stay on the Matrix server; Chat keeps none of them.
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject, createPrivateKey, createPublicKey } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join as pathJoin } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { appSlug, EMPTY, parseRetention, retentionText, type ChatConfig, type ConfigFileState, type Retention } from "./config.ts";
import type { Directory, DirectoryPerson } from "./identity.ts";
import { log } from "./log.ts";
import { MatrixError, seg, type AdminRoom, type AdminUser, type Matrix, type MatrixEvent } from "./matrix.ts";
import { CARD, cardOf, reactionsOf, senderOf, timeline, toMessage, withMentions, type Message, type Who } from "./messages.ts";
import { localpartOf, MARK, retentionContent, retentionOf, ROOM_VERSION, SPACE, stateMap, sync, userIdOf, type Mark, type SyncResult } from "./sync.ts";
import { zip } from "./zip.ts";

export type ProblemCode =
  | "invalid-token"
  | "invalid-json"
  | "invalid-body"
  | "forbidden"
  | "not-found"
  | "conflict"
  | "encrypted"
  | "matrix-unavailable"
  | "payload-too-large"
  | "internal-error";

export class ChatError extends Error {
  readonly status: number;
  readonly code: ProblemCode;
  constructor(status: number, code: ProblemCode, detail: string) {
    super(detail);
    this.status = status;
    this.code = code;
  }
}

export interface ChatOptions {
  /** The address people open Chat at, for guests' welcome links and the apps' webhook addresses. */
  publicUrl: string;
  /** Where Element and other Matrix apps reach the server: its public https address. */
  homeserverUrl: string;
  /** People's names, groups and leavers from Identity, when it is set up (CHAT_IDENTITY_URL). */
  directory?: Directory;
  /** The company's name, for the company space. */
  organization?: string;
  /** Where export archives are written: a folder next to the database. */
  dataDir: string;
  clock?: () => number;
  fileState?: () => ConfigFileState | null;
}

export type Kind = "public" | "private" | "guests" | "incident" | "dm";

export interface Person {
  userId: string;
  email: string | null;
  name: string;
}

const DAY = 86_400_000;
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() && v.trim().length <= max ? v.trim() : null);
const bad = (detail: string) => new ChatError(422, "invalid-body", detail);
const EMAIL = /^[a-z0-9._%+-]+@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** At most `n` of the calls at once, so a page of people does not ask the server hundreds of things together. */
async function limited<T, R>(items: T[], n: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = Array.from({ length: items.length });
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await work(items[k]!);
      }
    }),
  );
  return out;
}

export function createChat(db: DatabaseSync, matrix: Matrix, opts: ChatOptions) {
  const { publicUrl, homeserverUrl, directory, organization = "Company", dataDir, clock = Date.now, fileState = () => null } = opts;
  let config: ChatConfig = structuredClone(EMPTY);
  let last: SyncResult | null = null;
  let running: Promise<SyncResult> | null = null;
  let again = false;
  let identity: { ok: boolean; error: string | null; people: number; at: string | null } = { ok: false, error: null, people: 0, at: null };
  const ensured = new Set<string>();
  const exportsRunning = new Set<Promise<void>>();
  let usersCache: { users: AdminUser[]; until: number } | null = null;
  const stateCache = new Map<string, { state: Map<string, MatrixEvent>; members: string[]; until: number }>();
  const profileCache = new Map<string, { tz: string | null; until: number }>();

  const insertRun = db.prepare("INSERT INTO sync_runs (at, ok, created, updated, released, warnings, error) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const now = () => new Date(clock());

  /** Matrix's failures as a problem the pages can show; other errors go up as they are. */
  async function server<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      if (!(err instanceof MatrixError)) throw err;
      if (err.status === 403) throw new ChatError(403, "forbidden", err.message);
      if (err.status === 404) throw new ChatError(404, "not-found", err.message);
      if (err.status === 409 || err.errcode === "M_ROOM_IN_USE") throw new ChatError(409, "conflict", err.message);
      if (err.status === 400 || err.status === 413) throw new ChatError(422, "invalid-body", err.message);
      log("warn", "Matrix server call failed", { error: err.message, status: err.status, errcode: err.errcode });
      throw new ChatError(502, "matrix-unavailable", "The Matrix server did not answer; try again in a moment.");
    }
  }
  const ready = () => {
    try {
      return matrix.serverName && matrix.serviceToken;
    } catch {
      throw new ChatError(502, "matrix-unavailable", "Chat is not connected to the Matrix server yet; see the log.");
    }
  };

  // ------------------------------------------------------------------ the file, the directory and the sync

  async function people(): Promise<DirectoryPerson[] | null> {
    if (!directory) return null;
    try {
      const list = await directory.people();
      identity = { ok: true, error: null, people: list.filter((p) => !p.disabled).length, at: now().toISOString() };
      return list;
    } catch (err) {
      identity = { ...identity, ok: false, error: (err as Error).message };
      throw err;
    }
  }

  const activeGuests = () =>
    db.prepare("SELECT user_id AS userId, room_id AS roomId FROM guests WHERE ended_at IS NULL").all() as Array<{ userId: string; roomId: string }>;
  const heldRooms = () =>
    new Set((db.prepare("SELECT DISTINCT room_id FROM holds WHERE released_at IS NULL").all() as Array<{ room_id: string }>).map((r) => r.room_id));

  /** Guests whose access ended are deactivated: out of their channel and signed out. */
  async function endGuests() {
    const due = db.prepare("SELECT id, user_id FROM guests WHERE ended_at IS NULL AND ends_at <= ?").all(now().toISOString()) as Array<{
      id: string;
      user_id: string;
    }>;
    for (const g of due) {
      await matrix.deactivate(g.user_id).catch((err: unknown) => {
        if (!(err instanceof MatrixError && err.status === 404)) throw err;
      });
      db.prepare("UPDATE guests SET ended_at = ? WHERE id = ?").run(now().toISOString(), g.id!);
      log("info", "guest access ended", { guest: g.user_id });
    }
  }

  /** Brings the server in step with the file; a call while one runs makes it run once more after. */
  function syncNow(): Promise<SyncResult> {
    if (running) {
      again = true;
      return running;
    }
    running = (async (): Promise<SyncResult> => {
      try {
        ready();
        await endGuests();
        return await sync(matrix, { config, people: await people(), guests: activeGuests(), held: heldRooms(), organization, now });
      } catch (err) {
        return { at: now().toISOString(), ok: false, created: [], updated: [], removed: [], released: [], warnings: [], error: (err as Error).message };
      }
    })()
      .then((r) => {
        last = r;
        usersCache = null;
        stateCache.clear();
        insertRun.run(r.at, r.ok ? 1 : 0, r.created.length, r.updated.length, r.released.length, r.warnings.length, r.error);
        db.prepare("DELETE FROM sync_runs WHERE id NOT IN (SELECT id FROM sync_runs ORDER BY id DESC LIMIT 100)").run();
        if (r.ok && (r.created.length || r.updated.length || r.removed.length || r.released.length))
          log("info", "Matrix server updated from the file", { created: r.created, updated: r.updated, removed: r.removed, released: r.released });
        else if (!r.ok) log("warn", "Matrix server not updated; trying again in five minutes", { error: r.error });
        if (r.warnings.length) log("warn", "the chat file names what the server or the directory does not have", { warnings: r.warnings });
        return r;
      })
      .finally(() => {
        running = null;
        if (again) ((again = false), void syncNow());
      });
    return running;
  }

  // ------------------------------------------------------------------ who is who

  async function users(): Promise<AdminUser[]> {
    if (usersCache && usersCache.until > clock()) return usersCache.users;
    const list = await matrix.users();
    usersCache = { users: list, until: clock() + 60_000 };
    return list;
  }

  async function who(): Promise<Who & { users: AdminUser[] }> {
    const list = await users();
    const names = new Map(list.map((u) => [u.name, u.displayname ?? u.name]));
    const apps = new Map(config.apps.map((a) => [`@${appSlug(a.name)}:${matrix.serverName}`, a.name]));
    const guests = new Set((db.prepare("SELECT user_id FROM guests").all() as Array<{ user_id: string }>).map((g) => g.user_id));
    return {
      users: list,
      name: (id) => apps.get(id) ?? names.get(id) ?? id.slice(1, id.indexOf(":")),
      app: (id) => apps.get(id) ?? (list.find((u) => u.name === id)?.user_type === "bot" ? (names.get(id) ?? null) : null),
      guest: (id) => guests.has(id),
    };
  }

  /** The signed-in person's Matrix account, made the first time they open Chat when Identity has not made it yet. */
  async function person(email: string, name?: string): Promise<string> {
    ready();
    const userId = userIdOf(email, matrix.serverName);
    if (ensured.has(userId)) return userId;
    await server(async () => {
      try {
        const u = await matrix.svc<{ deactivated?: boolean }>("GET", `/_synapse/admin/v2/users/${seg(userId)}`);
        if (u.deactivated) throw new ChatError(403, "forbidden", "Your chat account is turned off; ask an admin.");
      } catch (err) {
        if (!(err instanceof MatrixError && err.status === 404)) throw err;
        await matrix.putUser(userId, { displayname: name || email, threepids: [{ medium: "email", address: email }] });
        usersCache = null;
        const spaceId = await matrix.roomIdOf(`#${SPACE}:${matrix.serverName}`);
        if (spaceId) await matrix.forceJoin(spaceId, userId).catch(() => {});
      }
    });
    ensured.add(userId);
    return userId;
  }

  /** A room's state and members as the service account reads them, kept a minute. */
  async function roomInfo(roomId: string) {
    const have = stateCache.get(roomId);
    if (have && have.until > clock()) return have;
    const [state, members] = await Promise.all([matrix.roomState(roomId), matrix.roomMembers(roomId)]);
    const info = { state: stateMap(state), members, until: clock() + 60_000 };
    stateCache.set(roomId, info);
    return info;
  }

  /** The service account joins a room someone else made, with the highest power, to set its rules. */
  async function serviceIn(roomId: string) {
    const { members } = await roomInfo(roomId);
    if (members.includes(matrix.serviceUser)) return;
    await matrix.makeRoomAdmin(roomId);
    await matrix.svc("POST", `/_matrix/client/v3/join/${seg(roomId)}`, { body: {} }).catch(() => {});
    stateCache.delete(roomId);
  }

  const markOf = (state: Map<string, MatrixEvent>) => state.get(`${MARK}|`)?.content as Mark | undefined;
  const activeGuestsIn = (roomId: string) =>
    db.prepare("SELECT * FROM guests WHERE room_id = ? AND ended_at IS NULL ORDER BY name").all(roomId) as Array<Record<string, string | null>>;

  function kindOf(state: Map<string, MatrixEvent>, direct: Set<string>, roomId: string): Kind | "space" {
    if (state.get("m.room.create|")?.content.type === "m.space") return "space";
    const mark = markOf(state);
    if (mark?.kind === "incident") return "incident";
    if (direct.has(roomId) || (!mark && !state.get("m.room.name|")?.content.name && !state.get("m.room.canonical_alias|")?.content.alias)) return "dm";
    if (mark?.guests && activeGuestsIn(roomId).length) return "guests";
    return state.get("m.room.join_rules|")?.content.join_rule === "invite" ? "private" : "public";
  }

  function fromText(mark: Mark | undefined): string {
    if (!mark) return "By its members";
    if (mark.managedBy === "file") return mark.members?.length ? mark.members.join(", ") : "Joined by choice";
    if (mark.managedBy === "api") return `Opened by ${mark.by ?? "an app"}`;
    return "By its members";
  }

  // ------------------------------------------------------------------ conversations

  const syncFilter = (timelineLimit: number) =>
    JSON.stringify({
      room: { timeline: { limit: timelineLimit }, state: { lazy_load_members: true }, ephemeral: { not_types: ["*"] }, account_data: { not_types: ["*"] } },
      presence: { not_types: ["*"] },
      account_data: { types: ["m.direct"] },
    });

  async function conversations(email: string, name?: string) {
    const me = await person(email, name);
    return server(async () => {
      const w = await who();
      const s = await matrix.as<any>(me, "GET", "/_matrix/client/v3/sync", { query: { filter: syncFilter(1), timeout: 0 } });
      const directEvent = (s.account_data?.events ?? []).find((e: MatrixEvent) => e.type === "m.direct");
      const direct = new Set<string>(Object.values((directEvent?.content ?? {}) as Record<string, string[]>).flat());
      const out = [];
      for (const [roomId, room] of Object.entries((s.rooms?.join ?? {}) as Record<string, any>)) {
        const state = stateMap([...(room.state?.events ?? []), ...(room.timeline?.events ?? []).filter((e: MatrixEvent) => e.state_key !== undefined)]);
        const kind = kindOf(state, direct, roomId);
        if (kind === "space") continue;
        const heroes: string[] = (room.summary?.["m.heroes"] ?? []).filter((h: string) => h !== me);
        const lastEvent = (room.timeline?.events ?? []).at(-1) as MatrixEvent | undefined;
        out.push({
          id: roomId,
          name:
            kind === "dm"
              ? heroes.map((h) => w.name(h)).join(", ") || (state.get("m.room.name|")?.content.name ?? "")
              : (state.get("m.room.name|")?.content.name ?? roomId),
          kind,
          topic: state.get("m.room.topic|")?.content.topic ?? null,
          members: room.summary?.["m.joined_member_count"] ?? 0,
          unread: room.unread_notifications?.notification_count ?? 0,
          mentions: room.unread_notifications?.highlight_count ?? 0,
          encrypted: state.has("m.room.encryption|"),
          guestsAllowed: !!markOf(state)?.guests,
          with: kind === "dm" ? heroes.map((h) => senderOf(h, w)) : [],
          lastTs: lastEvent ? new Date(lastEvent.origin_server_ts).toISOString() : null,
          invited: false,
        });
      }
      for (const [roomId, room] of Object.entries((s.rooms?.invite ?? {}) as Record<string, any>)) {
        const state = stateMap(room.invite_state?.events ?? []);
        const inviter = [...state.values()].find((e) => e.type === "m.room.member" && e.state_key === me)?.sender;
        const named = state.get("m.room.name|")?.content.name as string | undefined;
        out.push({
          id: roomId,
          name: named ?? (inviter ? w.name(inviter) : roomId),
          kind: (named ? "private" : "dm") as Kind,
          topic: null,
          members: 0,
          unread: 1,
          mentions: 0,
          encrypted: state.has("m.room.encryption|"),
          guestsAllowed: false,
          with: !named && inviter ? [senderOf(inviter, w)] : [],
          lastTs: null,
          invited: true,
        });
      }
      out.sort((a, b) =>
        a.kind === "dm" && b.kind === "dm"
          ? (b.lastTs ?? "").localeCompare(a.lastTs ?? "")
          : a.kind === "dm"
            ? 1
            : b.kind === "dm"
              ? -1
              : a.name.localeCompare(b.name),
      );
      return { userId: me, conversations: out };
    });
  }

  async function conversation(email: string, roomId: string) {
    const me = await person(email);
    return server(async () => {
      const w = await who();
      const events = await matrix.as<MatrixEvent[]>(me, "GET", `/_matrix/client/v3/rooms/${seg(roomId)}/state`);
      const state = stateMap(events);
      const directEvent = await matrix.as<Record<string, string[]>>(me, "GET", `/_matrix/client/v3/user/${seg(me)}/account_data/m.direct`).catch(() => ({}));
      const direct = new Set(Object.values(directEvent).flat());
      const kind = kindOf(state, direct, roomId);
      if (kind === "space") throw new ChatError(404, "not-found", "That is the company space, not a conversation.");
      const joined = [...state.values()].filter((e) => e.type === "m.room.member" && e.content.membership === "join").map((e) => e.state_key!);
      const mark = markOf(state);
      const pl = state.get("m.room.power_levels|")?.content ?? {};
      const myLevel = pl.users?.[me] ?? pl.users_default ?? 0;
      const needed = pl.events?.["m.room.message"] ?? pl.events_default ?? 0;
      const pinnedIds: string[] = (state.get("m.room.pinned_events|")?.content.pinned ?? []).slice(0, 10);
      const pinned = (
        await Promise.all(
          pinnedIds.map((id) =>
            matrix
              .as<MatrixEvent>(me, "GET", `/_matrix/client/v3/rooms/${seg(roomId)}/event/${seg(id)}`)
              .then((e) => toMessage(e, me, w))
              .catch(() => null),
          ),
        )
      ).filter((m): m is Message => !!m);
      const hold = db.prepare("SELECT reference FROM holds WHERE room_id = ? AND released_at IS NULL ORDER BY placed_at LIMIT 1").get(roomId) as
        { reference: string } | undefined;
      const others = joined.filter((id) => id !== me);
      return {
        id: roomId,
        name: kind === "dm" ? others.map((h) => w.name(h)).join(", ") : (state.get("m.room.name|")?.content.name ?? roomId),
        alias: (state.get("m.room.canonical_alias|")?.content.alias as string | undefined) ?? null,
        kind,
        topic: state.get("m.room.topic|")?.content.topic ?? null,
        members: joined.length,
        someMembers: others.slice(0, 3).map((id) => senderOf(id, w)),
        with: kind === "dm" ? others.map((id) => senderOf(id, w)) : [],
        from: kind === "dm" ? "" : fromText(mark),
        managedBy: mark?.managedBy ?? "people",
        reference: mark?.reference ?? null,
        retention: retentionText(retentionOf(state.get("m.room.retention|")?.content)),
        hold: hold?.reference ?? null,
        guestsAllowed: !!mark?.guests,
        guests: activeGuestsIn(roomId).map((g) => ({ id: g.id!, name: g.name!, company: g.company, endsAt: g.ends_at!, invitedBy: w.name(g.invited_by!) })),
        encrypted: state.has("m.room.encryption|"),
        canPost: myLevel >= needed,
        pinned,
      };
    });
  }

  async function messages(email: string, roomId: string, before: string | null) {
    const me = await person(email);
    return server(async () => {
      const w = await who();
      const r = await matrix.as<{ chunk: MatrixEvent[]; end?: string }>(me, "GET", `/_matrix/client/v3/rooms/${seg(roomId)}/messages`, {
        query: { dir: "b", limit: 80, from: before ?? undefined },
      });
      return { messages: timeline(r.chunk, me, w), before: r.end ?? null };
    });
  }

  async function thread(email: string, roomId: string, rootId: string) {
    const me = await person(email);
    return server(async () => {
      const w = await who();
      const root = await matrix.as<MatrixEvent>(me, "GET", `/_matrix/client/v3/rooms/${seg(roomId)}/event/${seg(rootId)}`);
      const rel = await matrix.as<{ chunk: MatrixEvent[] }>(me, "GET", `/_matrix/client/v1/rooms/${seg(roomId)}/relations/${seg(rootId)}/m.thread`, {
        query: { dir: "f", limit: 200 },
      });
      const replies = rel.chunk.filter((e) => e.type === "m.room.message" || e.type === "m.room.encrypted");
      const annotations = await limited([root, ...replies].slice(0, 60), 6, (e) =>
        matrix
          .as<{ chunk: MatrixEvent[] }>(me, "GET", `/_matrix/client/v1/rooms/${seg(roomId)}/relations/${seg(e.event_id)}/m.annotation/m.reaction`, {
            query: { limit: 100 },
          })
          .then((x) => x.chunk)
          .catch(() => []),
      );
      const reactions = reactionsOf(annotations.flat(), me, w);
      const shown = (e: MatrixEvent) => ({ ...toMessage(e, me, w), reactions: reactions.get(e.event_id) ?? [] });
      return { root: { ...shown(root), thread: null }, replies: replies.sort((a, b) => a.origin_server_ts - b.origin_server_ts).map(shown) };
    });
  }

  async function members(me: string, roomId: string) {
    const r = await matrix.as<{ joined: Record<string, { display_name?: string }> }>(me, "GET", `/_matrix/client/v3/rooms/${seg(roomId)}/joined_members`);
    return Object.entries(r.joined).map(([userId, m]) => ({ userId, name: m.display_name ?? "" }));
  }

  async function send(email: string, roomId: string, body: unknown) {
    const me = await person(email);
    const b = (body ?? {}) as { text?: unknown; threadRoot?: unknown; alsoInChannel?: unknown; file?: unknown };
    const text = typeof b.text === "string" ? b.text.trim() : "";
    if (text.length > 20_000) throw bad("text is at most 20000 characters.");
    const file = b.file as { uri?: unknown; name?: unknown; size?: unknown; type?: unknown } | undefined;
    if (file !== undefined && (typeof file?.uri !== "string" || !file.uri.startsWith("mxc://") || typeof file.name !== "string"))
      throw bad("file is { uri, name, size, type } from POST /api/v1/files.");
    if (!text && !file) throw bad("A message needs text or a file.");
    const threadRoot = b.threadRoot === undefined || b.threadRoot === null ? null : str(b.threadRoot, 255);
    if (b.threadRoot && !threadRoot) throw bad("threadRoot is the id of the thread's first message.");
    return server(async () => {
      const w = await who();
      let content: Record<string, unknown> = withMentions(text, await members(me, roomId));
      if (file) {
        const type = typeof file.type === "string" ? file.type : "application/octet-stream";
        content = {
          ...content,
          msgtype: type.startsWith("image/") ? "m.image" : "m.file",
          body: text || file.name,
          filename: file.name,
          url: file.uri,
          info: { mimetype: type, ...(typeof file.size === "number" && { size: file.size }) },
        };
      }
      const put = (c: Record<string, unknown>) =>
        matrix.as<{ event_id: string }>(me, "PUT", `/_matrix/client/v3/rooms/${seg(roomId)}/send/m.room.message/${matrix.txn()}`, { body: c });
      let sent: { event_id: string };
      if (threadRoot) {
        const latest = await matrix
          .as<{ chunk: MatrixEvent[] }>(me, "GET", `/_matrix/client/v1/rooms/${seg(roomId)}/relations/${seg(threadRoot)}/m.thread`, { query: { limit: 1 } })
          .then((r) => r.chunk[0]?.event_id ?? threadRoot);
        sent = await put({
          ...content,
          "m.relates_to": { rel_type: "m.thread", event_id: threadRoot, is_falling_back: true, "m.in_reply_to": { event_id: latest } },
        });
        if (b.alsoInChannel === true) await put({ ...content, "m.relates_to": { "m.in_reply_to": { event_id: threadRoot } } });
      } else sent = await put(content);
      const e = await matrix.as<MatrixEvent>(me, "GET", `/_matrix/client/v3/rooms/${seg(roomId)}/event/${seg(sent.event_id)}`);
      return toMessage(e, me, w);
    });
  }

  /** Adds the person's reaction, or takes it back when it is there. */
  async function react(email: string, roomId: string, eventId: string, body: unknown) {
    const me = await person(email);
    const emoji = str((body as { emoji?: unknown } | null)?.emoji, 32);
    if (!emoji) throw bad("emoji is the reaction, such as 👍.");
    return server(async () => {
      const w = await who();
      const path = `/_matrix/client/v1/rooms/${seg(roomId)}/relations/${seg(eventId)}/m.annotation/m.reaction`;
      const before = (await matrix.as<{ chunk: MatrixEvent[] }>(me, "GET", path, { query: { limit: 200 } })).chunk;
      const mine = before.find((e) => e.sender === me && e.content?.["m.relates_to"]?.key === emoji && !e.unsigned?.redacted_because);
      if (mine) await matrix.as(me, "PUT", `/_matrix/client/v3/rooms/${seg(roomId)}/redact/${seg(mine.event_id)}/${matrix.txn()}`, { body: {} });
      else
        await matrix.as(me, "PUT", `/_matrix/client/v3/rooms/${seg(roomId)}/send/m.reaction/${matrix.txn()}`, {
          body: { "m.relates_to": { rel_type: "m.annotation", event_id: eventId, key: emoji } },
        });
      const after = (await matrix.as<{ chunk: MatrixEvent[] }>(me, "GET", path, { query: { limit: 200 } })).chunk;
      return { reactions: reactionsOf(after, me, w).get(eventId) ?? [] };
    });
  }

  async function markRead(email: string, roomId: string, body: unknown) {
    const me = await person(email);
    const eventId = str((body as { eventId?: unknown } | null)?.eventId, 255);
    if (!eventId) throw bad("eventId is the latest message seen.");
    await server(() => matrix.as(me, "POST", `/_matrix/client/v3/rooms/${seg(roomId)}/read_markers`, { body: { "m.fully_read": eventId, "m.read": eventId } }));
  }

  async function join(email: string, roomId: string) {
    const me = await person(email);
    await server(() => matrix.as(me, "POST", `/_matrix/client/v3/join/${seg(roomId)}`, { body: {} }));
  }

  async function leave(email: string, roomId: string) {
    const me = await person(email);
    await server(() => matrix.as(me, "POST", `/_matrix/client/v3/rooms/${seg(roomId)}/leave`, { body: {} }));
  }

  /** A direct conversation with one or more people: the existing one with the same person, or a new one. */
  async function direct(email: string, body: unknown) {
    const me = await person(email);
    const list = (body as { people?: unknown } | null)?.people;
    if (!Array.isArray(list) || !list.length || list.length > 20 || list.some((p) => typeof p !== "string" || !/^@[^:]+:.+$/.test(p)))
      throw bad("people is a list of up to 20 Matrix user ids, such as @jane:example.com.");
    const others = [...new Set(list as string[])].filter((p) => p !== me);
    if (!others.length) throw bad("people names someone other than you.");
    return server(async () => {
      const directMap = await matrix
        .as<Record<string, string[]>>(me, "GET", `/_matrix/client/v3/user/${seg(me)}/account_data/m.direct`)
        .catch(() => ({}) as Record<string, string[]>);
      if (others.length === 1) {
        const joined = new Set((await matrix.as<{ joined_rooms: string[] }>(me, "GET", "/_matrix/client/v3/joined_rooms")).joined_rooms);
        const existing = (directMap[others[0]!] ?? []).find((r) => joined.has(r));
        if (existing) return { id: existing, created: false };
      }
      const r = await matrix.as<{ room_id: string }>(me, "POST", "/_matrix/client/v3/createRoom", {
        body: { is_direct: true, invite: others, preset: "trusted_private_chat", room_version: ROOM_VERSION },
      });
      const next = { ...directMap };
      for (const o of others) next[o] = [...(next[o] ?? []), r.room_id];
      await matrix.as(me, "PUT", `/_matrix/client/v3/user/${seg(me)}/account_data/m.direct`, { body: next });
      return { id: r.room_id, created: true };
    });
  }

  async function upload(email: string, type: string, name: string, data: Buffer) {
    const me = await person(email);
    if (!data.length) throw bad("The file is empty.");
    return server(async () => {
      const r = await matrix.as<{ content_uri: string }>(me, "POST", "/_matrix/media/v3/upload", { raw: data, type, query: { filename: name } });
      return { uri: r.content_uri, name, size: data.length, type };
    });
  }

  async function download(email: string, serverName: string, mediaId: string) {
    const me = await person(email);
    return server(async () => matrix.download(`/_matrix/client/v1/media/download/${seg(serverName)}/${seg(mediaId)}`, await matrix.tokenFor(me)));
  }

  /** Public channels of the company, with whether the person is in each, for joining. */
  async function browse(email: string) {
    const me = await person(email);
    return server(async () => {
      // Channels open to the company are restricted to the company space, and Synapse's room directory lists only rooms
      // anyone may join: they are read from the space's rooms instead, as the service account, which is in every one.
      type Room = {
        room_id: string;
        name?: string;
        topic?: string;
        num_joined_members: number;
        canonical_alias?: string;
        join_rule?: string;
        room_type?: string;
      };
      const spaceId = await matrix.roomIdOf(`#${SPACE}:${matrix.serverName}`);
      const rooms: Room[] = [];
      for (let from: string | undefined, i = 0; spaceId && i < 20; i++) {
        const page = await matrix.svc<{ rooms: Room[]; next_batch?: string }>("GET", `/_matrix/client/v1/rooms/${seg(spaceId)}/hierarchy`, {
          query: { max_depth: 1, limit: 100, ...(from && { from }) },
        });
        rooms.push(...page.rooms);
        if (!page.next_batch) break;
        from = page.next_batch;
      }
      const open = rooms.filter((c) => c.room_id !== spaceId && c.room_type !== "m.space" && (c.join_rule === "restricted" || c.join_rule === "public"));
      const joined = new Set((await matrix.as<{ joined_rooms: string[] }>(me, "GET", "/_matrix/client/v3/joined_rooms")).joined_rooms);
      return {
        channels: open
          .map((c) => ({
            id: c.room_id,
            name: c.name ?? c.canonical_alias ?? c.room_id,
            topic: c.topic ?? null,
            members: c.num_joined_members,
            joined: joined.has(c.room_id),
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
    });
  }

  /** A channel made by a person for themselves, or by a product with an API token, such as Incidents. */
  async function createChannel(actor: { email: string; name?: string } | { token: string }, body: unknown) {
    ready();
    const b = (body ?? {}) as { name?: unknown; topic?: unknown; private?: unknown; members?: unknown; reference?: unknown; kind?: unknown };
    const name = typeof b.name === "string" ? b.name.trim().replace(/^#/, "").toLowerCase() : "";
    if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(name)) throw bad("name is lowercase letters, digits, dots, dashes and underscores, such as project-atlas.");
    if (config.channels.some((c) => c.name === name)) throw new ChatError(409, "conflict", `#${name} is a channel of the chat file.`);
    const topic = b.topic === undefined || b.topic === null ? null : str(b.topic, 500);
    if (b.topic && !topic) throw bad("topic is text of up to 500 characters.");
    if (b.private !== undefined && typeof b.private !== "boolean") throw bad("private is true or false.");
    const members = b.members === undefined ? [] : b.members;
    if (!Array.isArray(members) || members.length > 500 || members.some((m) => typeof m !== "string" || !EMAIL.test(m.toLowerCase())))
      throw bad("members is a list of up to 500 email addresses.");
    if (b.kind !== undefined && b.kind !== "incident") throw bad("kind is incident, or left out.");
    const reference = b.reference === undefined ? null : str(b.reference, 64);
    if (b.reference !== undefined && !reference) throw bad("reference is text of up to 64 characters, such as INC-2041.");
    const isToken = "token" in actor;
    const creator = isToken ? matrix.serviceUser : await person(actor.email, actor.name);
    return server(async () => {
      const spaceId = await matrix.roomIdOf(`#${SPACE}:${matrix.serverName}`);
      const priv = b.private === true;
      const mark: Mark = isToken
        ? {
            managedBy: "api",
            by: actor.token,
            guests: false,
            posts: "everyone",
            ...(reference && { reference }),
            ...(b.kind === "incident" && { kind: "incident" }),
          }
        : { managedBy: "people", guests: false, posts: "everyone" };
      const joinRule = priv || !spaceId ? { join_rule: "invite" } : { join_rule: "restricted", allow: [{ type: "m.room_membership", room_id: spaceId }] };
      const r = await (isToken ? matrix.svc.bind(matrix) : (m: string, p: string, o: object) => matrix.as(creator, m, p, o))<{ room_id: string }>(
        "POST",
        "/_matrix/client/v3/createRoom",
        {
          body: {
            room_alias_name: name,
            name,
            ...(topic && { topic }),
            preset: "private_chat",
            room_version: ROOM_VERSION,
            initial_state: [
              { type: MARK, state_key: "", content: mark },
              { type: "m.room.join_rules", state_key: "", content: joinRule },
              { type: "m.room.history_visibility", state_key: "", content: { history_visibility: "shared" } },
              { type: "m.room.guest_access", state_key: "", content: { guest_access: "forbidden" } },
              { type: "m.room.retention", state_key: "", content: retentionContent(config.defaults.retention) },
              ...(spaceId ? [{ type: "m.space.parent", state_key: spaceId, content: { via: [matrix.serverName] } }] : []),
            ],
            power_level_content_override: {
              users: { [creator]: 100, [matrix.serviceUser]: 100 },
              events: { "m.room.encryption": 100, "m.room.retention": 100, [MARK]: 100 },
            },
            ...(!isToken && { invite: [matrix.serviceUser] }),
          },
        },
      );
      if (!isToken) await matrix.svc("POST", `/_matrix/client/v3/join/${seg(r.room_id)}`, { body: {} });
      if (spaceId) await matrix.putState(spaceId, "m.space.child", r.room_id, { via: [matrix.serverName], suggested: false });
      if (!priv)
        await matrix
          .svc("PUT", `/_matrix/client/v3/directory/list/room/${seg(r.room_id)}`, { body: { visibility: "public" } })
          .catch((err: unknown) => log("warn", "channel not published in the room directory", { channel: name, error: String(err) }));
      for (const m of members as string[]) {
        const id = userIdOf(m.toLowerCase(), matrix.serverName);
        await matrix
          .forceJoin(r.room_id, id)
          .catch((err: unknown) => log("warn", "could not add a member to a new channel", { member: id, error: String(err) }));
      }
      log("info", "channel made", { channel: name, by: isToken ? `token ${actor.token}` : creator });
      return { id: r.room_id, alias: `#${name}:${matrix.serverName}` };
    });
  }

  // ------------------------------------------------------------------ search

  /** from:ben in:#deploys has:file before:2026-11-01 after:2026-10-01 "exact words" and plain words. */
  function parseQuery(q: string) {
    const out = { words: [] as string[], from: [] as string[], in: [] as string[], file: false, before: null as string | null, after: null as string | null };
    for (const m of q.matchAll(/(\w+):("[^"]*"|\S+)|"([^"]*)"|(\S+)/g)) {
      const [, key, value, phrase, word] = m;
      const v = value?.replace(/^"|"$/g, "") ?? "";
      if (key === "from") out.from.push(v.toLowerCase());
      else if (key === "in") out.in.push(v.replace(/^#/, "").toLowerCase());
      else if (key === "has" && v === "file") out.file = true;
      else if (key === "before" && isDay(v)) out.before = v;
      else if (key === "after" && isDay(v)) out.after = v;
      else if (phrase !== undefined) out.words.push(`"${phrase}"`);
      else out.words.push(word ?? m[0]);
    }
    return out;
  }

  async function search(email: string, params: URLSearchParams) {
    const me = await person(email);
    const q = parseQuery(params.get("q") ?? "");
    const inRoom = params.get("in");
    const fromUser = params.get("from");
    const days = params.get("days");
    if (days && !/^\d{1,4}$/.test(days)) throw bad("days is a number of days back, such as 7.");
    return server(async () => {
      const w = await who();
      const convs = (await conversations(email)).conversations.filter((c) => !c.invited);
      const mine = new Set(convs.map((c) => c.id));
      const byName = new Map(convs.filter((c) => c.kind !== "dm").map((c) => [c.name.toLowerCase(), c.id]));
      const rooms = [...(inRoom ? [inRoom] : []), ...q.in.map((n) => byName.get(n) ?? n)];
      const senders = [
        ...(fromUser ? [fromUser] : []),
        ...q.from.flatMap((f) =>
          w.users
            .filter(
              (u) => u.name.slice(1).startsWith(f) || (u.displayname ?? "").toLowerCase().split(/\s+/).includes(f) || (u.displayname ?? "").toLowerCase() === f,
            )
            .map((u) => u.name),
        ),
      ];
      if (q.from.length && !senders.length) return { messages: [], files: [], count: 0 };
      const term = q.words.join(" ").trim();
      if (!term) return { messages: [], files: [], count: 0 };
      const filter = { ...(rooms.length && { rooms }), ...(senders.length && { senders }), ...(q.file && { contains_url: true }), types: ["m.room.message"] };
      const ask = (as: string | null, f: Record<string, unknown>) =>
        (as ? (p: string, o: object) => matrix.as(as, "POST", p, o) : (p: string, o: object) => matrix.svc("POST", p, o))("/_matrix/client/v3/search", {
          body: {
            search_categories: {
              room_events: { search_term: term, keys: ["content.body"], filter: f, order_by: "recent", event_context: { before_limit: 0, after_limit: 0 } },
            },
          },
        }) as Promise<{ search_categories: { room_events: { results?: Array<{ result: MatrixEvent }>; count?: number } } }>;
      const results: MatrixEvent[] = (await ask(me, filter)).search_categories.room_events.results?.map((r) => r.result) ?? [];
      // Channels open to the company that the person has not joined: the service account searches those for them.
      const open = config.channels.filter((c) => !c.private).map((c) => `#${c.name}:${matrix.serverName}`);
      const openIds = (await Promise.all(open.map((a) => matrix.roomIdOf(a)))).filter(
        (id): id is string => !!id && !mine.has(id) && (!rooms.length || rooms.includes(id)),
      );
      if (openIds.length) results.push(...((await ask(null, { ...filter, rooms: openIds })).search_categories.room_events.results?.map((r) => r.result) ?? []));
      const after = Math.max(q.after ? Date.parse(q.after) : 0, days ? clock() - Number(days) * DAY : 0);
      const before = q.before ? Date.parse(q.before) : Infinity;
      const names = new Map(convs.map((c) => [c.id, { name: c.name, kind: c.kind }]));
      for (const id of openIds) {
        const info = await roomInfo(id);
        names.set(id, { name: info.state.get("m.room.name|")?.content.name ?? id, kind: "public" });
      }
      const hits = results
        .filter((e) => e.origin_server_ts >= after && e.origin_server_ts < before && !e.content?.["m.relates_to"]?.rel_type?.startsWith("m.replace"))
        .sort((a, b) => b.origin_server_ts - a.origin_server_ts)
        .slice(0, 100)
        .map((e) => ({
          ...toMessage(e, me, w),
          room: { id: e.room_id!, name: names.get(e.room_id!)?.name ?? e.room_id!, kind: names.get(e.room_id!)?.kind ?? "public" },
        }));
      return {
        messages: hits,
        files: hits.filter((h) => h.file).map((h) => ({ id: h.id, file: h.file!, room: h.room, sender: h.sender, ts: h.ts })),
        count: hits.length,
      };
    });
  }

  // ------------------------------------------------------------------ people and guests

  async function peopleList(email: string) {
    const me = await person(email);
    return server(async () => {
      const w = await who();
      const dir = directory ? await people().catch(() => null) : null;
      const byId = new Map((dir ?? []).map((p) => [userIdOf(p.email, matrix.serverName), p]));
      const s = await matrix.svc<any>("GET", "/_matrix/client/v3/sync", {
        query: { timeout: 0, filter: JSON.stringify({ room: { rooms: [] }, account_data: { not_types: ["*"] }, presence: { types: ["m.presence"] } }) },
      });
      const presence = new Map<string, { presence: string; status: string | null }>(
        (s.presence?.events ?? []).map((e: MatrixEvent) => [e.sender, { presence: e.content.presence, status: e.content.status_msg ?? null }]),
      );
      const counts = await channelCounts();
      const guests = db.prepare("SELECT * FROM guests ORDER BY name").all() as Array<Record<string, string | null>>;
      const guestIds = new Set(guests.map((g) => g.user_id!));
      const appIds = new Set(config.apps.map((a) => `@${appSlug(a.name)}:${matrix.serverName}`));
      const list = w.users.filter(
        (u) =>
          !u.deactivated && u.name !== matrix.serviceUser && !guestIds.has(u.name) && !appIds.has(u.name) && u.user_type !== "bot" && u.user_type !== "support",
      );
      const tzOf = (id: string) => profileTz(id);
      const tzs = await limited(
        list.map((u) => u.name),
        8,
        tzOf,
      );
      const presenceOf = (id: string) => {
        const p = presence.get(id);
        const busy = p?.status && /^(busy|dnd|do not disturb)/i.test(p.status);
        return busy ? "busy" : p?.presence === "online" ? "online" : p?.presence === "unavailable" ? "away" : "offline";
      };
      const members = list.map((u, i) => ({
        userId: u.name,
        name: u.displayname ?? u.name,
        email: byId.get(u.name)?.email ?? null,
        presence: presenceOf(u.name),
        status: presence.get(u.name)?.status ?? null,
        timeZone: tzs[i] ?? null,
        groups: byId.get(u.name)?.groups ?? [],
        channels: counts.get(u.name) ?? 0,
        guest: null,
        me: u.name === me,
      }));
      const guestRows = await limited(
        guests.filter((g) => !g.ended_at),
        8,
        async (g) => ({
          userId: g.user_id!,
          name: g.name!,
          email: g.email,
          presence: presenceOf(g.user_id!),
          status: presence.get(g.user_id!)?.status ?? null,
          timeZone: await tzOf(g.user_id!),
          groups: [],
          channels: counts.get(g.user_id!) ?? 0,
          guest: {
            id: g.id!,
            company: g.company,
            channel: g.channel!,
            roomId: g.room_id!,
            invitedBy: w.name(g.invited_by!),
            endsAt: g.ends_at!,
            welcomed: !!g.link_used_at,
          },
          me: false,
        }),
      );
      const leaving = (dir ?? [])
        .filter((p) => p.disabled)
        .map((p) => ({ ...p, userId: userIdOf(p.email, matrix.serverName) }))
        .filter((p) => w.users.some((u) => u.name === p.userId && !u.deactivated))
        .map((p) => ({ name: p.name, email: p.email, channels: counts.get(p.userId) ?? 0 }));
      return { source: directory ? "identity" : "matrix", people: [...members, ...guestRows].sort((a, b) => a.name.localeCompare(b.name)), leaving };
    });
  }

  async function profileTz(userId: string): Promise<string | null> {
    const have = profileCache.get(userId);
    if (have && have.until > clock()) return have.tz;
    const p = await matrix.svc<Record<string, unknown>>("GET", `/_matrix/client/v3/profile/${seg(userId)}`).catch(() => ({}) as Record<string, unknown>);
    const tz = [p["m.tz"], p["us.cloke.msc4175.tz"]].find((v): v is string => typeof v === "string" && v.length < 64) ?? null;
    profileCache.set(userId, { tz, until: clock() + 5 * 60_000 });
    return tz;
  }

  /** How many channels each person is in, from the rooms' member lists. */
  async function channelCounts(): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    const rooms = (await matrix.rooms()).filter((r) => r.room_type !== "m.space" && (r.name || r.canonical_alias));
    const lists = await limited(rooms, 8, (r) => roomInfo(r.room_id).then((i) => i.members));
    for (const list of lists) for (const id of list) counts.set(id, (counts.get(id) ?? 0) + 1);
    return counts;
  }

  /** A guest from outside the company, invited by a member to one channel that takes guests. */
  async function inviteGuest(email: string, body: unknown) {
    const me = await person(email);
    const b = (body ?? {}) as { email?: unknown; name?: unknown; company?: unknown; channel?: unknown; days?: unknown };
    const guestEmail = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
    if (!EMAIL.test(guestEmail)) throw bad("email is the guest's email address.");
    const name = str(b.name, 128);
    if (!name) throw bad("name is the guest's name.");
    const company = b.company === undefined || b.company === null ? null : str(b.company, 128);
    const roomId = str(b.channel, 255);
    if (!roomId) throw bad("channel is the id of the channel the guest joins.");
    const max = config.guestsPolicy.days;
    const days = b.days === undefined ? max : b.days;
    if (!Number.isInteger(days) || (days as number) < 1 || (days as number) > max) throw bad(`days is from 1 to ${max}, as the chat file allows.`);
    return server(async () => {
      const info = await roomInfo(roomId);
      if (!info.members.includes(me)) throw new ChatError(403, "forbidden", "Only a member of the channel invites guests to it.");
      if (!markOf(info.state)?.guests) throw new ChatError(409, "conflict", "This channel does not take guests; an admin turns guests on for it.");
      const userId = `@guest-${guestEmail.replace("@", "_").replace(/[^a-z0-9._=/+-]/g, "_")}:${matrix.serverName}`;
      const was = db.prepare("SELECT id, ended_at FROM guests WHERE user_id = ?").get(userId) as { id: string; ended_at: string | null } | undefined;
      if (was && !was.ended_at) throw new ChatError(409, "conflict", `${guestEmail} is a guest already.`);
      if (was) throw new ChatError(409, "conflict", `${guestEmail} was a guest before; their old account stays deactivated. Invite them with another address.`);
      await matrix.putUser(userId, { displayname: company ? `${name} (${company})` : name, threepids: [{ medium: "email", address: guestEmail }] });
      await serviceIn(roomId);
      await matrix.forceJoin(roomId, userId);
      const token = randomBytes(24).toString("base64url");
      const id = randomUUID();
      const endsAt = new Date(clock() + (days as number) * DAY).toISOString();
      db.prepare(
        "INSERT INTO guests (id, email, name, company, user_id, room_id, channel, invited_by, created_at, ends_at, link_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        id,
        guestEmail,
        name,
        company,
        userId,
        roomId,
        info.state.get("m.room.name|")?.content.name ?? roomId,
        me,
        now().toISOString(),
        endsAt,
        hash(token),
      );
      usersCache = null;
      stateCache.delete(roomId);
      log("info", "guest invited", { guest: userId, channel: roomId, by: me, endsAt });
      return { id, userId, endsAt, link: `${publicUrl}/welcome/${token}` };
    });
  }

  async function endGuest(actor: { email: string; admin: boolean }, id: string) {
    const g = db.prepare("SELECT * FROM guests WHERE id = ?").get(id) as Record<string, string | null> | undefined;
    if (!g) throw new ChatError(404, "not-found", "No such guest.");
    const me = await person(actor.email);
    if (!actor.admin && g.invited_by !== me) throw new ChatError(403, "forbidden", "Only who invited the guest, or an admin, ends their access.");
    if (!g.ended_at) {
      await server(() => matrix.deactivate(g.user_id!));
      db.prepare("UPDATE guests SET ended_at = ? WHERE id = ?").run(now().toISOString(), id);
      usersCache = null;
      log("info", "guest access ended", { guest: g.user_id, by: me });
    }
  }

  /** The guest's welcome link: they choose a password for their Matrix account, once. */
  function welcome(token: string) {
    const g = db.prepare("SELECT * FROM guests WHERE link_hash = ?").get(hash(token)) as Record<string, string | null> | undefined;
    if (!g || g.ended_at || g.link_used_at) throw new ChatError(404, "not-found", "This link was used already, or the guest's access ended.");
    return g;
  }
  async function welcomeInfo(token: string) {
    const g = welcome(token);
    return { name: g.name!, channel: g.channel!, userId: g.user_id!, endsAt: g.ends_at!, homeserver: homeserverUrl };
  }
  async function acceptWelcome(token: string, body: unknown) {
    const g = welcome(token);
    const password = (body as { password?: unknown } | null)?.password;
    if (typeof password !== "string" || password.length < 12 || password.length > 256) throw bad("password is 12 to 256 characters.");
    await server(() => matrix.putUser(g.user_id!, { password, logout_devices: false }));
    db.prepare("UPDATE guests SET link_used_at = ?, link_hash = NULL WHERE id = ?").run(now().toISOString(), g.id!);
    log("info", "guest chose a password", { guest: g.user_id });
    return { userId: g.user_id!, homeserver: homeserverUrl };
  }

  // ------------------------------------------------------------------ channels, retention and holds

  async function adminChannel(r: AdminRoom) {
    const info = await roomInfo(r.room_id);
    const mark = markOf(info.state);
    const kind = kindOf(info.state, new Set(), r.room_id);
    const hold = db.prepare("SELECT reference FROM holds WHERE room_id = ? AND released_at IS NULL ORDER BY placed_at LIMIT 1").get(r.room_id) as
      { reference: string } | undefined;
    const held = hold
      ? (db.prepare("SELECT previous FROM holds WHERE room_id = ? AND released_at IS NULL ORDER BY placed_at LIMIT 1").get(r.room_id) as {
          previous: string | null;
        })
      : null;
    const pl = info.state.get("m.room.power_levels|")?.content ?? {};
    const fileEntry = mark?.managedBy === "file" ? config.channels.find((c) => c.name === info.state.get("m.room.name|")?.content.name) : undefined;
    return {
      id: r.room_id,
      name: info.state.get("m.room.name|")?.content.name ?? r.name ?? r.room_id,
      alias: r.canonical_alias,
      kind: kind === "space" || kind === "dm" ? "private" : kind,
      topic: info.state.get("m.room.topic|")?.content.topic ?? null,
      members: info.members.length,
      from: fromText(mark),
      managedBy: mark?.managedBy ?? "people",
      by: mark?.by ?? null,
      reference: mark?.reference ?? null,
      retention: held ? (held.previous ?? retentionText(config.defaults.retention)) : retentionText(retentionOf(info.state.get("m.room.retention|")?.content)),
      hold: hold?.reference ?? null,
      guests: !!mark?.guests,
      guestCount: activeGuestsIn(r.room_id).length,
      posts: (pl.events_default ?? 0) > 0 ? "admins" : "everyone",
      encrypted: !!r.encryption,
      entry: fileEntry
        ? {
            name: fileEntry.name,
            topic: fileEntry.topic,
            private: fileEntry.private,
            members: fileEntry.members,
            admins: fileEntry.admins,
            retention: retentionText(fileEntry.retention),
            guests: fileEntry.guests,
            posts: fileEntry.posts,
          }
        : null,
    };
  }

  /** Every channel on the server: the file's, those people and products made; not direct messages or the space. */
  async function channels() {
    ready();
    return server(async () => {
      const rooms = (await matrix.rooms()).filter((r) => r.room_type !== "m.space" && (r.name || r.canonical_alias));
      const list = (await limited(rooms, 8, adminChannel)).sort((a, b) => a.name.localeCompare(b.name));
      const media = await matrix
        .svc<{ users: Array<{ media_length: number }> }>("GET", "/_synapse/admin/v1/statistics/users/media", { query: { limit: 10000 } })
        .then((r) => r.users.reduce((n, u) => n + u.media_length, 0))
        .catch(() => null);
      const messages = await matrix
        .svc<{ rooms: Array<{ estimated_size: number }> }>("GET", "/_synapse/admin/v1/statistics/database/rooms")
        .then((r) => r.rooms.reduce((n, x) => n + x.estimated_size, 0))
        .catch(() => null);
      return {
        channels: list,
        totals: {
          channels: list.length,
          fromFile: list.filter((c) => c.managedBy === "file").length,
          private: list.filter((c) => c.kind === "private").length,
          withGuests: list.filter((c) => c.guestCount > 0).length,
          guests: (db.prepare("SELECT COUNT(*) AS n FROM guests WHERE ended_at IS NULL").get() as { n: number }).n,
          files: media,
          messages,
        },
      };
    });
  }

  /** Retention, who posts and guests, for a channel people or a product made; the file's channels change in the file. */
  async function updateChannel(roomId: string, body: unknown) {
    ready();
    const b = (body ?? {}) as { retention?: unknown; posts?: unknown; guests?: unknown };
    const retention = b.retention === undefined ? undefined : parseRetentionOr422(b.retention);
    if (b.posts !== undefined && b.posts !== "everyone" && b.posts !== "admins") throw bad("posts is everyone or admins.");
    if (b.guests !== undefined && typeof b.guests !== "boolean") throw bad("guests is true or false.");
    return server(async () => {
      const room = (await matrix.rooms()).find((r) => r.room_id === roomId);
      if (!room) throw new ChatError(404, "not-found", "No such channel.");
      const info = await roomInfo(roomId);
      const mark = markOf(info.state);
      if (mark?.managedBy === "file") throw new ChatError(409, "conflict", "This channel is set in the chat file; change it there.");
      await serviceIn(roomId);
      if (retention !== undefined) {
        const hold = db.prepare("SELECT id FROM holds WHERE room_id = ? AND released_at IS NULL").all(roomId) as Array<{ id: string }>;
        if (hold.length) db.prepare("UPDATE holds SET previous = ? WHERE room_id = ? AND released_at IS NULL").run(retentionText(retention), roomId);
        else await matrix.putState(roomId, "m.room.retention", "", retentionContent(retention));
      }
      if (b.posts !== undefined) {
        const pl = (await roomInfo(roomId)).state.get("m.room.power_levels|")?.content ?? {};
        await matrix.putState(roomId, "m.room.power_levels", "", { ...pl, events_default: b.posts === "admins" ? 50 : 0 });
      }
      if (b.guests !== undefined || !mark)
        await matrix.putState(roomId, MARK, "", { ...(mark ?? { managedBy: "people" }), guests: b.guests ?? mark?.guests ?? false });
      stateCache.delete(roomId);
      return adminChannel(room);
    });
  }

  function parseRetentionOr422(v: unknown): Retention {
    try {
      return parseRetention(v, "retention");
    } catch (err) {
      throw bad((err as Error).message);
    }
  }

  async function placeHold(roomId: string, channel: string, reference: string, by: string, exportId: string | null) {
    const info = await roomInfo(roomId);
    const previous = retentionText(retentionOf(info.state.get("m.room.retention|")?.content));
    const already = db.prepare("SELECT previous FROM holds WHERE room_id = ? AND released_at IS NULL LIMIT 1").get(roomId) as
      { previous: string | null } | undefined;
    const id = exportId ?? randomUUID();
    db.prepare("INSERT INTO holds (id, reference, room_id, channel, previous, placed_by, placed_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      id,
      reference,
      roomId,
      channel,
      already ? already.previous : previous,
      by,
      now().toISOString(),
    );
    await serviceIn(roomId);
    await matrix.putState(roomId, "m.room.retention", "", {});
    stateCache.delete(roomId);
    log("info", "legal hold placed", { reference, room: roomId, by });
  }

  async function releaseHold(id: string, by: string) {
    const h = db.prepare("SELECT * FROM holds WHERE id = ?").get(id) as Record<string, string | null> | undefined;
    if (!h) throw new ChatError(404, "not-found", "No such hold.");
    if (h.released_at) throw new ChatError(409, "conflict", "This hold was released already.");
    db.prepare("UPDATE holds SET released_by = ?, released_at = ? WHERE id = ?").run(by, now().toISOString(), id);
    const still = db.prepare("SELECT 1 FROM holds WHERE room_id = ? AND released_at IS NULL").get(h.room_id!);
    if (!still)
      await server(async () => {
        const info = await roomInfo(h.room_id!);
        const fromFile = markOf(info.state)?.managedBy === "file";
        if (fromFile) await syncNow();
        else if (h.previous) await matrix.putState(h.room_id!, "m.room.retention", "", retentionContent(parseRetention(h.previous, "previous")));
        stateCache.delete(h.room_id!);
      });
    log("info", "legal hold released", { reference: h.reference, room: h.room_id, by });
    return holdRow(id);
  }

  const holdRow = (id: string) => {
    const h = db.prepare("SELECT * FROM holds WHERE id = ?").get(id) as Record<string, string | null>;
    return {
      id: h.id!,
      reference: h.reference!,
      channel: h.channel!,
      roomId: h.room_id!,
      placedBy: h.placed_by!,
      placedAt: h.placed_at!,
      releasedAt: h.released_at,
    };
  };

  // ------------------------------------------------------------------ exports for a legal request

  let signingKey: KeyObject | null = null;
  function key(): KeyObject {
    if (signingKey) return signingKey;
    const have = db.prepare("SELECT value FROM settings WHERE key = 'export-signing-key'").get() as { value: string } | undefined;
    if (have) signingKey = createPrivateKey(have.value);
    else {
      const { privateKey } = generateKeyPairSync("ed25519");
      db.prepare("INSERT INTO settings (key, value) VALUES ('export-signing-key', ?)").run(privateKey.export({ type: "pkcs8", format: "pem" }) as string);
      signingKey = privateKey;
    }
    return signingKey;
  }
  const publicKey = () => createPublicKey(key()).export({ type: "spki", format: "pem" }) as string;
  const exportsDir = () => {
    const dir = pathJoin(dataDir, "exports");
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  const exportRow = (id: string) => {
    const e = db.prepare("SELECT * FROM exports WHERE id = ?").get(id) as Record<string, any> | undefined;
    if (!e) throw new ChatError(404, "not-found", "No such export.");
    const hold = db.prepare("SELECT id, released_at FROM holds WHERE id = ?").get(id) as { id: string; released_at: string | null } | undefined;
    return {
      id: e.id as string,
      reference: e.reference as string,
      channel: e.channel as string,
      roomId: e.room_id as string,
      from: e.from_day as string,
      to: e.to_day as string,
      senders: JSON.parse(e.senders) as string[],
      startedBy: e.started_by as string,
      startedAt: e.started_at as string,
      finishedAt: e.finished_at as string | null,
      state: e.state as "running" | "ready" | "failed",
      messages: e.messages as number,
      files: e.files as number,
      bytes: e.bytes as number,
      sha256: e.sha256 as string | null,
      error: e.error as string | null,
      hold: hold ? { id: hold.id, released: !!hold.released_at } : null,
    };
  };

  async function startExport(by: string, body: unknown) {
    ready();
    const b = (body ?? {}) as { reference?: unknown; channel?: unknown; from?: unknown; to?: unknown; senders?: unknown; hold?: unknown };
    const reference = str(b.reference, 64);
    if (!reference) throw bad("reference is the request's reference, such as LR-2026-08.");
    const roomId = str(b.channel, 255);
    if (!roomId) throw bad("channel is the channel's id.");
    if (!isDay(b.from) || !isDay(b.to) || b.from > b.to) throw bad("from and to are days, YYYY-MM-DD, from not after to.");
    const senders = b.senders === undefined ? [] : b.senders;
    if (!Array.isArray(senders) || senders.length > 100 || senders.some((s) => typeof s !== "string" || !/^@[^:]+:.+$/.test(s)))
      throw bad("senders is a list of Matrix user ids, or left out for everyone.");
    if (b.hold !== undefined && typeof b.hold !== "boolean") throw bad("hold is true or false.");
    const from = b.from;
    const to = b.to;
    return server(async () => {
      const room = (await matrix.rooms()).find((r) => r.room_id === roomId);
      if (!room) throw new ChatError(404, "not-found", "No such channel.");
      const info = await roomInfo(roomId);
      const channel = info.state.get("m.room.name|")?.content.name ?? roomId;
      const id = randomUUID();
      db.prepare(
        "INSERT INTO exports (id, reference, room_id, channel, from_day, to_day, senders, started_by, started_at, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running')",
      ).run(id, reference, roomId, channel, from, to, JSON.stringify(senders), by, now().toISOString());
      // Audit log (ADR 0013): who asked for which messages, and why.
      log("info", "audit", { event: { type: "legal-export-started", actor: by, detail: `${reference}: ${channel} ${from} to ${to}`, hold: b.hold === true } });
      if (b.hold === true) await placeHold(roomId, channel, reference, by, id);
      const work = runExport(id, roomId, channel, reference, from, to, senders as string[], by).finally(() => exportsRunning.delete(work));
      exportsRunning.add(work);
      return exportRow(id);
    });
  }

  async function runExport(id: string, roomId: string, channel: string, reference: string, from: string, to: string, senders: string[], by: string) {
    try {
      const start = Date.parse(`${from}T00:00:00Z`);
      const end = Date.parse(`${to}T00:00:00Z`) + DAY;
      const events: MatrixEvent[] = [];
      let token: string | undefined;
      for (let page = 0; page < 2000; page++) {
        const r = await matrix.svc<{ chunk: MatrixEvent[]; end?: string }>("GET", `/_synapse/admin/v1/rooms/${seg(roomId)}/messages`, {
          query: { dir: "b", limit: 500, from: token },
        });
        events.push(...r.chunk.filter((e) => e.origin_server_ts >= start && e.origin_server_ts < end && (!senders.length || senders.includes(e.sender))));
        if (!r.end || !r.chunk.length || r.chunk.every((e) => e.origin_server_ts < start)) break;
        token = r.end;
      }
      events.sort((a, b) => a.origin_server_ts - b.origin_server_ts);
      const at = now();
      const files: Array<{ name: string; data: Buffer; at: Date }> = [];
      const uris = [...new Set(events.map((e) => e.content?.url).filter((u): u is string => typeof u === "string" && u.startsWith("mxc://")))];
      const fileIndex: Array<{ uri: string; path: string; sha256: string; bytes: number }> = [];
      for (const uri of uris) {
        const [serverName, mediaId] = uri.slice(6).split("/");
        try {
          const { data } = await matrix.download(`/_matrix/client/v1/media/download/${seg(serverName!)}/${seg(mediaId!)}`, matrix.serviceToken);
          const path = `files/${mediaId}-${(events.find((e) => e.content?.url === uri)?.content?.filename ?? events.find((e) => e.content?.url === uri)?.content?.body ?? "file").replace(/[\\/:*?"<>|]+/g, "_")}`;
          files.push({ name: path, data, at });
          fileIndex.push({ uri, path, sha256: createHash("sha256").update(data).digest("hex"), bytes: data.length });
        } catch (err) {
          fileIndex.push({ uri, path: "", sha256: "", bytes: 0 });
          log("warn", "export: a file could not be read", { uri, error: String(err) });
        }
      }
      const jsonl = Buffer.from(events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : ""));
      const manifest = Buffer.from(
        JSON.stringify(
          {
            reference,
            channel,
            roomId,
            server: matrix.serverName,
            from,
            to,
            senders,
            startedBy: by,
            madeAt: at.toISOString(),
            events: events.length,
            "messages.jsonl": createHash("sha256").update(jsonl).digest("hex"),
            files: fileIndex,
          },
          null,
          2,
        ) + "\n",
      );
      const signature = Buffer.from(sign(null, manifest, key()).toString("base64") + "\n");
      const archive = zip([
        { name: "manifest.json", data: manifest, at },
        { name: "manifest.json.sig", data: signature, at },
        { name: "signing-key.pem", data: Buffer.from(publicKey()), at },
        { name: "messages.jsonl", data: jsonl, at },
        ...files,
      ]);
      writeFileSync(pathJoin(exportsDir(), `${id}.zip`), archive);
      const messagesCount = events.filter((e) => e.type === "m.room.message" || e.type === "m.room.encrypted").length;
      db.prepare("UPDATE exports SET state = 'ready', finished_at = ?, messages = ?, files = ?, bytes = ?, sha256 = ? WHERE id = ?").run(
        now().toISOString(),
        messagesCount,
        files.length,
        archive.length,
        createHash("sha256").update(archive).digest("hex"),
        id,
      );
      log("info", "audit", { event: { type: "legal-export-ready", actor: by, detail: `${reference}: ${messagesCount} messages, ${files.length} files` } });
    } catch (err) {
      db.prepare("UPDATE exports SET state = 'failed', finished_at = ?, error = ? WHERE id = ?").run(now().toISOString(), (err as Error).message, id);
      log("warn", "export failed", { reference, error: (err as Error).message });
    }
  }

  function exportArchive(id: string): { name: string; data: Buffer } {
    const e = exportRow(id);
    if (e.state !== "ready") throw new ChatError(409, "conflict", e.state === "running" ? "The export is still running." : `The export failed: ${e.error}`);
    return { name: `${e.reference.replace(/[^\w.-]+/g, "_")}-${e.channel}.zip`, data: readFileSync(pathJoin(exportsDir(), `${id}.zip`)) };
  }

  // ------------------------------------------------------------------ apps and webhooks

  function hookFor(app: string, by: string) {
    const a = config.apps.find((x) => appSlug(x.name) === app || x.name === app);
    if (!a) throw new ChatError(404, "not-found", "No such app in the chat file.");
    const token = `oa_chat_hook_${randomBytes(24).toString("base64url")}`;
    db.prepare(
      "INSERT INTO hooks (app, token_hash, created_at, created_by) VALUES (?, ?, ?, ?) ON CONFLICT (app) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at, created_by = excluded.created_by, used_at = NULL",
    ).run(appSlug(a.name), hash(token), now().toISOString(), by);
    log("info", "audit", { event: { type: "webhook-created", actor: by, target: a.name } });
    return { app: a.name, url: `${publicUrl}/hooks/${token}` };
  }

  /** A message from an app: text, and a card the pages draw; Element shows the text. */
  async function hook(token: string, body: unknown) {
    ready();
    const row = db.prepare("SELECT app FROM hooks WHERE token_hash = ?").get(hash(token)) as { app: string } | undefined;
    const app = row && config.apps.find((a) => appSlug(a.name) === row.app);
    if (!app) throw new ChatError(401, "invalid-token", "This webhook address is not known, or its app left the chat file.");
    const b = (body ?? {}) as { text?: unknown; channel?: unknown; card?: unknown };
    const text = typeof b.text === "string" ? b.text.trim() : "";
    if (!text || text.length > 4000) throw bad("text is the message, up to 4000 characters.");
    const channel = b.channel === undefined ? app.channels[0] : typeof b.channel === "string" ? b.channel.replace(/^#/, "").toLowerCase() : "";
    if (!channel || !app.channels.includes(channel))
      throw bad(`channel is one of ${app.channels.map((c) => `#${c}`).join(", ") || "the app's channels in the file"}.`);
    const card = b.card === undefined ? null : cardOf(b.card);
    if (b.card !== undefined && !card) throw bad("card is { title, severity, status, fields, link }.");
    return server(async () => {
      const roomId = await matrix.roomIdOf(`#${channel}:${matrix.serverName}`);
      if (!roomId) throw new ChatError(404, "not-found", `#${channel} is not on the server yet.`);
      const userId = `@${appSlug(app.name)}:${matrix.serverName}`;
      const content = { ...withMentions(text, []), ...(card && { [CARD]: card }) };
      const r = await matrix.as<{ event_id: string }>(userId, "PUT", `/_matrix/client/v3/rooms/${seg(roomId)}/send/m.room.message/${matrix.txn()}`, {
        body: content,
      });
      db.prepare("UPDATE hooks SET used_at = ? WHERE app = ?").run(now().toISOString(), row!.app);
      return { eventId: r.event_id, channel };
    });
  }

  async function integrations() {
    const version = await matrix
      .svc<{ server_version: string }>("GET", "/_synapse/admin/v1/server_version")
      .then((r) => r.server_version)
      .catch(() => null);
    const hooks = new Map(
      (db.prepare("SELECT app, created_at, used_at FROM hooks").all() as Array<{ app: string; created_at: string; used_at: string | null }>).map((h) => [
        h.app,
        h,
      ]),
    );
    let serverName: string | null = null;
    try {
      serverName = matrix.serverName || null;
    } catch {
      serverName = null;
    }
    return {
      matrix: { homeserver: homeserverUrl, serverName, version, ok: version !== null, user: serverName ? matrix.serviceUser : null },
      identity: { configured: !!directory, ...identity },
      apps: config.apps.map((a) => {
        const h = hooks.get(appSlug(a.name));
        return {
          name: a.name,
          userId: serverName ? `@${appSlug(a.name)}:${serverName}` : null,
          channels: a.channels,
          hook: h ? { createdAt: h.created_at, usedAt: h.used_at } : null,
        };
      }),
    };
  }

  return {
    setConfig(next: ChatConfig): Promise<SyncResult> {
      config = next;
      return syncNow();
    },
    /** Takes the file without a sync, before Chat is connected to the Matrix server. */
    useConfig(next: ChatConfig) {
      config = next;
    },
    config: () => config,
    syncNow,
    lastSync: () => last,
    summary() {
      return { channels: config.channels.length, apps: config.apps.length, file: fileState(), sync: last, homeserver: homeserverUrl };
    },
    me: async (email: string, name?: string) => {
      const userId = await person(email, name);
      return { userId, email, homeserver: homeserverUrl, serverName: matrix.serverName };
    },
    conversations,
    conversation,
    messages,
    thread,
    send,
    react,
    markRead,
    join,
    leave,
    direct,
    upload,
    download,
    browse,
    createChannel,
    search,
    people: peopleList,
    inviteGuest,
    endGuest,
    welcomeInfo,
    acceptWelcome,
    channels,
    updateChannel,
    releaseHold,
    holds: () => (db.prepare("SELECT id FROM holds ORDER BY placed_at DESC").all() as Array<{ id: string }>).map((h) => holdRow(h.id)),
    startExport,
    exports: () => (db.prepare("SELECT id FROM exports ORDER BY started_at DESC").all() as Array<{ id: string }>).map((e) => exportRow(e.id)),
    exportRow,
    exportArchive,
    exportsIdle: () => Promise.all(exportsRunning),
    publicKey,
    hookFor,
    hook,
    integrations,
    /** Waits up to 25 seconds for anything new for the person, and says which conversations changed. */
    async wait(email: string, since: string | null) {
      const me = await person(email);
      return server(async () => {
        const s = await matrix.as<any>(me, "GET", "/_matrix/client/v3/sync", {
          query: {
            since: since ?? undefined,
            timeout: since ? 25_000 : 0,
            filter: JSON.stringify({
              room: { timeline: { limit: 1 }, state: { types: [] }, ephemeral: { not_types: ["*"] }, account_data: { not_types: ["*"] } },
              presence: { not_types: ["*"] },
              account_data: { not_types: ["*"] },
            }),
          },
        });
        const changed = [...Object.keys(s.rooms?.join ?? {}), ...Object.keys(s.rooms?.invite ?? {}), ...Object.keys(s.rooms?.leave ?? {})];
        return { since: s.next_batch as string, changed: since ? changed : [] };
      });
    },
    gauges() {
      return {
        channels: config.channels.length,
        apps: config.apps.length,
        guests: (db.prepare("SELECT COUNT(*) AS n FROM guests WHERE ended_at IS NULL").get() as { n: number }).n,
        holds: (db.prepare("SELECT COUNT(*) AS n FROM holds WHERE released_at IS NULL").get() as { n: number }).n,
        syncOk: last ? last.ok : null,
      };
    },
    localpartOf,
  };
}

export type Chat = ReturnType<typeof createChat>;
