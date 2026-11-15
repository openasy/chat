import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPENAPI_TEXT } from "../scripts/openapi.ts";
import { ADMIN_TOKEN, BEN, CHRIS, DANA, EMILY, startApp, VIEWER, type TestApp } from "./test-app.ts";

// Contract tests (ADR 0024): every response the API sends must match openapi.json, and every operation is called.

type Spec = {
  info: { version: string };
  paths: Record<string, Record<string, { responses: Record<string, { $ref?: string; content?: Record<string, { schema: object }> }> }>>;
  components: { responses: Record<string, { content: Record<string, { schema: object }> }> };
};

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Spec;
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const ajv = new Ajv2020({ strict: false, validateFormats: false });
ajv.addSchema(spec, "openapi");

const docsDir = mkdtempSync(join(tmpdir(), "chat-docs-"));
writeFileSync(join(docsDir, "index.html"), "<!doctype html><title>API</title>");

let app: TestApp;
let base: string;
const covered = new Set<string>();

beforeAll(async () => {
  app = await startApp({ version, openapi: spec, docsDir });
  base = app.base;
});
afterAll(() => app.close());

const BINARY = ["application/zip", "application/octet-stream", "image/png", "image/jpeg", "image/gif", "image/webp"];

async function call(method: string, path: string, init: RequestInit = {}, concrete = path) {
  const res = await fetch(base + concrete, { ...init, method, redirect: "manual" });
  const operation = spec.paths[path]?.[method.toLowerCase()];
  expect(operation, `${method} ${path} is not in openapi.json`).toBeDefined();
  covered.add(`${method} ${path}`);
  const declared = operation!.responses[String(res.status)];
  expect(declared, `${method} ${concrete} answered ${res.status}, which openapi.json does not list`).toBeDefined();
  const shared = declared!.$ref?.split("/").pop();
  const response = shared ? spec.components.responses[shared]! : declared!;
  const at = shared
    ? `openapi#/components/responses/${shared}`
    : `openapi#/paths/${path.replaceAll("/", "~1").replaceAll("{", "%7B").replaceAll("}", "%7D")}/${method.toLowerCase()}/responses/${res.status}`;
  if (!response.content) {
    await res.arrayBuffer();
    expect(res.headers.get("content-length") ?? "0", `${method} ${path} ${res.status} should have no body`).toBe("0");
    return { res, body: undefined as any };
  }
  const type = res.headers.get("content-type")!.split(";")[0]!;
  expect(response.content?.[type], `${method} ${path} ${res.status} sent ${type}, which openapi.json does not list`).toBeDefined();
  if (BINARY.includes(type)) return { res, body: Buffer.from(await res.arrayBuffer()) as any };
  const body = type.endsWith("json") ? await res.json() : await res.text();
  const validate = ajv.getSchema(`${at}/content/${type.replace("/", "~1")}/schema`)!;
  expect(validate(body), `${method} ${concrete}: ${JSON.stringify(validate.errors)}`).toBe(true);
  return { res, body: body as any };
}

const as = (token: string, b?: unknown) => ({
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  ...(b !== undefined && { body: typeof b === "string" ? b : JSON.stringify(b) }),
});
const anon = (b?: unknown) => ({ headers: { "content-type": "application/json" }, ...(b !== undefined && { body: JSON.stringify(b) }) });
const at = (p: string, ...ids: Array<string | undefined>) => {
  let i = 0;
  return p.replace(/\{[a-z]+\}/g, () => encodeURIComponent(ids[i++]!));
};

describe("openapi.json", () => {
  it("is what scripts/openapi.ts writes, with the version of this release", () => {
    expect(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")).toBe(OPENAPI_TEXT);
    expect(spec.info.version).toBe(version);
  });

  it("is served with the running version and the sign-in routes", async () => {
    const served = (await (await fetch(`${base}/api/openapi.json`)).json()) as Spec;
    expect(served.info.version).toBe(version);
    expect(Object.keys(served.paths).filter((p) => !p.startsWith("/api/v1/auth/"))).toEqual(Object.keys(spec.paths));
    expect(served.paths["/api/v1/auth/login"]).toBeDefined();
  });

  it("serves the API reference at /api/docs/", async () => {
    expect((await fetch(`${base}/api/docs`, { redirect: "manual" })).headers.get("location")).toBe("/api/docs/");
    expect((await fetch(`${base}/api/docs/`)).headers.get("content-type")).toContain("text/html");
  });
});

describe("responses match openapi.json", () => {
  const ids: Record<string, string> = {};
  const room = (alias: string) => app.fake.roomByAlias(`#${alias}:example.com`)!.id;

  it("product, file and sync", async () => {
    await call("GET", "/api/v1/version");
    await call("GET", "/api/v1/products", as(BEN));
    await call("GET", "/api/v1/products", {});
    for (const p of ["/api/v1/summary", "/api/v1/config", "/api/v1/sync", "/api/v1/integrations", "/api/v1/channels"]) {
      await call("GET", p, as(VIEWER));
      await call("GET", p, as(BEN));
    }
    await call("POST", "/api/v1/sync", as(ADMIN_TOKEN));
    await call("POST", "/api/v1/sync", as(VIEWER));
    await call("GET", "/api/v1/me", as(EMILY));
    await call("GET", "/api/v1/me", as(ADMIN_TOKEN));
    await call("GET", "/healthz");
    await call("GET", "/readyz");
    await call("GET", "/metrics");
  });

  it("conversations, messages, threads and reactions", async () => {
    ids.ops = room("ops-oncall");
    await call("GET", "/api/v1/conversations", as(EMILY));
    await call("GET", "/api/v1/conversations/{id}", as(EMILY), at("/api/v1/conversations/{id}", ids.ops));
    await call("GET", "/api/v1/conversations/{id}", as(EMILY), at("/api/v1/conversations/{id}", "!nope:example.com"));
    const sent = await call(
      "POST",
      "/api/v1/conversations/{id}/messages",
      as(BEN, { text: "@Emily Clark the rollback is done." }),
      at("/api/v1/conversations/{id}/messages", ids.ops),
    );
    ids.root = sent.body.id;
    await call("POST", "/api/v1/conversations/{id}/messages", as(BEN, { text: "" }), at("/api/v1/conversations/{id}/messages", ids.ops));
    await call("POST", "/api/v1/conversations/{id}/messages", as(BEN, "{"), at("/api/v1/conversations/{id}/messages", ids.ops));
    await call("POST", "/api/v1/conversations/{id}/messages", as(BEN, { text: "x" }), at("/api/v1/conversations/{id}/messages", room("leadership")));
    await call(
      "POST",
      "/api/v1/conversations/{id}/messages",
      as(EMILY, { text: "Thanks Ben.", threadRoot: ids.root, alsoInChannel: true }),
      at("/api/v1/conversations/{id}/messages", ids.ops),
    );
    await call("GET", "/api/v1/conversations/{id}/messages", as(EMILY), at("/api/v1/conversations/{id}/messages", ids.ops));
    await call("GET", "/api/v1/conversations/{id}/threads/{event}", as(EMILY), at("/api/v1/conversations/{id}/threads/{event}", ids.ops, ids.root));
    await call("GET", "/api/v1/conversations/{id}/threads/{event}", as(EMILY), at("/api/v1/conversations/{id}/threads/{event}", ids.ops, "$nope"));
    await call(
      "POST",
      "/api/v1/conversations/{id}/messages/{event}/reactions",
      as(EMILY, { emoji: "👍" }),
      at("/api/v1/conversations/{id}/messages/{event}/reactions", ids.ops, ids.root),
    );
    await call(
      "POST",
      "/api/v1/conversations/{id}/messages/{event}/reactions",
      as(EMILY, {}),
      at("/api/v1/conversations/{id}/messages/{event}/reactions", ids.ops, ids.root),
    );
    await call("POST", "/api/v1/conversations/{id}/read", as(EMILY, { eventId: ids.root }), at("/api/v1/conversations/{id}/read", ids.ops));
    await call("POST", "/api/v1/conversations/{id}/read", as(EMILY, {}), at("/api/v1/conversations/{id}/read", ids.ops));
    const w = await call("GET", "/api/v1/wait", as(EMILY));
    await call("GET", "/api/v1/wait", as(EMILY), `/api/v1/wait?since=${w.body.since}`);
    await call("GET", "/api/v1/conversations", as(ADMIN_TOKEN));
  });

  it("files, direct messages, channels and search", async () => {
    const up = await call("POST", "/api/v1/files", {
      headers: { authorization: `Bearer ${BEN}`, "content-type": "application/pdf", "x-file-name": "rollback-checklist.pdf" },
      body: new Uint8Array(Buffer.from("%PDF-1.4 checklist")),
    });
    await call("POST", "/api/v1/files", { headers: { authorization: `Bearer ${BEN}`, "content-type": "application/pdf" }, body: new Uint8Array(0) });
    await call("POST", "/api/v1/conversations/{id}/messages", as(BEN, { text: "", file: up.body }), at("/api/v1/conversations/{id}/messages", ids.ops));
    const [server, media] = (up.body.uri as string).slice(6).split("/");
    await call("GET", "/api/v1/files/{server}/{media}", as(EMILY), `/api/v1/files/${server}/${media}?name=rollback-checklist.pdf`);
    await call("GET", "/api/v1/files/{server}/{media}", as(EMILY), `/api/v1/files/${server}/nope`);
    const dm = await call("POST", "/api/v1/conversations/direct", as(EMILY, { people: ["@ben:example.com"] }));
    await call("POST", "/api/v1/conversations/direct", as(EMILY, { people: ["ben"] }));
    await call("POST", "/api/v1/conversations/{id}/join", as(BEN), at("/api/v1/conversations/{id}/join", dm.body.id));
    await call("POST", "/api/v1/conversations/{id}/join", as(BEN), at("/api/v1/conversations/{id}/join", "!nope:example.com"));
    await call("GET", "/api/v1/directory", as(DANA));
    const made = await call("POST", "/api/v1/channels", as(DANA, { name: "random", topic: "Lunch and the office plants" }));
    ids.random = made.body.id;
    await call("POST", "/api/v1/channels", as(DANA, { name: "random" }));
    await call("POST", "/api/v1/channels", as(DANA, { name: "general" }));
    await call("POST", "/api/v1/channels", as(DANA, { name: "Not A Name" }));
    await call(
      "POST",
      "/api/v1/channels",
      as(ADMIN_TOKEN, { name: "inc-2041-api-latency", kind: "incident", reference: "INC-2041", members: ["ben@example.com"] }),
    );
    await call("POST", "/api/v1/channels", {});
    await call("POST", "/api/v1/conversations/{id}/leave", as(DANA), at("/api/v1/conversations/{id}/leave", ids.random));
    await call("GET", "/api/v1/search", as(EMILY), "/api/v1/search?q=rollback");
    await call("GET", "/api/v1/search", as(EMILY), `/api/v1/search?q=${encodeURIComponent("from:ben has:file checklist")}&days=7`);
    await call("GET", "/api/v1/search", as(EMILY), "/api/v1/search?q=x&days=many");
    await call("PATCH", "/api/v1/channels/{id}", as(ADMIN_TOKEN, { retention: "30d", posts: "admins", guests: true }), at("/api/v1/channels/{id}", ids.random));
    await call("PATCH", "/api/v1/channels/{id}", as(ADMIN_TOKEN, { retention: "soon" }), at("/api/v1/channels/{id}", ids.random));
    await call("PATCH", "/api/v1/channels/{id}", as(ADMIN_TOKEN, { retention: "30d" }), at("/api/v1/channels/{id}", ids.ops));
    await call("PATCH", "/api/v1/channels/{id}", as(ADMIN_TOKEN, {}), at("/api/v1/channels/{id}", "!nope:example.com"));
    await call("PATCH", "/api/v1/channels/{id}", as(VIEWER, {}), at("/api/v1/channels/{id}", ids.random));
  });

  it("people and guests", async () => {
    await call("GET", "/api/v1/people", as(EMILY));
    const shared = room("northwind-shared");
    const g = await call(
      "POST",
      "/api/v1/guests",
      as(CHRIS, { email: "dana.brooks@northwind.example", name: "Dana Brooks", company: "Northwind", channel: shared, days: 30 }),
    );
    await call("POST", "/api/v1/guests", as(CHRIS, { email: "dana.brooks@northwind.example", name: "Dana Brooks", channel: shared }));
    await call("POST", "/api/v1/guests", as(CHRIS, { email: "leo@northwind.example", name: "Leo Park", channel: room("general") }));
    await call("POST", "/api/v1/guests", as(BEN, { email: "leo@northwind.example", name: "Leo Park", channel: shared }));
    await call("POST", "/api/v1/guests", as(CHRIS, { email: "nope", name: "Leo Park", channel: shared }));
    const token = (g.body.link as string).split("/").pop()!;
    await call("GET", "/api/v1/welcome/{token}", anon(), `/api/v1/welcome/${token}`);
    await call("POST", "/api/v1/welcome/{token}", anon({ password: "short" }), `/api/v1/welcome/${token}`);
    await call("POST", "/api/v1/welcome/{token}", anon({ password: "a long guest password" }), `/api/v1/welcome/${token}`);
    await call("GET", "/api/v1/welcome/{token}", anon(), `/api/v1/welcome/${token}`);
    await call("GET", "/api/v1/people", as(EMILY));
    await call("DELETE", "/api/v1/guests/{id}", as(BEN), `/api/v1/guests/${g.body.id}`);
    await call("DELETE", "/api/v1/guests/{id}", as(CHRIS), `/api/v1/guests/${g.body.id}`);
    await call("DELETE", "/api/v1/guests/{id}", as(CHRIS), "/api/v1/guests/nope");
  });

  it("exports, holds, apps and webhooks", async () => {
    const e = await call("POST", "/api/v1/exports", as(EMILY, { reference: "LR-2026-08", channel: ids.ops, from: "2020-01-01", to: "2030-12-31", hold: true }));
    await call("POST", "/api/v1/exports", as(EMILY, { reference: "LR-2026-09", channel: ids.ops, from: "2026-12-01", to: "2026-01-01" }));
    await call("POST", "/api/v1/exports", as(EMILY, { reference: "LR-2026-09", channel: "!nope:example.com", from: "2026-01-01", to: "2026-02-01" }));
    await call("POST", "/api/v1/exports", as(BEN, { reference: "x" }));
    await call("GET", "/api/v1/exports/{id}/archive", as(EMILY), `/api/v1/exports/${e.body.id}/archive`).catch(() => {});
    await app.chat.exportsIdle();
    await call("GET", "/api/v1/exports", as(EMILY));
    await call("GET", "/api/v1/exports/{id}", as(EMILY), `/api/v1/exports/${e.body.id}`);
    await call("GET", "/api/v1/exports/{id}", as(EMILY), "/api/v1/exports/nope");
    await call("GET", "/api/v1/exports/{id}/archive", as(EMILY), `/api/v1/exports/${e.body.id}/archive`);
    await call("GET", "/api/v1/exports/key", as(VIEWER));
    await call("POST", "/api/v1/holds/{id}/release", as(EMILY), `/api/v1/holds/${e.body.hold.id}/release`);
    await call("POST", "/api/v1/holds/{id}/release", as(EMILY), `/api/v1/holds/${e.body.hold.id}/release`);
    await call("POST", "/api/v1/holds/{id}/release", as(EMILY), "/api/v1/holds/nope/release");

    const hook = await call("POST", "/api/v1/apps/{name}/hook", as(EMILY), "/api/v1/apps/Alerts/hook");
    await call("POST", "/api/v1/apps/{name}/hook", as(EMILY), "/api/v1/apps/Nobody/hook");
    const path = new URL(hook.body.url).pathname;
    await call(
      "POST",
      "/hooks/{token}",
      anon({
        text: "@here p95 latency on api-prod-03 above 2 s for 10 minutes.",
        card: {
          title: "API latency high",
          severity: "high",
          fields: [["Host", "api-prod-03"]],
          link: { label: "Open in Alerts", url: "https://alerts.example.com/a/1" },
        },
      }),
      path,
    );
    await call("POST", "/hooks/{token}", anon({ text: "x", channel: "general" }), path);
    await call("POST", "/hooks/{token}", anon({ text: "x" }), "/hooks/oa_chat_hook_not-a-known-token-at-all");
    await call("GET", "/api/v1/integrations", as(VIEWER));
  });

  it("calls every operation in openapi.json", () => {
    const all = Object.entries(spec.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`));
    expect(all.filter((o) => !covered.has(o))).toEqual([]);
  });
});
