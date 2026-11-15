// End to end against a running Synapse (e2e/run.sh starts one): Chat makes its own admin account with the shared
// secret, applies the chat file (accounts from the directory, the company space, channels with their join rules,
// retention and power levels, an app), and its server is used as people use it: messages, mentions, a thread, reactions,
// an edit made in a Matrix app, search, a direct conversation, a file, a guest who signs in with a password, a webhook,
// a legal export with a hold, a private channel kept to its members and a leaver deactivated, each checked in Synapse.
//
//   SYNAPSE=http://localhost:18008 SYNAPSE_SECRET=... node e2e/synapse.ts
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuth } from "@openasy/auth";
import { createApp } from "../server/app.ts";
import { createChat } from "../server/chat.ts";
import { parseConfig } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import type { DirectoryPerson } from "../server/identity.ts";
import { createMatrix, seg } from "../server/matrix.ts";
import { unzip } from "../server/zip.ts";

const SYNAPSE = (process.env.SYNAPSE ?? "http://localhost:18008").replace(/\/$/, "");
const SECRET = process.env.SYNAPSE_SECRET ?? "";

let failures = 0;
async function step(name: string, work: () => Promise<void>) {
  try {
    await work();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures++;
    console.log(`not ok - ${name}\n  ${(err as Error).stack?.split("\n").slice(0, 6).join("\n  ")}`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function eventually<T>(work: () => Promise<T>, tries = 20): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await work();
    } catch (err) {
      if (i >= tries) throw err;
      await sleep(500);
    }
  }
}

const people: DirectoryPerson[] = [
  { email: "emily@example.com", name: "Emily Clark", groups: ["Operations", "Leadership"], disabled: false },
  { email: "ben@example.com", name: "Ben Ortiz", groups: ["Platform"], disabled: false },
  { email: "chris@example.com", name: "Chris Shaw", groups: ["Sales"], disabled: false },
  { email: "mark@example.com", name: "Mark Lee", groups: ["Sales"], disabled: false },
];
const FILE = `
channels:
  - { name: general, topic: Company-wide news, members: [group:everyone], retention: 2y }
  - { name: ops-oncall, members: [group:platform, emily@example.com], retention: 1y }
  - { name: leadership, private: true, members: [group:leadership] }
  - { name: northwind-shared, private: true, members: [chris@example.com, emily@example.com], guests: true }
apps:
  - { name: Alerts, channels: [ops-oncall] }
`;

const matrix = createMatrix({ url: SYNAPSE });
const db = openDb(":memory:");
const chat = createChat(db, matrix, {
  publicUrl: "https://chat.example.com",
  homeserverUrl: SYNAPSE,
  directory: { people: async () => people },
  organization: "Acme",
  dataDir: mkdtempSync(join(tmpdir(), "chat-e2e-")),
});
let handler: RequestListener = (_req, res) => res.writeHead(503).end();
const server: Server = createServer((req, res) => handler(req, res));
await new Promise<void>((resolve) => server.listen(0, resolve));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
const auth = createAuth({ db, product: "chat", productName: "OpenAsy Chat", origin: base, users: true });
handler = createApp({
  db,
  chat,
  version: "e2e",
  auth,
  adminToken: "e2e-admin",
  personTokens: {
    emily: { email: "emily@example.com", name: "Emily Clark", role: "admin" },
    ben: { email: "ben@example.com", name: "Ben Ortiz", role: "user" },
    chris: { email: "chris@example.com", name: "Chris Shaw", role: "user" },
  },
});
const as =
  (token: string) =>
  async <T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: T }> => {
    const res = await fetch(base + path, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await res.text();
    return { status: res.status, body: (text && res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text) as T };
  };
const emily = as("emily");
const ben = as("ben");
const chris = as("chris");
const roomOf = async (name: string) => (await matrix.roomIdOf(`#${name}:${matrix.serverName}`))!;
const state = (roomId: string, type: string) => matrix.svc("GET", `/_matrix/client/v3/rooms/${seg(roomId)}/state/${seg(type)}/`);

await step("Chat makes its admin account with the shared secret, and signs in to it again", async () => {
  const user = await matrix.signInService(SECRET, "openasy-chat");
  assert.match(user, /^@openasy-chat:/);
  assert.equal(await matrix.signInService(SECRET, "openasy-chat"), user);
});

await step("the file is applied: accounts, the company space, channels, rules and the app", async () => {
  const r = await chat.setConfig(parseConfig(FILE));
  assert.equal(r.error, null);
  assert.ok(r.ok);
  const users = await matrix.users();
  assert.equal(users.find((u) => u.name === `@ben:${matrix.serverName}`)?.displayname, "Ben Ortiz");
  assert.equal(users.find((u) => u.name === `@app-alerts:${matrix.serverName}`)?.user_type, "bot");
  const general = await roomOf("general");
  assert.equal((await state(general, "m.room.join_rules")).join_rule, "restricted");
  assert.deepEqual(await state(general, "m.room.retention"), { max_lifetime: 730 * 86_400_000 });
  assert.equal((await matrix.roomMembers(general)).length, 5);
  assert.equal((await state(await roomOf("leadership"), "m.room.join_rules")).join_rule, "invite");
  const again = await chat.syncNow();
  assert.deepEqual([again.created, again.updated, again.removed], [[], [], []], JSON.stringify(again));
});

const ids: Record<string, string> = { ops: "", root: "" };
await step("messages with a mention, a thread with a reply also in the channel, and reactions", async () => {
  ids.ops = await roomOf("ops-oncall");
  const sent = await ben(`/api/v1/conversations/${seg(ids.ops!)}/messages`, { body: { text: "@Emily Clark the rollback is done." } });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  ids.root = sent.body.id;
  const raw = await matrix.svc("GET", `/_matrix/client/v3/rooms/${seg(ids.ops!)}/event/${seg(ids.root!)}`);
  assert.deepEqual(raw.content["m.mentions"], { user_ids: [`@emily:${matrix.serverName}`] });
  assert.equal(
    (await emily(`/api/v1/conversations/${seg(ids.ops!)}/messages`, { body: { text: "Thanks.", threadRoot: ids.root, alsoInChannel: true } })).status,
    201,
  );
  assert.equal(
    (await emily(`/api/v1/conversations/${seg(ids.ops!)}/messages/${seg(ids.root!)}/reactions`, { body: { emoji: "👍" } })).body.reactions[0].count,
    1,
  );
  const page = await emily(`/api/v1/conversations/${seg(ids.ops!)}/messages`);
  const root = page.body.messages.find((m: { id: string }) => m.id === ids.root);
  assert.equal(root.thread.count, 1);
  assert.equal(root.mentionsMe, true);
  assert.deepEqual(
    root.reactions.map((r: { emoji: string; mine: boolean }) => [r.emoji, r.mine]),
    [["👍", true]],
  );
  const thread = await emily(`/api/v1/conversations/${seg(ids.ops!)}/threads/${seg(ids.root!)}`);
  assert.deepEqual(
    thread.body.replies.map((r: { text: string }) => r.text),
    ["Thanks."],
  );
  const off = await emily(`/api/v1/conversations/${seg(ids.ops!)}/messages/${seg(ids.root!)}/reactions`, { body: { emoji: "👍" } });
  assert.deepEqual(off.body.reactions, []);
});

await step("an edit made in a Matrix app shows in the pages", async () => {
  const sent = await matrix.as(`@ben:${matrix.serverName}`, "PUT", `/_matrix/client/v3/rooms/${seg(ids.ops!)}/send/m.room.message/e2e-1`, {
    body: { msgtype: "m.text", body: "p95 udner 400 ms" },
  });
  await matrix.as(`@ben:${matrix.serverName}`, "PUT", `/_matrix/client/v3/rooms/${seg(ids.ops!)}/send/m.room.message/e2e-2`, {
    body: {
      msgtype: "m.text",
      body: "* p95 under 400 ms",
      "m.new_content": { msgtype: "m.text", body: "p95 under 400 ms" },
      "m.relates_to": { rel_type: "m.replace", event_id: sent.event_id },
    },
  });
  const page = await emily(`/api/v1/conversations/${seg(ids.ops!)}/messages`);
  const m = page.body.messages.find((x: { id: string }) => x.id === sent.event_id);
  assert.equal(m.text, "p95 under 400 ms");
  assert.equal(m.edited, true);
});

await step("search finds a public channel's messages for someone not in it, never a private one's", async () => {
  await emily(`/api/v1/conversations/${seg(await roomOf("leadership"))}/messages`, { body: { text: "The rollback cost us little." } });
  const r = await eventually(async () => {
    const x = await chris("/api/v1/search?q=rollback");
    assert.ok(x.body.messages.length > 0);
    return x;
  });
  assert.ok(r.body.messages.every((m: { room: { name: string } }) => m.room.name === "ops-oncall"));
  const e = await emily("/api/v1/search?q=rollback");
  assert.ok(e.body.messages.some((m: { room: { name: string } }) => m.room.name === "leadership"));
});

await step("a direct conversation is an invitation the other person joins, and a file goes to the media store", async () => {
  const dm = await emily("/api/v1/conversations/direct", { body: { people: [`@ben:${matrix.serverName}`] } });
  assert.equal(dm.body.created, true);
  const list = await ben("/api/v1/conversations");
  assert.ok(list.body.conversations.some((c: { id: string; invited: boolean }) => c.id === dm.body.id && c.invited));
  assert.equal((await ben(`/api/v1/conversations/${seg(dm.body.id)}/join`, { method: "POST" })).status, 204);
  const up = await fetch(`${base}/api/v1/files`, {
    method: "POST",
    headers: { authorization: "Bearer ben", "content-type": "application/pdf", "x-file-name": "checklist.pdf" },
    body: new Uint8Array(Buffer.from("%PDF-1.4 e2e")),
  });
  const file = (await up.json()) as { uri: string };
  assert.equal((await ben(`/api/v1/conversations/${seg(dm.body.id)}/messages`, { body: { text: "", file } })).status, 201);
  const [srv, media] = file.uri.slice(6).split("/");
  const down = await fetch(`${base}/api/v1/files/${srv}/${media}`, { headers: { authorization: "Bearer emily" } });
  assert.equal(Buffer.from(await down.arrayBuffer()).toString(), "%PDF-1.4 e2e");
});

await step("a guest sees only their channel, signs in with the password they chose, and leaves on the day", async () => {
  const shared = await roomOf("northwind-shared");
  const g = await chris("/api/v1/guests", { body: { email: "dana@northwind.example", name: "Dana Brooks", company: "Northwind", channel: shared, days: 10 } });
  assert.equal(g.status, 201, JSON.stringify(g.body));
  assert.ok((await matrix.roomMembers(shared)).includes(g.body.userId));
  await assert.rejects(matrix.as(g.body.userId, "POST", `/_matrix/client/v3/join/${seg(await roomOf("general"))}`, { body: {} }));
  const token = (g.body.link as string).split("/").pop()!;
  assert.equal((await as("x")(`/api/v1/welcome/${token}`, { body: { password: "a long guest password" } })).status, 200);
  const login = await matrix.request("POST", "/_matrix/client/v3/login", {
    body: { type: "m.login.password", identifier: { type: "m.id.user", user: g.body.userId }, password: "a long guest password" },
  });
  assert.ok(login.access_token);
  assert.deepEqual((await chat.syncNow()).removed, []);
  assert.equal((await chris(`/api/v1/guests/${g.body.id}`, { method: "DELETE" })).status, 204);
  // Synapse takes a deactivated account out of its rooms in the background.
  await eventually(async () => assert.ok(!(await matrix.roomMembers(shared)).includes(g.body.userId)));
});

await step("an app posts through its webhook as its own account, with a card", async () => {
  const hook = await emily("/api/v1/apps/Alerts/hook", { method: "POST" });
  const r = await fetch(`${base}${new URL(hook.body.url).pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "API latency high", card: { title: "API latency high", severity: "high" } }),
  });
  assert.equal(r.status, 202);
  const page = await emily(`/api/v1/conversations/${seg(ids.ops!)}/messages`);
  assert.deepEqual(page.body.messages.at(-1).sender.app, "Alerts");
  assert.equal(page.body.messages.at(-1).card.severity, "high");
});

await step("the lists the pages show: conversations, people with presence, channels and integrations", async () => {
  await matrix.as(`@ben:${matrix.serverName}`, "PUT", `/_matrix/client/v3/presence/${seg(`@ben:${matrix.serverName}`)}/status`, {
    body: { presence: "online", status_msg: "On call this week" },
  });
  const conv = await emily("/api/v1/conversations");
  assert.ok(conv.body.conversations.some((c: { name: string; kind: string }) => c.name === "ops-oncall" && c.kind === "public"));
  const p = await emily("/api/v1/people");
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const b = p.body.people.find((x: { name: string }) => x.name === "Ben Ortiz");
  assert.deepEqual([b.presence, b.status, b.groups], ["online", "On call this week", ["Platform"]]);
  const ch = await emily("/api/v1/channels");
  assert.equal(ch.status, 200, JSON.stringify(ch.body));
  assert.equal(ch.body.channels.find((c: { name: string }) => c.name === "general").managedBy, "file");
  const i = await emily("/api/v1/integrations");
  assert.equal(i.body.matrix.ok, true);
});

await step("a legal export with a hold: signed archive, retention off, and back on when released", async () => {
  const e = await emily("/api/v1/exports", { body: { reference: "LR-E2E", channel: ids.ops, from: "2020-01-01", to: "2035-12-31", hold: true } });
  assert.equal(e.status, 201, JSON.stringify(e.body));
  await chat.exportsIdle();
  assert.deepEqual(await state(ids.ops!, "m.room.retention"), {});
  const row = await emily(`/api/v1/exports/${e.body.id}`);
  assert.equal(row.body.state, "ready", row.body.error);
  const zip = await fetch(`${base}/api/v1/exports/${e.body.id}/archive`, { headers: { authorization: "Bearer emily" } });
  const files = unzip(Buffer.from(await zip.arrayBuffer()));
  assert.ok(
    files
      .find((f) => f.name === "messages.jsonl")!
      .data.toString()
      .includes("the rollback is done"),
  );
  assert.equal((await emily(`/api/v1/holds/${e.body.hold.id}/release`, { method: "POST" })).status, 200);
  assert.deepEqual(await state(ids.ops!, "m.room.retention"), { max_lifetime: 365 * 86_400_000 });
});

await step("a private channel keeps to its members; a leaver is deactivated and out of every room", async () => {
  const leadership = await roomOf("leadership");
  await matrix.forceJoin(leadership, `@ben:${matrix.serverName}`);
  people.find((p) => p.email === "mark@example.com")!.disabled = true;
  const r = await chat.syncNow();
  assert.ok(r.removed.includes(`@ben:${matrix.serverName} from #leadership`), JSON.stringify(r));
  assert.ok(r.removed.includes("mark@example.com"));
  assert.ok(!(await matrix.roomMembers(leadership)).includes(`@ben:${matrix.serverName}`));
  await eventually(async () => assert.ok(!(await matrix.roomMembers(await roomOf("general"))).includes(`@mark:${matrix.serverName}`)));
});

server.close();
console.log(failures ? `# ${failures} failed` : "# all passed");
process.exit(failures ? 1 : 0);
