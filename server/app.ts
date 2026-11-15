import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { atLeast, AuthError, identityOrigin, mergeOpenApi, sendProblem, type Auth, type Role } from "@openasy/auth";
import { ChatError, type Chat, type ProblemCode } from "./chat.ts";
import { log } from "./log.ts";
import { countRequest, renderMetrics } from "./metrics.ts";
import type { ProductLink } from "./products.ts";

export interface AppOptions {
  db: DatabaseSync;
  chat: Chat;
  version: string;
  /** Sign-in, sessions, members and API tokens (ADR 0002, 0003). */
  auth: Auth;
  /** For tests and local scripts: one shared token with the admin role. main.ts never sets it. */
  adminToken?: string;
  /** For tests and local scripts: tokens that act as a signed-in person, with their email and role. main.ts never sets it. */
  personTokens?: Record<string, { email: string; name?: string; role: Role }>;
  /** Built web UI; omit to run headless (ADR 0018). */
  webDir?: string;
  /** Built API reference (Swagger UI), served at /api/docs. */
  docsDir?: string;
  /** The OpenAPI description, served at /api/openapi.json with this release's version. */
  openapi?: Record<string, unknown>;
  /** false when /metrics is served on its own port instead (ADR 0026). */
  serveMetrics?: boolean;
  /** The install's OpenAsy products and their addresses, from OPENASY_PRODUCTS, for the product switcher. */
  products?: ProductLink[];
}

function metricsText(chat: Chat, version: string) {
  return renderMetrics(version, { ...chat.gauges(), fileError: !!chat.summary().file?.error });
}

/** Serves only /metrics, for a port that is not exposed with the rest (CHAT_METRICS_PORT). */
export function createMetricsHandler(chat: Chat, version: string) {
  return (req: IncomingMessage, res: ServerResponse) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/metrics") return problem(res, 404, "not-found");
    send(res, 200, metricsText(chat, version), "text/plain; version=0.0.4");
  };
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// Identity keeps people's theme and language when they sign in through it; the pages read them there (ADR 0033).
const IDENTITY = identityOrigin(process.env);

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": `default-src 'self'; connect-src 'self'${IDENTITY ? ` ${IDENTITY}` : ""}; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'`,
};

/** Largest file to attach to a message; Synapse's own limit (max_upload_size) may be lower. */
const UPLOAD_LIMIT = 50 * 1024 * 1024;

function send(res: ServerResponse, status: number, body: string | Buffer, type = "application/json", headers: Record<string, string> = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers, "content-type": type, "content-length": Buffer.byteLength(body) });
  res.end(body);
}

const json = (res: ServerResponse, status: number, data: unknown) => send(res, status, JSON.stringify(data), "application/json");

const TITLES: Record<ProblemCode, string> = {
  "invalid-token": "Invalid token",
  "invalid-json": "Invalid JSON",
  "invalid-body": "Invalid request body",
  forbidden: "Forbidden",
  "not-found": "Not found",
  conflict: "Conflict",
  encrypted: "End-to-end encrypted",
  "matrix-unavailable": "Matrix server unavailable",
  "payload-too-large": "Payload too large",
  "internal-error": "Internal error",
};

/** RFC 9457 Problem Details (ADR 0024). `code` is the stable part clients match on. */
function problem(res: ServerResponse, status: number, code: ProblemCode, detail?: string) {
  const body = { type: `https://openasy.github.io/problems/${code}`, title: TITLES[code], status, code, ...(detail && { detail }) };
  send(res, status, JSON.stringify(body), "application/problem+json");
}

/** Serves a file from dir, or returns false when the path is outside it or missing. */
async function serveFile(res: ServerResponse, dir: string, relative: string): Promise<boolean> {
  const file = normalize(join(dir, relative));
  if (!file.startsWith(normalize(dir)) || !extname(file)) return false;
  try {
    send(res, 200, await readFile(file), TYPES[extname(file)] ?? "application/octet-stream");
    return true;
  } catch {
    return false;
  }
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new ChatError(413, "payload-too-large", `The body must be at most ${Math.round(limit / 1024 / 1024)} MiB.`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  const raw = await readBody(req, limit);
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new ChatError(400, "invalid-json", "The body must be JSON.");
  }
}

function tokenMatches(header: string | undefined, expected: string | undefined): boolean {
  if (!expected || !header?.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The role a route needs (ADR 0003). "none" for the version, guests' welcome links and the apps' webhooks; "self" for a
 * person's own conversations, which need a signed-in person (not an API token) and act only as that person; "maker"
 * for making a channel, which a signed-in person does for themselves and a product does with an editor token.
 */
type Access = "none" | "self" | "maker" | Role;
interface Who {
  /** The signed-in person, for "self" and "maker" routes. */
  email: string;
  name: string;
  role: Role;
  /** The API token's name, when a product calls with one. */
  token: string | null;
}
interface Ctx extends Who {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: string[];
}
interface Route {
  method: string;
  /** Path pattern; each `:name` matches one segment. */
  path: string;
  auth: Access;
  handle: (ctx: Ctx) => unknown;
}

const ME_ONLY = "Only a signed-in person can use their conversations, not an API token.";

export function createApp({
  db,
  chat,
  version,
  auth,
  adminToken,
  personTokens = {},
  webDir,
  docsDir,
  openapi,
  serveMetrics = true,
  products = [],
}: AppOptions) {
  // The served description includes /api/v1/auth from @openasy/auth, so the API reference documents sign-in too.
  const spec = openapi && JSON.stringify({ ...mergeOpenApi(openapi), info: { ...(openapi.info as object), version } });
  const noContent = (res: ServerResponse) => {
    res.writeHead(204, SECURITY_HEADERS).end();
  };
  const download = (res: ServerResponse, body: Buffer, type: string, name: string, inline = false) =>
    send(res, 200, body, type, {
      "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`,
      "cache-control": "private, max-age=3600",
    });

  const routes: Route[] = [
    { method: "GET", path: "/api/v1/version", auth: "none", handle: () => ({ product: "chat", version }) },
    { method: "GET", path: "/api/v1/products", auth: "user", handle: () => ({ products }) },
    { method: "GET", path: "/api/v1/summary", auth: "viewer", handle: () => chat.summary() },
    { method: "GET", path: "/api/v1/me", auth: "self", handle: ({ email, name, role }) => chat.me(email, name).then((m) => ({ ...m, name, role })) },

    // The channels and apps, as the file sets them. There is no route that adds, changes or removes one of them.
    { method: "GET", path: "/api/v1/config", auth: "viewer", handle: () => configView() },
    {
      method: "GET",
      path: "/api/v1/sync",
      auth: "viewer",
      handle: () => ({
        last: chat.lastSync(),
        runs: db
          .prepare("SELECT at, ok, created, updated, released, warnings, error FROM sync_runs ORDER BY id DESC LIMIT 20")
          .all()
          .map((r) => ({ ...r, ok: r.ok === 1 })),
      }),
    },
    { method: "POST", path: "/api/v1/sync", auth: "admin", handle: () => chat.syncNow() },

    // A person's own conversations, as the Matrix server keeps them.
    { method: "GET", path: "/api/v1/conversations", auth: "self", handle: ({ email, name }) => chat.conversations(email, name) },
    { method: "POST", path: "/api/v1/conversations/direct", auth: "self", handle: async ({ req, email }) => chat.direct(email, await readJson(req)) },
    { method: "GET", path: "/api/v1/conversations/:id", auth: "self", handle: ({ email, params }) => chat.conversation(email, params[0]!) },
    {
      method: "GET",
      path: "/api/v1/conversations/:id/messages",
      auth: "self",
      handle: ({ email, params, url }) => chat.messages(email, params[0]!, url.searchParams.get("before")),
    },
    {
      method: "POST",
      path: "/api/v1/conversations/:id/messages",
      auth: "self",
      handle: async ({ req, res, email, params }) => json(res, 201, await chat.send(email, params[0]!, await readJson(req))),
    },
    {
      method: "GET",
      path: "/api/v1/conversations/:id/threads/:event",
      auth: "self",
      handle: ({ email, params }) => chat.thread(email, params[0]!, params[1]!),
    },
    {
      method: "POST",
      path: "/api/v1/conversations/:id/messages/:event/reactions",
      auth: "self",
      handle: async ({ req, email, params }) => chat.react(email, params[0]!, params[1]!, await readJson(req)),
    },
    {
      method: "POST",
      path: "/api/v1/conversations/:id/read",
      auth: "self",
      handle: async ({ req, res, email, params }) => (await chat.markRead(email, params[0]!, await readJson(req)), noContent(res)),
    },
    {
      method: "POST",
      path: "/api/v1/conversations/:id/join",
      auth: "self",
      handle: async ({ res, email, params }) => (await chat.join(email, params[0]!), noContent(res)),
    },
    {
      method: "POST",
      path: "/api/v1/conversations/:id/leave",
      auth: "self",
      handle: async ({ res, email, params }) => (await chat.leave(email, params[0]!), noContent(res)),
    },
    {
      method: "GET",
      path: "/api/v1/wait",
      auth: "self",
      handle: ({ email, url }) => chat.wait(email, url.searchParams.get("since")),
    },
    {
      method: "POST",
      path: "/api/v1/files",
      auth: "self",
      handle: async ({ req, res, email }) => {
        const name =
          decodeURIComponent(String(req.headers["x-file-name"] ?? "file"))
            .replace(/[\\/]+/g, "_")
            .slice(0, 255) || "file";
        const type = String(req.headers["content-type"] ?? "application/octet-stream").split(";")[0]!;
        json(res, 201, await chat.upload(email, type, name, await readBody(req, UPLOAD_LIMIT)));
      },
    },
    {
      method: "GET",
      path: "/api/v1/files/:server/:media",
      auth: "self",
      handle: async ({ res, email, params, url }) => {
        const { data, type } = await chat.download(email, params[0]!, params[1]!);
        const inline = /^image\/(png|jpeg|gif|webp)$/.test(type);
        download(res, data, inline ? type : "application/octet-stream", url.searchParams.get("name") || params[1]!, inline);
      },
    },
    { method: "GET", path: "/api/v1/search", auth: "self", handle: ({ email, url }) => chat.search(email, url.searchParams) },
    { method: "GET", path: "/api/v1/people", auth: "self", handle: ({ email }) => chat.people(email) },

    // Channels: browse and join those open to the company, make one, and for admins, set the rules of those people made.
    { method: "GET", path: "/api/v1/directory", auth: "self", handle: ({ email }) => chat.browse(email) },
    {
      method: "POST",
      path: "/api/v1/channels",
      auth: "maker",
      handle: async ({ req, res, email, name, token }) => json(res, 201, await chat.createChannel(token ? { token } : { email, name }, await readJson(req))),
    },
    { method: "GET", path: "/api/v1/channels", auth: "viewer", handle: () => chat.channels() },
    { method: "PATCH", path: "/api/v1/channels/:id", auth: "admin", handle: async ({ req, params }) => chat.updateChannel(params[0]!, await readJson(req)) },

    // Guests from outside the company: invited by a member to one channel, until a day.
    {
      method: "POST",
      path: "/api/v1/guests",
      auth: "self",
      handle: async ({ req, res, email }) => json(res, 201, await chat.inviteGuest(email, await readJson(req))),
    },
    {
      method: "DELETE",
      path: "/api/v1/guests/:id",
      auth: "self",
      handle: async ({ res, email, role, params }) => (await chat.endGuest({ email, admin: atLeast(role, "admin") }, params[0]!), noContent(res)),
    },
    { method: "GET", path: "/api/v1/welcome/:token", auth: "none", handle: ({ params }) => chat.welcomeInfo(params[0]!) },
    { method: "POST", path: "/api/v1/welcome/:token", auth: "none", handle: async ({ req, params }) => chat.acceptWelcome(params[0]!, await readJson(req)) },

    // Exports for a legal request, and the holds that keep messages past their retention.
    { method: "GET", path: "/api/v1/exports", auth: "admin", handle: () => ({ exports: chat.exports(), holds: chat.holds() }) },
    {
      method: "POST",
      path: "/api/v1/exports",
      auth: "admin",
      handle: async ({ req, res, email }) => json(res, 201, await chat.startExport(email || "api", await readJson(req))),
    },
    { method: "GET", path: "/api/v1/exports/key", auth: "viewer", handle: ({ res }) => send(res, 200, chat.publicKey(), "application/x-pem-file") },
    { method: "GET", path: "/api/v1/exports/:id", auth: "admin", handle: ({ params }) => chat.exportRow(params[0]!) },
    {
      method: "GET",
      path: "/api/v1/exports/:id/archive",
      auth: "admin",
      handle: ({ res, params }) => {
        const { name, data } = chat.exportArchive(params[0]!);
        download(res, data, "application/zip", name);
      },
    },
    { method: "POST", path: "/api/v1/holds/:id/release", auth: "admin", handle: ({ params, email }) => chat.releaseHold(params[0]!, email || "api") },

    // The apps of the file and their webhook addresses, the Matrix server and Identity.
    { method: "GET", path: "/api/v1/integrations", auth: "viewer", handle: () => chat.integrations() },
    {
      method: "POST",
      path: "/api/v1/apps/:name/hook",
      auth: "admin",
      handle: ({ res, params, email }) => json(res, 201, chat.hookFor(params[0]!, email || "api")),
    },
  ];

  const configView = () => {
    const c = chat.config();
    return {
      channels: c.channels.map((ch) => ({ ...ch, retention: ch.retention === "forever" ? "forever" : `${ch.retention.days}d` })),
      apps: c.apps,
      defaults: { retention: c.defaults.retention === "forever" ? "forever" : `${c.defaults.retention.days}d` },
      guests: c.guestsPolicy,
      file: chat.summary().file,
    };
  };

  const compiled = routes.map((r) => ({ ...r, re: new RegExp(`^${r.path.replace(/:[a-z]+/g, "([^/]+)")}$`) }));

  function authorize(req: IncomingMessage, access: Access): Who {
    const none: Who = { email: "", name: "", role: "user", token: null };
    if (access === "none") return none;
    if (access !== "self" && tokenMatches(req.headers.authorization, adminToken)) return { ...none, role: "admin", token: "test" };
    for (const [token, p] of Object.entries(personTokens))
      if (tokenMatches(req.headers.authorization, token)) {
        if (access !== "self" && access !== "maker" && !atLeast(p.role, access)) throw new AuthError(403, "forbidden", `This needs the ${access} role.`);
        return { email: p.email, name: p.name ?? p.email, role: p.role, token: null };
      }
    if (access === "maker") {
      const p = auth.authorize(req, "user");
      if (p.kind === "session") return { email: p.user.email, name: p.user.name, role: p.role, token: null };
      if (!atLeast(p.role, "editor")) throw new AuthError(403, "forbidden", "Making a channel with an API token needs the editor role.");
      return { ...none, role: p.role, token: p.name };
    }
    const p = auth.authorize(req, access === "self" ? "user" : access);
    if (p.kind === "session") return { email: p.user.email, name: p.user.name, role: p.role, token: null };
    if (access === "self") throw new AuthError(403, "forbidden", ME_ONLY);
    return { ...none, role: p.role, token: p.name };
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<string> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path === "/healthz") return (json(res, 200, { status: "ok" }), "/healthz");

    if (path === "/readyz") {
      // Ready while the database answers; the Matrix server being away shows in the summary, not here, so the sign-in
      // and the pages stay up to say so.
      try {
        db.prepare("SELECT 1").get();
        json(res, 200, { status: "ready" });
      } catch {
        json(res, 503, { status: "database unavailable" });
      }
      return "/readyz";
    }

    if (path === "/metrics") {
      if (serveMetrics) send(res, 200, metricsText(chat, version), "text/plain; version=0.0.4");
      else problem(res, 404, "not-found");
      return "/metrics";
    }

    if (path === "/api/openapi.json" && spec) return (send(res, 200, spec), "/api/openapi.json");

    if (docsDir && (path === "/api/docs" || path.startsWith("/api/docs/"))) {
      if (path === "/api/docs") {
        res.writeHead(301, { ...SECURITY_HEADERS, location: "/api/docs/" }).end();
        return "/api/docs";
      }
      const relative = path.slice("/api/docs/".length) || "index.html";
      if (!(await serveFile(res, docsDir, relative))) problem(res, 404, "not-found");
      return "/api/docs";
    }

    // An app's webhook: the address is the key, so it takes no sign-in.
    const hook = /^\/hooks\/([A-Za-z0-9_-]{20,96})$/.exec(path);
    if (hook) {
      try {
        if (req.method !== "POST") throw new ChatError(404, "not-found", "Webhooks take POST.");
        json(res, 202, await chat.hook(hook[1]!, await readJson(req)));
      } catch (err) {
        if (!(err instanceof ChatError)) throw err;
        problem(res, err.status, err.code, err.message);
        if (!req.complete) req.resume();
      }
      return "/hooks/{token}";
    }

    if (await auth.handle(req, res)) return auth.routeName(req) ?? "/api/v1/auth/*";

    for (const r of compiled) {
      const m = path.match(r.re);
      if (!m || r.method !== req.method) continue;
      try {
        const who = authorize(req, r.auth);
        const params = m.slice(1).map(decodeURIComponent);
        const result = await r.handle({ req, res, url, params, ...who });
        if (!res.headersSent && result !== undefined) json(res, 200, result);
      } catch (err) {
        if (err instanceof AuthError) {
          sendProblem(res, err);
          if (!req.complete) req.resume();
          return r.path;
        }
        if (!(err instanceof ChatError)) throw err;
        problem(res, err.status, err.code, err.message);
        // Unread request bodies would otherwise hold the connection.
        if (!req.complete) req.resume();
      }
      return r.path;
    }

    if (path.startsWith("/api/")) return (problem(res, 404, "not-found"), "/api/*");

    if (webDir && (req.method === "GET" || req.method === "HEAD")) {
      // Unknown paths fall back to the single-page app.
      if (!(await serveFile(res, webDir, path === "/" ? "index.html" : path))) send(res, 200, await readFile(join(webDir, "index.html")), TYPES[".html"]);
      return "/web";
    }

    problem(res, 404, "not-found");
    return "unmatched";
  }

  return async (req: IncomingMessage, res: ServerResponse) => {
    const started = performance.now();
    let routeName = "error";
    try {
      routeName = await route(req, res);
    } catch (err) {
      log("error", "request failed", { error: String(err), path: req.url });
      if (!res.headersSent) problem(res, 500, "internal-error");
    }
    countRequest(req.method ?? "GET", routeName, res.statusCode);
    if (routeName !== "/healthz" && routeName !== "/metrics") {
      log("info", "request", { method: req.method, path: (req.url ?? "/").split("?")[0], status: res.statusCode, ms: Math.round(performance.now() - started) });
    }
  };
}
