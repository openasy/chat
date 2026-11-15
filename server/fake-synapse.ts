// A Matrix server in memory for tests, answering the admin and client-server calls Chat makes the way Synapse does.
// Given to createMatrix() as its fetch, so the real client code runs against it. It keeps rooms as state and a
// timeline of events, checks membership, join rules and power levels, and bundles edits and thread summaries.
import { createHmac, randomBytes } from "node:crypto";
import type { MatrixEvent } from "./matrix.ts";

export const SERVER = "example.com";
export const SHARED_SECRET = "test-registration-secret";

interface User {
  name: string;
  displayname: string | null;
  deactivated: boolean;
  admin: boolean;
  user_type: string | null;
  threepids: Array<{ medium: string; address: string }>;
  password: string | null;
  profile: Record<string, unknown>;
}

interface Room {
  id: string;
  state: Map<string, MatrixEvent>;
  timeline: MatrixEvent[];
  visibility: "public" | "private";
}

class Fail extends Error {
  readonly status: number;
  readonly errcode: string;
  constructor(status: number, errcode: string, message: string) {
    super(message);
    this.status = status;
    this.errcode = errcode;
  }
}

export function fakeSynapse() {
  let n = 0;
  const next = () => ++n;
  const users = new Map<string, User>();
  const tokens = new Map<string, string>();
  const rooms = new Map<string, Room>();
  const aliases = new Map<string, string>();
  const accountData = new Map<string, Map<string, unknown>>();
  const media = new Map<string, { type: string; data: Buffer; by: string }>();
  const presence = new Map<string, { presence: string; status_msg?: string }>();
  const readMarkers = new Map<string, number>();
  const nonces = new Set<string>();
  const txns = new Map<string, string>();
  /** Every call, with who made it. */
  const calls: Array<{ as: string | null; method: string; path: string; body?: any }> = [];
  const state = { down: false, sqlite: false };

  const fail = (status: number, errcode: string, message: string) => new Fail(status, errcode, message);
  const user = (id: string) => users.get(id);
  const membership = (room: Room, id: string) => room.state.get(`m.room.member|${id}`)?.content.membership as string | undefined;
  const joined = (room: Room) => [...room.state.values()].filter((e) => e.type === "m.room.member" && e.content.membership === "join").map((e) => e.state_key!);
  const level = (room: Room, id: string) => {
    const pl = room.state.get("m.room.power_levels|")?.content ?? {};
    return pl.users?.[id] ?? pl.users_default ?? 0;
  };
  const needed = (room: Room, type: string, isState: boolean) => {
    const pl = room.state.get("m.room.power_levels|")?.content ?? {};
    return pl.events?.[type] ?? (isState ? (pl.state_default ?? 50) : (pl.events_default ?? 0));
  };
  const roomOf = (id: string) => {
    const r = rooms.get(id.startsWith("#") ? (aliases.get(id) ?? "") : id);
    if (!r) throw fail(404, "M_NOT_FOUND", "Unknown room");
    return r;
  };
  const ts = () => 1_790_000_000_000 + n * 1000;

  function addEvent(room: Room, sender: string, type: string, content: Record<string, any>, stateKey?: string, extra: Partial<MatrixEvent> = {}): MatrixEvent {
    const e: MatrixEvent = {
      event_id: `$e${next()}`,
      type,
      sender,
      origin_server_ts: ts(),
      content,
      room_id: room.id,
      ...(stateKey !== undefined && { state_key: stateKey }),
      ...extra,
    };
    room.timeline.push(e);
    if (stateKey !== undefined) room.state.set(`${type}|${stateKey}`, e);
    return e;
  }

  function setMembership(room: Room, sender: string, target: string, membershipValue: string) {
    const name = user(target)?.displayname ?? null;
    addEvent(room, sender, "m.room.member", { membership: membershipValue, ...(name && { displayname: name }) }, target);
  }

  function joinRoom(room: Room, id: string, byAdmin = false) {
    if (membership(room, id) === "join") return;
    const rule = room.state.get("m.room.join_rules|")?.content ?? { join_rule: "invite" };
    const invited = membership(room, id) === "invite";
    if (!invited && !byAdmin) {
      if (rule.join_rule === "restricted") {
        const ok = (rule.allow ?? []).some((a: { room_id: string }) => {
          const r = rooms.get(a.room_id);
          return r && membership(r, id) === "join";
        });
        if (!ok) throw fail(403, "M_FORBIDDEN", "You do not belong to any of the required rooms/spaces to join this room.");
      } else if (rule.join_rule !== "public") throw fail(403, "M_FORBIDDEN", "You are not invited to this room.");
    }
    setMembership(room, id, id, "join");
  }

  /** The event as a client sees it: redacted content stripped, edits and thread summaries bundled. */
  function view(room: Room, e: MatrixEvent, viewer: string): MatrixEvent {
    const out: MatrixEvent = { ...e, unsigned: { ...e.unsigned } };
    const redaction = room.timeline.find((x) => x.type === "m.room.redaction" && x.redacts === e.event_id);
    if (redaction) return { ...out, content: {}, unsigned: { redacted_because: redaction } };
    const relations: Record<string, unknown> = {};
    const replies = room.timeline.filter((x) => x.content?.["m.relates_to"]?.rel_type === "m.thread" && x.content["m.relates_to"].event_id === e.event_id);
    if (replies.length)
      relations["m.thread"] = { count: replies.length, latest_event: replies.at(-1), current_user_participated: replies.some((r) => r.sender === viewer) };
    const edits = room.timeline.filter((x) => x.content?.["m.relates_to"]?.rel_type === "m.replace" && x.content["m.relates_to"].event_id === e.event_id);
    if (edits.length) relations["m.replace"] = edits.at(-1);
    if (Object.keys(relations).length) out.unsigned = { ...out.unsigned, "m.relations": relations };
    return out;
  }

  function stripped(e: MatrixEvent) {
    return { type: e.type, state_key: e.state_key, sender: e.sender, content: e.content };
  }

  const visible = (room: Room, id: string) => membership(room, id) === "join";
  const must = (room: Room, id: string) => {
    if (!visible(room, id)) throw fail(403, "M_FORBIDDEN", `User ${id} not in room ${room.id}`);
  };

  function createRoom(creator: string, body: Record<string, any>): Room {
    if (body.room_alias_name && aliases.has(`#${body.room_alias_name}:${SERVER}`)) throw fail(400, "M_ROOM_IN_USE", "Room alias already taken");
    const room: Room = { id: `!r${next()}:${SERVER}`, state: new Map(), timeline: [], visibility: body.visibility === "public" ? "public" : "private" };
    rooms.set(room.id, room);
    addEvent(room, creator, "m.room.create", { creator, room_version: body.room_version ?? "10", ...body.creation_content }, "");
    setMembership(room, creator, creator, "join");
    const pl = {
      users: { [creator]: 100, ...(body.preset === "trusted_private_chat" ? Object.fromEntries((body.invite ?? []).map((i: string) => [i, 100])) : {}) },
      users_default: 0,
      events_default: 0,
      state_default: 50,
      ban: 50,
      kick: 50,
      redact: 50,
      invite: 0,
      events: {},
      ...body.power_level_content_override,
    };
    pl.users = { ...pl.users, [creator]: 100, ...body.power_level_content_override?.users };
    addEvent(room, creator, "m.room.power_levels", pl, "");
    addEvent(room, creator, "m.room.join_rules", { join_rule: body.preset === "public_chat" ? "public" : "invite" }, "");
    if (body.room_alias_name) {
      const alias = `#${body.room_alias_name}:${SERVER}`;
      aliases.set(alias, room.id);
      addEvent(room, creator, "m.room.canonical_alias", { alias }, "");
    }
    for (const s of body.initial_state ?? []) addEvent(room, creator, s.type, s.content, s.state_key ?? "");
    if (body.name) addEvent(room, creator, "m.room.name", { name: body.name }, "");
    if (body.topic) addEvent(room, creator, "m.room.topic", { topic: body.topic }, "");
    for (const i of body.invite ?? []) setMembership(room, creator, i, "invite");
    return room;
  }

  function sync(me: string, query: URLSearchParams) {
    const filter = JSON.parse(query.get("filter") ?? "{}");
    const since = Number((query.get("since") ?? "s0").slice(1));
    const limit = filter.room?.timeline?.limit ?? 10;
    const onlyRooms: string[] | undefined = filter.room?.rooms;
    const join: Record<string, unknown> = {};
    const invite: Record<string, unknown> = {};
    for (const room of rooms.values()) {
      if (onlyRooms && !onlyRooms.includes(room.id)) continue;
      const m = membership(room, me);
      const fresh = room.timeline.filter((e) => Number(e.event_id.slice(2)) > since);
      if (since && !fresh.length) continue;
      if (m === "invite") {
        invite[room.id] = { invite_state: { events: [...room.state.values()].filter((e) => e.type !== "m.room.member" || e.state_key === me).map(stripped) } };
        continue;
      }
      if (m !== "join") continue;
      const messages = room.timeline.filter((e) => e.state_key === undefined || e.type === "m.room.member");
      const tl = (since ? fresh : room.timeline).slice(-limit).map((e) => view(room, e, me));
      const read = readMarkers.get(`${me}|${room.id}`) ?? 0;
      const unread = room.timeline.filter(
        (e) =>
          e.type === "m.room.message" &&
          e.sender !== me &&
          Number(e.event_id.slice(2)) > read &&
          !e.content?.["m.relates_to"]?.rel_type?.startsWith("m.replace"),
      );
      const others = joined(room).filter((id) => id !== me);
      void messages;
      join[room.id] = {
        state: { events: filter.room?.state?.types?.length === 0 ? [] : [...room.state.values()].filter((e) => !tl.some((t) => t.event_id === e.event_id)) },
        timeline: { events: tl, limited: false },
        unread_notifications: {
          notification_count: unread.length,
          highlight_count: unread.filter((e) => e.content?.["m.mentions"]?.user_ids?.includes(me) || e.content?.["m.mentions"]?.room).length,
        },
        summary: { "m.heroes": others.slice(0, 5), "m.joined_member_count": others.length + 1 },
      };
    }
    const wantsDirect = (filter.account_data?.types ?? []).includes("m.direct");
    const direct = accountData.get(me)?.get("m.direct");
    const presenceAllowed = !(filter.presence?.not_types ?? []).includes("*");
    return {
      next_batch: `s${n}`,
      rooms: { join, invite, leave: {} },
      account_data: { events: wantsDirect && direct ? [{ type: "m.direct", content: direct }] : [] },
      presence: { events: presenceAllowed ? [...presence].map(([sender, content]) => ({ type: "m.presence", sender, content })) : [] },
    };
  }

  type Handler = (ctx: { me: string; params: string[]; body: any; query: URLSearchParams; raw: Buffer; headers: Headers }) => unknown;
  const routes: Array<[string, RegExp, Handler | null, Handler]> = [];
  /** null auth: no token needed; "admin": a server admin's token. */
  const on = (method: string, path: string, handler: Handler, access: "none" | "user" | "admin" = "user") => {
    const re = new RegExp(`^${path.replace(/:[a-z]+/g, "([^/]*)")}$`);
    routes.push([method, re, access === "none" ? null : access === "admin" ? (c) => isAdmin(c.me) : () => true, handler]);
  };
  const isAdmin = (id: string) => {
    if (!user(id)?.admin) throw fail(403, "M_FORBIDDEN", "You are not a server admin");
    return true;
  };

  // ---------------------------------------------------------------- admin API

  on(
    "GET",
    "/_synapse/admin/v1/register",
    () => {
      const nonce = randomBytes(8).toString("hex");
      nonces.add(nonce);
      return { nonce };
    },
    "none",
  );
  on(
    "POST",
    "/_synapse/admin/v1/register",
    ({ body }) => {
      if (!nonces.delete(body.nonce)) throw fail(400, "M_UNKNOWN", "unrecognised nonce");
      const mac = createHmac("sha1", SHARED_SECRET)
        .update(`${body.nonce}\0${body.username}\0${body.password}\0${body.admin ? "admin" : "notadmin"}`)
        .digest("hex");
      if (mac !== body.mac) throw fail(403, "M_FORBIDDEN", "HMAC incorrect");
      const id = `@${body.username}:${SERVER}`;
      if (users.has(id)) throw fail(400, "M_USER_IN_USE", "User ID already taken.");
      users.set(id, {
        name: id,
        displayname: body.displayname ?? null,
        deactivated: false,
        admin: !!body.admin,
        user_type: null,
        threepids: [],
        password: body.password,
        profile: {},
      });
      const token = `syt_${randomBytes(8).toString("hex")}`;
      tokens.set(token, id);
      return { user_id: id, access_token: token, home_server: SERVER, device_id: "D" };
    },
    "none",
  );
  on(
    "POST",
    "/_matrix/client/v3/login",
    ({ body }) => {
      const id = `@${body.identifier?.user}:${SERVER}`;
      const u = user(id);
      if (!u || u.deactivated || !u.password || u.password !== body.password) throw fail(403, "M_FORBIDDEN", "Invalid username or password");
      const token = `syt_${randomBytes(8).toString("hex")}`;
      tokens.set(token, id);
      return { user_id: id, access_token: token, device_id: "D" };
    },
    "none",
  );
  on("GET", "/_matrix/client/v3/account/whoami", ({ me }) => ({ user_id: me }));
  on("GET", "/_synapse/admin/v1/server_version", () => ({ server_version: "1.165.0" }), "admin");
  on(
    "GET",
    "/_synapse/admin/v2/users",
    ({ query }) => {
      const list = [...users.values()]
        .filter((u) => query.get("deactivated") === "true" || !u.deactivated)
        .map((u) => ({ name: u.name, displayname: u.displayname, deactivated: u.deactivated, admin: u.admin, user_type: u.user_type, creation_ts: 0 }));
      const from = Number(query.get("from") ?? 0);
      const limit = Number(query.get("limit") ?? 100);
      const page = list.slice(from, from + limit);
      return { users: page, total: list.length, ...(from + limit < list.length && { next_token: String(from + limit) }) };
    },
    "admin",
  );
  on(
    "GET",
    "/_synapse/admin/v2/users/:id",
    ({ params }) => {
      const u = user(params[0]!);
      if (!u) throw fail(404, "M_NOT_FOUND", "User not found");
      return { name: u.name, displayname: u.displayname, deactivated: u.deactivated, admin: u.admin, user_type: u.user_type, threepids: u.threepids };
    },
    "admin",
  );
  on(
    "PUT",
    "/_synapse/admin/v2/users/:id",
    ({ params, body }) => {
      const id = params[0]!;
      if (!id.endsWith(`:${SERVER}`) || !/^@[a-z0-9._=/+-]+:/.test(id)) throw fail(400, "M_INVALID_USERNAME", "Invalid user id");
      const have = user(id);
      const u: User = have ?? { name: id, displayname: null, deactivated: false, admin: false, user_type: null, threepids: [], password: null, profile: {} };
      if (body.displayname !== undefined) u.displayname = body.displayname;
      if (body.threepids) u.threepids = body.threepids;
      if (body.user_type !== undefined) u.user_type = body.user_type;
      if (body.password !== undefined) u.password = body.password;
      if (body.deactivated === false) u.deactivated = false;
      users.set(id, u);
      return { name: id, displayname: u.displayname };
    },
    "admin",
  );
  on(
    "POST",
    "/_synapse/admin/v1/deactivate/:id",
    ({ params, me }) => {
      const u = user(params[0]!);
      if (!u) throw fail(404, "M_NOT_FOUND", "User not found");
      u.deactivated = true;
      u.password = null;
      for (const [t, who] of tokens) if (who === u.name) tokens.delete(t);
      for (const room of rooms.values()) if (membership(room, u.name) === "join") setMembership(room, u.name, u.name, "leave");
      void me;
      return { id_server_unbind_result: "success" };
    },
    "admin",
  );
  on(
    "POST",
    "/_synapse/admin/v1/users/:id/login",
    ({ params, body }) => {
      const u = user(params[0]!);
      if (!u) throw fail(404, "M_NOT_FOUND", "User not found");
      if (u.deactivated) throw fail(400, "M_UNKNOWN", "User is deactivated");
      if (typeof body.valid_until_ms !== "number") throw fail(400, "M_INVALID_PARAM", "valid_until_ms");
      const token = `syt_p${randomBytes(8).toString("hex")}`;
      tokens.set(token, u.name);
      return { access_token: token };
    },
    "admin",
  );
  on(
    "GET",
    "/_synapse/admin/v1/rooms",
    ({ query }) => {
      const list = [...rooms.values()].map((r) => ({
        room_id: r.id,
        name: r.state.get("m.room.name|")?.content.name ?? null,
        canonical_alias: r.state.get("m.room.canonical_alias|")?.content.alias ?? null,
        joined_members: joined(r).length,
        joined_local_members: joined(r).length,
        join_rules: r.state.get("m.room.join_rules|")?.content.join_rule ?? null,
        public: r.visibility === "public",
        encryption: r.state.get("m.room.encryption|")?.content.algorithm ?? null,
        room_type: r.state.get("m.room.create|")?.content.type ?? null,
        creator: r.state.get("m.room.create|")?.sender,
      }));
      const from = Number(query.get("from") ?? 0);
      const limit = Number(query.get("limit") ?? 100);
      return { rooms: list.slice(from, from + limit), total_rooms: list.length, offset: from, ...(from + limit < list.length && { next_batch: from + limit }) };
    },
    "admin",
  );
  on(
    "GET",
    "/_synapse/admin/v1/rooms/:id/members",
    ({ params }) => ({ members: joined(roomOf(params[0]!)), total: joined(roomOf(params[0]!)).length }),
    "admin",
  );
  on("GET", "/_synapse/admin/v1/rooms/:id/state", ({ params }) => ({ state: [...roomOf(params[0]!).state.values()] }), "admin");
  on(
    "GET",
    "/_synapse/admin/v1/rooms/:id/messages",
    ({ params, query, me }) => {
      const room = roomOf(params[0]!);
      return page(room, me, query);
    },
    "admin",
  );
  on(
    "POST",
    "/_synapse/admin/v1/join/:id",
    ({ params, body, me }) => {
      const room = roomOf(params[0]!);
      const target = body.user_id as string;
      if (!user(target) || user(target)!.deactivated) throw fail(404, "M_NOT_FOUND", "User not found");
      const rule = room.state.get("m.room.join_rules|")?.content.join_rule;
      if (rule !== "public") {
        if (!visible(room, me)) throw fail(403, "M_FORBIDDEN", `${me} is not in the room`);
        if (level(room, me) < (room.state.get("m.room.power_levels|")?.content.invite ?? 0)) throw fail(403, "M_FORBIDDEN", "Cannot invite");
      }
      joinRoom(room, target, true);
      return { room_id: room.id };
    },
    "admin",
  );
  on(
    "POST",
    "/_synapse/admin/v1/rooms/:id/make_room_admin",
    ({ params, body }) => {
      const room = roomOf(params[0]!);
      const top = joined(room).find((id) => level(room, id) >= 100);
      if (!top) throw fail(400, "M_UNKNOWN", "No local admin user in room");
      const pl = room.state.get("m.room.power_levels|")!.content;
      addEvent(room, top, "m.room.power_levels", { ...pl, users: { ...pl.users, [body.user_id]: 100 } }, "");
      if (membership(room, body.user_id) !== "join") setMembership(room, top, body.user_id, "invite");
      return {};
    },
    "admin",
  );
  on(
    "GET",
    "/_synapse/admin/v1/statistics/users/media",
    () => {
      const by = new Map<string, number>();
      for (const m of media.values()) by.set(m.by, (by.get(m.by) ?? 0) + m.data.length);
      return { users: [...by].map(([user_id, media_length]) => ({ user_id, media_length, media_count: 1 })), total: by.size };
    },
    "admin",
  );
  on(
    "GET",
    "/_synapse/admin/v1/statistics/database/rooms",
    () => {
      if (state.sqlite) throw fail(400, "M_UNKNOWN", "Only available with Postgres");
      return { rooms: [...rooms.values()].map((r) => ({ room_id: r.id, estimated_size: JSON.stringify(r.timeline).length })) };
    },
    "admin",
  );

  // ---------------------------------------------------------------- client API

  on("POST", "/_matrix/client/v3/createRoom", ({ me, body }) => ({ room_id: createRoom(me, body).id }));
  on("GET", "/_matrix/client/v3/directory/room/:alias", ({ params }) => {
    const id = aliases.get(params[0]!);
    if (!id) throw fail(404, "M_NOT_FOUND", "Room alias not found");
    return { room_id: id, servers: [SERVER] };
  });
  on("GET", "/_matrix/client/v3/directory/list/room/:id", ({ params }) => ({ visibility: roomOf(params[0]!).visibility }));
  on("PUT", "/_matrix/client/v3/directory/list/room/:id", ({ params, body, me }) => {
    if (!user(me)?.admin) throw fail(403, "M_FORBIDDEN", "Not allowed to publish room");
    roomOf(params[0]!).visibility = body.visibility;
    return {};
  });
  // As Synapse does: the directory lists only rooms anyone may join, never restricted ones, even when published.
  // A space's rooms, one level down (MSC2946), as the space's members see them.
  on("GET", "/_matrix/client/v1/rooms/:id/hierarchy", ({ params }) => {
    const space = roomOf(params[0]!);
    const children = [...space.state.entries()]
      .filter(([k, e]) => k.startsWith("m.space.child|") && e.content?.via)
      .map(([k]) => rooms.get(k.slice("m.space.child|".length)))
      .filter((r): r is NonNullable<typeof r> => !!r);
    const out = (r: (typeof children)[number]) => ({
      room_id: r.id,
      name: r.state.get("m.room.name|")?.content.name,
      topic: r.state.get("m.room.topic|")?.content.topic,
      canonical_alias: r.state.get("m.room.canonical_alias|")?.content.alias,
      num_joined_members: joined(r).length,
      join_rule: r.state.get("m.room.join_rules|")?.content.join_rule,
      room_type: r.state.get("m.room.create|")?.content.type,
    });
    return { rooms: [out(space), ...children.map(out)] };
  });
  on("GET", "/_matrix/client/v3/publicRooms", () => ({
    chunk: [...rooms.values()]
      .filter((r) => r.visibility === "public" && ["public", "knock"].includes(r.state.get("m.room.join_rules|")?.content.join_rule))
      .map((r) => ({
        room_id: r.id,
        name: r.state.get("m.room.name|")?.content.name,
        topic: r.state.get("m.room.topic|")?.content.topic,
        canonical_alias: r.state.get("m.room.canonical_alias|")?.content.alias,
        num_joined_members: joined(r).length,
        join_rule: r.state.get("m.room.join_rules|")?.content.join_rule,
      })),
    total_room_count_estimate: rooms.size,
  }));
  on("GET", "/_matrix/client/v3/rooms/:id/state", ({ params, me }) => {
    const room = roomOf(params[0]!);
    must(room, me);
    return [...room.state.values()];
  });
  on("PUT", "/_matrix/client/v3/rooms/:id/state/:type/:key", ({ params, me, body }) => {
    const room = roomOf(params[0]!);
    must(room, me);
    if (level(room, me) < needed(room, params[1]!, true)) throw fail(403, "M_FORBIDDEN", `You don't have permission to post ${params[1]}`);
    return { event_id: addEvent(room, me, params[1]!, body, params[2]!).event_id };
  });
  on("POST", "/_matrix/client/v3/rooms/:id/kick", ({ params, me, body }) => {
    const room = roomOf(params[0]!);
    must(room, me);
    if (level(room, me) < (room.state.get("m.room.power_levels|")?.content.kick ?? 50)) throw fail(403, "M_FORBIDDEN", "Cannot kick");
    setMembership(room, me, body.user_id, "leave");
    return {};
  });
  on("POST", "/_matrix/client/v3/join/:id", ({ params, me }) => {
    const room = roomOf(params[0]!);
    joinRoom(room, me);
    return { room_id: room.id };
  });
  on("POST", "/_matrix/client/v3/rooms/:id/leave", ({ params, me }) => {
    const room = roomOf(params[0]!);
    setMembership(room, me, me, "leave");
    return {};
  });
  on("PUT", "/_matrix/client/v3/rooms/:id/send/:type/:txn", ({ params, me, body }) => {
    const key = `${me}|${params[2]}`;
    if (txns.has(key)) return { event_id: txns.get(key) };
    const room = roomOf(params[0]!);
    must(room, me);
    if (level(room, me) < needed(room, params[1]!, false)) throw fail(403, "M_FORBIDDEN", `You don't have permission to post ${params[1]} events`);
    const e = addEvent(room, me, params[1]!, body);
    txns.set(key, e.event_id);
    return { event_id: e.event_id };
  });
  on("PUT", "/_matrix/client/v3/rooms/:id/redact/:event/:txn", ({ params, me, body }) => {
    const room = roomOf(params[0]!);
    must(room, me);
    const target = room.timeline.find((e) => e.event_id === params[1]);
    if (!target) throw fail(404, "M_NOT_FOUND", "Event not found");
    if (target.sender !== me && level(room, me) < (room.state.get("m.room.power_levels|")?.content.redact ?? 50))
      throw fail(403, "M_FORBIDDEN", "Cannot redact");
    return { event_id: addEvent(room, me, "m.room.redaction", body, undefined, { redacts: params[1] }).event_id };
  });
  on("GET", "/_matrix/client/v3/rooms/:id/event/:event", ({ params, me }) => {
    const room = roomOf(params[0]!);
    must(room, me);
    const e = room.timeline.find((x) => x.event_id === params[1]);
    if (!e) throw fail(404, "M_NOT_FOUND", "Event not found");
    return view(room, e, me);
  });
  on("GET", "/_matrix/client/v3/rooms/:id/messages", ({ params, me, query }) => {
    const room = roomOf(params[0]!);
    must(room, me);
    return page(room, me, query);
  });
  on("GET", "/_matrix/client/v3/rooms/:id/joined_members", ({ params, me }) => {
    const room = roomOf(params[0]!);
    must(room, me);
    return { joined: Object.fromEntries(joined(room).map((id) => [id, { display_name: user(id)?.displayname ?? null }])) };
  });
  const relations: Handler = ({ params, me, query }) => {
    const room = roomOf(params[0]!);
    must(room, me);
    const [, eventId, relType, eventType] = params;
    let chunk = room.timeline.filter(
      (e) => e.content?.["m.relates_to"]?.event_id === eventId && e.content["m.relates_to"].rel_type === relType && (!eventType || e.type === eventType),
    );
    if (query.get("dir") !== "f") chunk = chunk.reverse();
    return { chunk: chunk.slice(0, Number(query.get("limit") ?? 50)).map((e) => view(room, e, me)) };
  };
  on("GET", "/_matrix/client/v1/rooms/:id/relations/:event/:rel", relations);
  on("GET", "/_matrix/client/v1/rooms/:id/relations/:event/:rel/:type", relations);
  on("POST", "/_matrix/client/v3/rooms/:id/read_markers", ({ params, me, body }) => {
    const room = roomOf(params[0]!);
    must(room, me);
    readMarkers.set(`${me}|${room.id}`, Number(String(body["m.read"] ?? "$e0").slice(2)));
    return {};
  });
  on("GET", "/_matrix/client/v3/sync", ({ me, query }) => sync(me, query));
  on("GET", "/_matrix/client/v3/joined_rooms", ({ me }) => ({
    joined_rooms: [...rooms.values()].filter((r) => membership(r, me) === "join").map((r) => r.id),
  }));
  on("POST", "/_matrix/client/v3/search", ({ me, body }) => {
    const c = body.search_categories?.room_events;
    if (!c?.search_term) throw fail(400, "M_BAD_JSON", "search_term is required");
    const f = c.filter ?? {};
    const words = String(c.search_term)
      .toLowerCase()
      .split(/\s+/)
      .map((w) => w.replace(/"/g, ""))
      .filter(Boolean);
    const results = [];
    for (const room of rooms.values()) {
      if (membership(room, me) !== "join" || (f.rooms && !f.rooms.includes(room.id))) continue;
      for (const e of room.timeline) {
        if (e.type !== "m.room.message" || (f.senders && !f.senders.includes(e.sender)) || (f.contains_url && !e.content.url)) continue;
        const body = String(e.content.body ?? "").toLowerCase();
        if (words.every((w) => body.includes(w))) results.push({ rank: 1, result: view(room, e, me) });
      }
    }
    results.sort((a, b) => b.result.origin_server_ts - a.result.origin_server_ts);
    return { search_categories: { room_events: { results, count: results.length } } };
  });
  on("GET", "/_matrix/client/v3/profile/:id", ({ params }) => {
    const u = user(params[0]!);
    if (!u) throw fail(404, "M_NOT_FOUND", "Profile was not found");
    return { displayname: u.displayname, ...u.profile };
  });
  on("GET", "/_matrix/client/v3/user/:id/account_data/:type", ({ params, me }) => {
    if (params[0] !== me) throw fail(403, "M_FORBIDDEN", "Cannot get account data for other users.");
    const v = accountData.get(me)?.get(params[1]!);
    if (v === undefined) throw fail(404, "M_NOT_FOUND", "Account data not found");
    return v;
  });
  on("PUT", "/_matrix/client/v3/user/:id/account_data/:type", ({ params, me, body }) => {
    if (params[0] !== me) throw fail(403, "M_FORBIDDEN", "Cannot add account data for other users.");
    if (!accountData.has(me)) accountData.set(me, new Map());
    accountData.get(me)!.set(params[1]!, body);
    return {};
  });
  on("POST", "/_matrix/media/v3/upload", ({ me, raw, headers }) => {
    const id = `m${next()}`;
    media.set(id, { type: headers.get("content-type") ?? "application/octet-stream", data: raw, by: me });
    return { content_uri: `mxc://${SERVER}/${id}` };
  });
  on("GET", "/_matrix/client/v1/media/download/:server/:media", ({ params }) => {
    const m = media.get(params[1]!);
    if (!m || params[0] !== SERVER) throw fail(404, "M_NOT_FOUND", "Not found");
    return new Response(new Uint8Array(m.data), { status: 200, headers: { "content-type": m.type } });
  });

  function page(room: Room, me: string, query: URLSearchParams) {
    void me;
    const limit = Number(query.get("limit") ?? 10);
    const dir = query.get("dir") ?? "b";
    const all = room.timeline;
    if (dir === "b") {
      const end = query.get("from") ? Number(query.get("from")!.slice(1)) : all.length;
      const start = Math.max(0, end - limit);
      const chunk = all
        .slice(start, end)
        .reverse()
        .map((e) => view(room, e, me));
      return { chunk, start: `t${end}`, ...(start > 0 && { end: `t${start}` }) };
    }
    const from = query.get("from") ? Number(query.get("from")!.slice(1)) : 0;
    const chunk = all.slice(from, from + limit).map((e) => view(room, e, me));
    return { chunk, start: `t${from}`, ...(from + limit < all.length && { end: `t${from + limit}` }) };
  }

  async function handle(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
    if (state.down) throw new TypeError("fetch failed: connect ECONNREFUSED");
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const raw = init.body instanceof Uint8Array ? Buffer.from(init.body) : typeof init.body === "string" ? Buffer.from(init.body) : Buffer.alloc(0);
    const token = headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    const me = tokens.get(token) ?? "";
    for (const [m, re, check, handler] of routes) {
      if (m !== method) continue;
      const match = re.exec(url.pathname);
      if (!match) continue;
      const params = match.slice(1).map(decodeURIComponent);
      const isJson = headers.get("content-type") === "application/json";
      let body: any = {};
      if (isJson && raw.length) body = JSON.parse(raw.toString());
      calls.push({ as: me || null, method, path: url.pathname, ...(isJson && { body }) });
      try {
        if (check) {
          if (!me) throw fail(401, "M_UNKNOWN_TOKEN", "Invalid access token passed.");
          if (user(me)?.deactivated) throw fail(401, "M_UNKNOWN_TOKEN", "User account has been deactivated");
          check({ me, params, body, query: url.searchParams, raw, headers });
        }
        const out = await handler({ me, params, body, query: url.searchParams, raw, headers });
        if (out instanceof Response) return out;
        return Response.json(out ?? {});
      } catch (err) {
        if (err instanceof Fail) return Response.json({ errcode: err.errcode, error: err.message }, { status: err.status });
        throw err;
      }
    }
    return Response.json({ errcode: "M_UNRECOGNIZED", error: `Unrecognized request ${method} ${url.pathname}` }, { status: 404 });
  }

  return {
    fetch: handle as typeof fetch,
    users,
    rooms,
    aliases,
    calls,
    state,
    presence,
    /** A person who signed in to Element once, as Synapse makes them through OIDC. */
    person(localpart: string, displayname: string, email = `${localpart}@${SERVER}`) {
      const id = `@${localpart}:${SERVER}`;
      users.set(id, {
        name: id,
        displayname,
        deactivated: false,
        admin: false,
        user_type: null,
        threepids: [{ medium: "email", address: email }],
        password: null,
        profile: {},
      });
      return id;
    },
    /** A token for a person, as Element has after signing in. */
    tokenOf(userId: string) {
      const token = `syt_el${randomBytes(6).toString("hex")}`;
      tokens.set(token, userId);
      return token;
    },
    roomByAlias: (alias: string) => rooms.get(aliases.get(alias) ?? ""),
    stateOf: (roomId: string, type: string, key = "") => rooms.get(roomId)?.state.get(`${type}|${key}`)?.content,
    members: (roomId: string) => joined(roomOf(roomId)),
    /** Sends an event as someone, as their Matrix app would. */
    post(roomId: string, sender: string, content: Record<string, any>, type = "m.room.message") {
      return addEvent(roomOf(roomId), sender, type, content);
    },
    setProfile(userId: string, field: string, value: unknown) {
      users.get(userId)!.profile[field] = value;
    },
  };
}

export type FakeSynapse = ReturnType<typeof fakeSynapse>;
