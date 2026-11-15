// The Matrix server, Synapse. It stores every message, file and membership, delivers them to Element and other Matrix
// apps, and does encryption where people turn it on. Chat talks to it over two documented APIs: Synapse's admin API
// (/_synapse/admin) with its own service account, to keep the server in step with the file and to act for people,
// and the Matrix client-server API (/_matrix/client), as the service account or as the signed-in person with a token
// Synapse gives the admin for them. People never give Chat a password.
import { createHmac, randomUUID } from "node:crypto";

export class MatrixError extends Error {
  /** The HTTP status Synapse answered with, or 0 when it could not be reached. */
  readonly status: number;
  /** Matrix's error code, such as M_FORBIDDEN or M_NOT_FOUND. */
  readonly errcode: string;
  constructor(message: string, status = 0, errcode = "") {
    super(message);
    this.status = status;
    this.errcode = errcode;
  }
}

/** A room event as the client-server API sends it. */
export interface MatrixEvent {
  event_id: string;
  type: string;
  sender: string;
  origin_server_ts: number;
  content: Record<string, any>;
  state_key?: string;
  redacts?: string;
  unsigned?: Record<string, any>;
  room_id?: string;
}

/** A room as Synapse's admin room list describes it. */
export interface AdminRoom {
  room_id: string;
  name: string | null;
  canonical_alias: string | null;
  joined_members: number;
  joined_local_members?: number;
  join_rules: string | null;
  public: boolean;
  encryption: string | null;
  room_type: string | null;
  creator?: string;
}

/** A user as Synapse's admin user list describes it. */
export interface AdminUser {
  name: string;
  displayname: string | null;
  deactivated: boolean;
  admin: boolean;
  user_type: string | null;
  creation_ts?: number;
}

type Query = Record<string, string | number | boolean | undefined>;

export interface MatrixOptions {
  /** Where Chat reaches Synapse's client listener, such as http://synapse:8008. */
  url: string;
  fetch?: typeof fetch;
  clock?: () => number;
}

/** Turns the room, user or event ids Matrix uses into one path segment. */
export const seg = (s: string) => encodeURIComponent(s);

export function createMatrix({ url, fetch: f = fetch, clock = Date.now }: MatrixOptions) {
  const base = url.replace(/\/$/, "");
  let serviceToken = "";
  let serviceUser = "";
  /** Tokens Synapse gave the service account to act as a person, until shortly before they end. */
  const tokens = new Map<string, { token: string; until: number }>();

  async function request<T = any>(
    method: string,
    path: string,
    { token, body, query, raw, type }: { token?: string; body?: unknown; query?: Query; raw?: Buffer; type?: string } = {},
  ): Promise<T> {
    const q = query ? Object.entries(query).filter(([, v]) => v !== undefined) : [];
    const target = `${base}${path}${q.length ? `?${new URLSearchParams(q.map(([k, v]) => [k, String(v)]))}` : ""}`;
    let res: Response;
    try {
      res = await f(target, {
        method,
        headers: {
          ...(token && { authorization: `Bearer ${token}` }),
          ...(raw ? { "content-type": type ?? "application/octet-stream" } : body !== undefined && { "content-type": "application/json" }),
        },
        body: raw ? new Uint8Array(raw) : body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(path.endsWith("/sync") ? 40_000 : 20_000),
      });
    } catch (err) {
      throw new MatrixError(`Synapse did not answer at ${base}: ${(err as Error).message}`);
    }
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { error: text.slice(0, 200) };
    }
    if (!res.ok) throw new MatrixError(data?.error ?? `Synapse answered ${res.status}`, res.status, data?.errcode ?? "");
    return data as T;
  }

  /** Bytes, for media downloads. */
  async function download(path: string, token: string): Promise<{ data: Buffer; type: string }> {
    let res: Response;
    try {
      res = await f(`${base}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) });
    } catch (err) {
      throw new MatrixError(`Synapse did not answer at ${base}: ${(err as Error).message}`);
    }
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string; errcode?: string };
      throw new MatrixError(data.error ?? `Synapse answered ${res.status}`, res.status, data.errcode ?? "");
    }
    return { data: Buffer.from(await res.arrayBuffer()), type: res.headers.get("content-type") ?? "application/octet-stream" };
  }

  const svc = () => {
    if (!serviceToken) throw new MatrixError("Chat has no Synapse service account yet.", 503, "M_UNKNOWN_TOKEN");
    return serviceToken;
  };

  const matrix = {
    request,
    download,
    /** The service account's user id, such as @openasy-chat:example.com. */
    get serviceUser() {
      return serviceUser;
    },
    /** The server name after the colon in every user id: example.com. */
    get serverName() {
      return serviceUser.slice(serviceUser.indexOf(":") + 1);
    },
    /** Uses this token for the service account, after checking it. */
    async useToken(token: string): Promise<string> {
      const who = await request<{ user_id: string }>("GET", "/_matrix/client/v3/account/whoami", { token });
      serviceToken = token;
      serviceUser = who.user_id;
      return who.user_id;
    },
    /**
     * Makes the service account an admin with Synapse's registration shared secret, or signs in to it when it is there,
     * and uses its token. The password is derived from the secret, so nothing else needs keeping.
     */
    async signInService(sharedSecret: string, localpart: string): Promise<string> {
      const password = createHmac("sha256", sharedSecret).update(`openasy-chat:${localpart}`).digest("hex");
      try {
        const { nonce } = await request<{ nonce: string }>("GET", "/_synapse/admin/v1/register");
        const mac = createHmac("sha1", sharedSecret).update(`${nonce}\0${localpart}\0${password}\0admin`).digest("hex");
        const r = await request<{ access_token: string }>("POST", "/_synapse/admin/v1/register", {
          body: { nonce, username: localpart, displayname: "OpenAsy Chat", password, admin: true, mac },
        });
        return await matrix.useToken(r.access_token);
      } catch (err) {
        if (!(err instanceof MatrixError) || err.errcode !== "M_USER_IN_USE") throw err;
      }
      const r = await request<{ access_token: string }>("POST", "/_matrix/client/v3/login", {
        body: { type: "m.login.password", identifier: { type: "m.id.user", user: localpart }, password, initial_device_display_name: "OpenAsy Chat" },
      });
      return matrix.useToken(r.access_token);
    },
    get serviceToken() {
      return svc();
    },
    /** As the service account. */
    svc<T = any>(method: string, path: string, opts: { body?: unknown; query?: Query; raw?: Buffer; type?: string } = {}) {
      return request<T>(method, path, { ...opts, token: svc() });
    },
    /** A token to act as this person, from Synapse's admin login; kept for a day. */
    async tokenFor(userId: string): Promise<string> {
      if (userId === serviceUser) return svc();
      const have = tokens.get(userId);
      if (have && have.until > clock()) return have.token;
      const validUntil = clock() + 24 * 3_600_000;
      const r = await request<{ access_token: string }>("POST", `/_synapse/admin/v1/users/${seg(userId)}/login`, {
        token: svc(),
        body: { valid_until_ms: validUntil },
      });
      tokens.set(userId, { token: r.access_token, until: validUntil - 3_600_000 });
      return r.access_token;
    },
    /** Forgets a person's token, after they leave or their token was refused. */
    forget(userId: string) {
      tokens.delete(userId);
    },
    /** As a person. */
    async as<T = any>(userId: string, method: string, path: string, opts: { body?: unknown; query?: Query; raw?: Buffer; type?: string } = {}): Promise<T> {
      const token = await matrix.tokenFor(userId);
      try {
        return await request<T>(method, path, { ...opts, token });
      } catch (err) {
        if (err instanceof MatrixError && err.errcode === "M_UNKNOWN_TOKEN") {
          tokens.delete(userId);
          return request<T>(method, path, { ...opts, token: await matrix.tokenFor(userId) });
        }
        throw err;
      }
    },
    /** A transaction id for a send, unique to this process. */
    txn: () => randomUUID(),

    // ---------------------------------------------------------------- admin API

    async users(): Promise<AdminUser[]> {
      const out: AdminUser[] = [];
      let from: string | undefined = "0";
      while (from !== undefined) {
        const r: { users: AdminUser[]; next_token?: string } = await matrix.svc("GET", "/_synapse/admin/v2/users", {
          query: { from, limit: 500, deactivated: true, guests: false },
        });
        out.push(...r.users);
        from = r.next_token;
      }
      return out;
    },
    async rooms(): Promise<AdminRoom[]> {
      const out: AdminRoom[] = [];
      let from: number | undefined = 0;
      while (from !== undefined) {
        const r: { rooms: AdminRoom[]; next_batch?: number } = await matrix.svc("GET", "/_synapse/admin/v1/rooms", { query: { from, limit: 500 } });
        out.push(...r.rooms);
        from = r.next_batch;
      }
      return out;
    },
    async roomMembers(roomId: string): Promise<string[]> {
      return (await matrix.svc<{ members: string[] }>("GET", `/_synapse/admin/v1/rooms/${seg(roomId)}/members`)).members;
    },
    async roomState(roomId: string): Promise<MatrixEvent[]> {
      return (await matrix.svc<{ state: MatrixEvent[] }>("GET", `/_synapse/admin/v1/rooms/${seg(roomId)}/state`)).state;
    },
    /** Puts a person of this server into a room, as Synapse's admin join does: no invitation to accept. */
    forceJoin(roomId: string, userId: string) {
      return matrix.svc("POST", `/_synapse/admin/v1/join/${seg(roomId)}`, { body: { user_id: userId } });
    },
    /** Gives the service account the highest power in a room someone else made, so it can set the room's rules. */
    makeRoomAdmin(roomId: string) {
      return matrix.svc("POST", `/_synapse/admin/v1/rooms/${seg(roomId)}/make_room_admin`, { body: { user_id: serviceUser } });
    },
    putUser(userId: string, body: Record<string, unknown>) {
      return matrix.svc("PUT", `/_synapse/admin/v2/users/${seg(userId)}`, { body });
    },
    /** Takes a person out of every room and signs them out on every device; what they wrote stays. */
    deactivate(userId: string) {
      tokens.delete(userId);
      return matrix.svc("POST", `/_synapse/admin/v1/deactivate/${seg(userId)}`, { body: { erase: false } });
    },

    // ---------------------------------------------------------------- client API, as the service account

    async roomIdOf(alias: string): Promise<string | null> {
      try {
        return (await matrix.svc<{ room_id: string }>("GET", `/_matrix/client/v3/directory/room/${seg(alias)}`)).room_id;
      } catch (err) {
        if (err instanceof MatrixError && err.status === 404) return null;
        throw err;
      }
    },
    putState(roomId: string, type: string, stateKey: string, content: unknown, userId?: string) {
      const path = `/_matrix/client/v3/rooms/${seg(roomId)}/state/${seg(type)}/${seg(stateKey)}`;
      return userId ? matrix.as(userId, "PUT", path, { body: content }) : matrix.svc("PUT", path, { body: content });
    },
  };
  return matrix;
}

export type Matrix = ReturnType<typeof createMatrix>;
