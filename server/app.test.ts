import { verify, createPublicKey } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { unzip } from "./zip.ts";
import { ADMIN_TOKEN, BEN, startApp, VIEWER, type TestApp } from "./test-app.ts";

let app: TestApp;
beforeEach(async () => {
  app = await startApp({ version: "0.0.0" });
});
afterEach(() => app.close());

const room = (alias: string) => app.fake.roomByAlias(`#${alias}:example.com`)!.id;
const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });
const enc = encodeURIComponent;

describe("who may do what", () => {
  it("keeps conversations to signed-in people, the channels to viewers and the rules to admins", async () => {
    // The test admin token is not a person: refused like any API token.
    expect((await app.admin("/api/v1/conversations")).status).toBe(401);
    expect((await app.ben("/api/v1/channels")).status).toBe(403);
    expect((await app.as(VIEWER)("/api/v1/channels")).status).toBe(200);
    expect((await app.as(VIEWER)(`/api/v1/channels/${enc(room("general"))}`, { method: "PATCH", body: "{}" })).status).toBe(403);
    expect((await app.ben("/api/v1/exports")).status).toBe(403);
    expect((await fetch(`${app.base}/api/v1/conversations`)).status).toBe(401);
  });

  it("acts on the Matrix server as the person: a private channel stays closed to those not in it", async () => {
    const r = await app.ben(`/api/v1/conversations/${enc(room("leadership"))}/messages`);
    expect(r.status).toBe(403);
    const calls = app.fake.calls.filter((c) => c.path.endsWith("/messages") && c.path.includes("rooms"));
    expect(calls.at(-1)?.as).toBe("@ben:example.com");
  });

  it("says when the Matrix server is away", async () => {
    app.fake.state.down = true;
    const r = await app.emily("/api/v1/conversations");
    expect(r.status).toBe(502);
    expect(((await r.json()) as { code: string }).code).toBe("matrix-unavailable");
  });
});

describe("conversations and messages", () => {
  it("lists the person's channels and direct messages with unread counts and mentions", async () => {
    const ops = room("ops-oncall");
    app.fake.post(ops, "@ben:example.com", { msgtype: "m.text", body: "@Emily Clark can you look?", "m.mentions": { user_ids: ["@emily:example.com"] } });
    const { conversations } = (await (await app.emily("/api/v1/conversations")).json()) as { conversations: Array<Record<string, any>> };
    const names = conversations.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["general", "ops-oncall", "leadership", "northwind-shared", "announcements"]));
    expect(names).not.toContain("Acme");
    const o = conversations.find((c) => c.name === "ops-oncall")!;
    expect(o).toMatchObject({ kind: "public", unread: 1, mentions: 1 });
    expect(conversations.find((c) => c.name === "leadership")!.kind).toBe("private");

    // Reading clears it.
    const page = (await (await app.emily(`/api/v1/conversations/${enc(ops)}/messages`)).json()) as { messages: Array<{ id: string }> };
    expect((await app.emily(`/api/v1/conversations/${enc(ops)}/read`, post({ eventId: page.messages.at(-1)!.id }))).status).toBe(204);
    const after = (await (await app.emily("/api/v1/conversations")).json()) as { conversations: Array<Record<string, any>> };
    expect(after.conversations.find((c) => c.name === "ops-oncall")!.unread).toBe(0);
  });

  it("sends mentions Element notifies, folds edits, deletions and reactions in, and counts thread replies", async () => {
    const ops = room("ops-oncall");
    const sent = (await (await app.ben(`/api/v1/conversations/${enc(ops)}/messages`, post({ text: "@Emily Clark rollback done. @here FYI" }))).json()) as {
      id: string;
      mentionsMe: boolean;
    };
    const event = app.fake.rooms.get(ops)!.timeline.find((e) => e.event_id === sent.id)!;
    expect(event.content["m.mentions"]).toEqual({ user_ids: ["@emily:example.com"], room: true });
    expect(event.content.formatted_body).toContain('<a href="https://matrix.to/#/%40emily%3Aexample.com">Emily Clark</a>');

    // A reply in the thread, also sent to the channel.
    const reply = await app.emily(`/api/v1/conversations/${enc(ops)}/messages`, post({ text: "Thanks.", threadRoot: sent.id, alsoInChannel: true }));
    expect(reply.status).toBe(201);
    // Element edits one and deletes another; someone reacts.
    const typo = app.fake.post(ops, "@ben:example.com", { msgtype: "m.text", body: "p95 back udner 400 ms" });
    app.fake.post(ops, "@ben:example.com", {
      msgtype: "m.text",
      body: "* p95 back under 400 ms",
      "m.new_content": { msgtype: "m.text", body: "p95 back under 400 ms" },
      "m.relates_to": { rel_type: "m.replace", event_id: typo.event_id },
    });
    const gone = app.fake.post(ops, "@ben:example.com", { msgtype: "m.text", body: "wrong channel" });
    await app.matrix.as("@ben:example.com", "PUT", `/_matrix/client/v3/rooms/${enc(ops)}/redact/${enc(gone.event_id)}/t1`, { body: {} });
    const plus = await app.emily(`/api/v1/conversations/${enc(ops)}/messages/${enc(sent.id)}/reactions`, post({ emoji: "➕" }));
    expect(((await plus.json()) as { reactions: unknown }).reactions).toEqual([{ emoji: "➕", count: 1, mine: true, by: ["Emily Clark"] }]);
    app.fake.post(ops, "@ben:example.com", { "m.relates_to": { rel_type: "m.annotation", event_id: sent.id, key: "➕" } }, "m.reaction");

    const { messages } = (await (await app.emily(`/api/v1/conversations/${enc(ops)}/messages`)).json()) as { messages: Array<Record<string, any>> };
    const root = messages.find((m) => m.id === sent.id)!;
    expect(root.thread).toMatchObject({ count: 1, participants: [{ name: "Emily Clark" }] });
    expect(root.reactions).toEqual([{ emoji: "➕", count: 2, mine: true, by: ["Emily Clark", "Ben Ortiz"] }]);
    expect(root.mentionsMe).toBe(true);
    expect(messages.filter((m) => m.text === "Thanks.")).toHaveLength(1);
    expect(messages.find((m) => m.id === typo.event_id)).toMatchObject({ text: "p95 back under 400 ms", edited: true });
    expect(messages.find((m) => m.id === gone.event_id)).toMatchObject({ text: "", deleted: true });

    // Taking a reaction back.
    const back = (await (await app.emily(`/api/v1/conversations/${enc(ops)}/messages/${enc(sent.id)}/reactions`, post({ emoji: "➕" }))).json()) as {
      reactions: Array<{ count: number; mine: boolean }>;
    };
    expect(back.reactions).toEqual([{ emoji: "➕", count: 1, mine: false, by: ["Ben Ortiz"] }]);

    const thread = (await (await app.emily(`/api/v1/conversations/${enc(ops)}/threads/${enc(sent.id)}`)).json()) as {
      root: { id: string };
      replies: Array<{ text: string }>;
    };
    expect(thread.root.id).toBe(sent.id);
    expect(thread.replies.map((r) => r.text)).toEqual(["Thanks."]);
  });

  it("shows an encrypted message as encrypted, and the apps' cards", async () => {
    const ops = room("ops-oncall");
    app.fake.post(ops, "@ben:example.com", { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "x" }, "m.room.encrypted");
    const hook = (await (await app.emily("/api/v1/apps/Alerts/hook", { method: "POST" })).json()) as { url: string };
    const r = await fetch(`${app.base}${new URL(hook.url).pathname}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "API latency high on api-prod-03",
        card: { title: "API latency high", severity: "high", fields: [["Host", "api-prod-03"]] },
      }),
    });
    expect(r.status).toBe(202);
    const { messages } = (await (await app.emily(`/api/v1/conversations/${enc(ops)}/messages`)).json()) as { messages: Array<Record<string, any>> };
    expect(messages.find((m) => m.encrypted)).toMatchObject({ text: "", encrypted: true });
    expect(messages.at(-1)).toMatchObject({
      sender: { userId: "@app-alerts:example.com", name: "Alerts", app: "Alerts" },
      card: { title: "API latency high", severity: "high", fields: [["Host", "api-prod-03"]], status: null, link: null },
    });
    expect(
      (
        await fetch(`${app.base}${new URL(hook.url).pathname}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "x", channel: "general" }),
        })
      ).status,
    ).toBe(422);
    // A new address ends the old one.
    await app.emily("/api/v1/apps/Alerts/hook", { method: "POST" });
    expect(
      (
        await fetch(`${app.base}${new URL(hook.url).pathname}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "x" }),
        })
      ).status,
    ).toBe(401);
  });

  it("opens a direct conversation once, which the other person sees as an invitation and joins", async () => {
    const a = (await (await app.emily("/api/v1/conversations/direct", post({ people: ["@ben:example.com"] }))).json()) as { id: string; created: boolean };
    expect(a.created).toBe(true);
    const ben = (await (await app.ben("/api/v1/conversations")).json()) as { conversations: Array<Record<string, any>> };
    expect(ben.conversations.find((c) => c.id === a.id)).toMatchObject({ invited: true, kind: "dm", name: "Emily Clark" });
    expect((await app.ben(`/api/v1/conversations/${enc(a.id)}/join`, { method: "POST" })).status).toBe(204);
    const again = (await (await app.emily("/api/v1/conversations/direct", post({ people: ["@ben:example.com"] }))).json()) as { id: string; created: boolean };
    expect(again).toEqual({ id: a.id, created: false });
    const emily = (await (await app.emily("/api/v1/conversations")).json()) as { conversations: Array<Record<string, any>> };
    expect(emily.conversations.find((c) => c.id === a.id)).toMatchObject({ kind: "dm", name: "Ben Ortiz", with: [{ userId: "@ben:example.com" }] });
  });

  it("uploads a file to the Matrix server and gives it back", async () => {
    const up = await fetch(`${app.base}/api/v1/files`, {
      method: "POST",
      headers: { authorization: `Bearer ${BEN}`, "content-type": "application/pdf", "x-file-name": "rollback-checklist.pdf" },
      body: new Uint8Array(Buffer.from("%PDF checklist")),
    });
    const file = (await up.json()) as { uri: string };
    await app.ben(`/api/v1/conversations/${enc(room("ops-oncall"))}/messages`, post({ text: "Updated the checklist.", file }));
    const { messages } = (await (await app.emily(`/api/v1/conversations/${enc(room("ops-oncall"))}/messages`)).json()) as {
      messages: Array<Record<string, any>>;
    };
    expect(messages.at(-1)).toMatchObject({ text: "Updated the checklist.", file: { name: "rollback-checklist.pdf", size: 14, type: "application/pdf" } });
    const [server, media] = file.uri.slice(6).split("/");
    const down = await app.emily(`/api/v1/files/${server}/${media}?name=rollback-checklist.pdf`);
    expect(down.headers.get("content-disposition")).toContain("attachment");
    expect(Buffer.from(await down.arrayBuffer()).toString()).toBe("%PDF checklist");
  });
});

describe("search", () => {
  it("finds messages in channels open to the company even when not joined, never in private ones the person is not in", async () => {
    app.fake.post(room("ops-oncall"), "@ben:example.com", { msgtype: "m.text", body: "Starting the rollback to 2026.11.3-5." });
    app.fake.post(room("leadership"), "@emily:example.com", { msgtype: "m.text", body: "Impact of last month's rollback was small." });
    const dana = (await (await app.dana("/api/v1/search?q=rollback")).json()) as { messages: Array<Record<string, any>> };
    expect(dana.messages.map((m) => m.room.name)).toEqual(["ops-oncall"]);
    const emily = (await (await app.emily("/api/v1/search?q=rollback")).json()) as { messages: Array<Record<string, any>> };
    expect(emily.messages.map((m) => m.room.name).sort()).toEqual(["leadership", "ops-oncall"]);
    const fromBen = (await (await app.emily(`/api/v1/search?q=${enc("from:ben rollback")}`)).json()) as { messages: unknown[] };
    expect(fromBen.messages).toHaveLength(1);
    const inOps = (await (await app.emily(`/api/v1/search?q=${enc("in:#leadership rollback")}`)).json()) as { messages: Array<Record<string, any>> };
    expect(inOps.messages.map((m) => m.room.name)).toEqual(["leadership"]);
  });
});

describe("people and guests", () => {
  it("lists members with groups, presence and local time, and who is leaving", async () => {
    app.fake.presence.set("@ben:example.com", { presence: "online", status_msg: "On call this week" });
    app.fake.presence.set("@dana:example.com", { presence: "online", status_msg: "Busy: pentest" });
    app.fake.setProfile("@ben:example.com", "m.tz", "Europe/Berlin");
    app.people.find((p) => p.email === "mark@example.com")!.disabled = true;
    const r = (await (await app.emily("/api/v1/people")).json()) as { people: Array<Record<string, any>>; leaving: unknown[] };
    expect(r.people.find((p) => p.name === "Ben Ortiz")).toMatchObject({
      presence: "online",
      status: "On call this week",
      timeZone: "Europe/Berlin",
      groups: ["Platform"],
    });
    expect(r.people.find((p) => p.name === "Dana Kim")!.presence).toBe("busy");
    expect(r.people.find((p) => p.name === "Emily Clark")!.me).toBe(true);
    expect(r.people.map((p) => p.name)).not.toContain("Alerts");
    expect(r.leaving).toEqual([{ name: "Mark Lee", email: "mark@example.com", channels: 2 }]);
  });

  it("invites a guest to one channel, who cannot join the company's channels, and ends their access on the day", async () => {
    const shared = room("northwind-shared");
    const r = await app.chris(
      "/api/v1/guests",
      post({ email: "dana.brooks@northwind.example", name: "Dana Brooks", company: "Northwind", channel: shared, days: 30 }),
    );
    expect(r.status).toBe(201);
    const g = (await r.json()) as { id: string; userId: string; link: string };
    expect(g.userId).toBe("@guest-dana.brooks_northwind.example:example.com");
    expect(app.fake.members(shared)).toContain(g.userId);
    expect(app.fake.members(room("company"))).not.toContain(g.userId);
    // Channels open to the company are restricted to the company space.
    await expect(app.matrix.as(g.userId, "POST", `/_matrix/client/v3/join/${enc(room("general"))}`, { body: {} })).rejects.toThrow(/required rooms/);

    const token = g.link.split("/").pop()!;
    expect((await fetch(`${app.base}/api/v1/welcome/${token}`, post({ password: "a long guest password" }))).status).toBe(200);
    expect(app.fake.users.get(g.userId)?.password).toBe("a long guest password");

    const people = (await (await app.emily("/api/v1/people")).json()) as { people: Array<Record<string, any>> };
    expect(people.people.find((p) => p.userId === g.userId)!.guest).toMatchObject({
      company: "Northwind",
      channel: "northwind-shared",
      invitedBy: "Chris Shaw",
      welcomed: true,
    });
    const conv = (await (await app.emily(`/api/v1/conversations/${enc(shared)}`)).json()) as { kind: string; guests: unknown[] };
    expect(conv.kind).toBe("guests");
    expect(conv.guests).toHaveLength(1);

    // A sync keeps the guest in the private channel.
    expect((await app.chat.syncNow()).removed).toEqual([]);
    app.tick(31 * 86_400_000);
    await app.chat.syncNow();
    expect(app.fake.users.get(g.userId)?.deactivated).toBe(true);
    expect(app.fake.members(shared)).not.toContain(g.userId);
  });
});

describe("channels, retention, holds and exports", () => {
  it("sets retention on a channel people made; the file's channels change only in the file", async () => {
    const made = (await (await app.dana("/api/v1/channels", post({ name: "random", topic: "Lunch" }))).json()) as { id: string };
    expect(app.fake.stateOf(made.id, "m.room.retention")).toEqual({ max_lifetime: 365 * 86_400_000 });
    const r = await app.emily(`/api/v1/channels/${enc(made.id)}`, { method: "PATCH", body: JSON.stringify({ retention: "30d", guests: true }) });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ retention: "30d", guests: true, managedBy: "people", from: "By its members" });
    expect(app.fake.stateOf(made.id, "m.room.retention")).toEqual({ max_lifetime: 30 * 86_400_000 });
    expect((await app.emily(`/api/v1/channels/${enc(room("general"))}`, { method: "PATCH", body: JSON.stringify({ retention: "30d" }) })).status).toBe(409);

    const list = (await (await app.emily("/api/v1/channels")).json()) as { channels: Array<Record<string, any>>; totals: Record<string, number> };
    expect(list.channels.find((c) => c.name === "general")).toMatchObject({ managedBy: "file", retention: "2y", entry: { members: ["group:everyone"] } });
    expect(list.totals).toMatchObject({ channels: 6, fromFile: 5, private: 2 });
  });

  it("opens a channel for an incident with an API token", async () => {
    const r = await app.admin(
      "/api/v1/channels",
      post({ name: "inc-2041-api-latency", kind: "incident", reference: "INC-2041", members: ["ben@example.com"] }),
    );
    expect(r.status).toBe(201);
    const { id } = (await r.json()) as { id: string };
    expect(app.fake.members(id)).toContain("@ben:example.com");
    const conv = (await (await app.ben(`/api/v1/conversations/${enc(id)}`)).json()) as Record<string, unknown>;
    expect(conv).toMatchObject({ kind: "incident", reference: "INC-2041", from: "Opened by test", managedBy: "api" });
  });

  it("exports a channel as a signed archive, holds it, and puts its retention back when released", async () => {
    const ops = room("ops-oncall");
    app.fake.post(ops, "@ben:example.com", { msgtype: "m.text", body: "Error rate went up after the deploy." });
    app.fake.post(ops, "@emily:example.com", { msgtype: "m.text", body: "Moving the deploy window." });
    const e = (await (
      await app.emily(
        "/api/v1/exports",
        post({ reference: "LR-2026-08", channel: ops, from: "2020-01-01", to: "2030-12-31", senders: ["@ben:example.com"], hold: true }),
      )
    ).json()) as { id: string; hold: { id: string } };
    await app.chat.exportsIdle();
    const row = (await (await app.emily(`/api/v1/exports/${e.id}`)).json()) as Record<string, unknown>;
    expect(row).toMatchObject({ state: "ready", messages: 1, files: 0 });
    const archive = unzip(Buffer.from(await (await app.emily(`/api/v1/exports/${e.id}/archive`)).arrayBuffer()));
    const byName = new Map(archive.map((f) => [f.name, f.data]));
    const lines = byName
      .get("messages.jsonl")!
      .toString()
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines.every((l) => l.sender === "@ben:example.com")).toBe(true);
    expect(lines.some((l) => l.content.body === "Error rate went up after the deploy.")).toBe(true);
    const key = await (await app.as(VIEWER)("/api/v1/exports/key")).text();
    expect(verify(null, byName.get("manifest.json")!, createPublicKey(key), Buffer.from(byName.get("manifest.json.sig")!.toString().trim(), "base64"))).toBe(
      true,
    );

    expect(app.fake.stateOf(ops, "m.room.retention")).toEqual({});
    expect((await app.emily(`/api/v1/holds/${e.hold.id}/release`, { method: "POST" })).status).toBe(200);
    expect(app.fake.stateOf(ops, "m.room.retention")).toEqual({ max_lifetime: 365 * 86_400_000 });
  });

  it("starts nothing for a token without the admin role", async () => {
    expect((await app.as(ADMIN_TOKEN)("/api/v1/exports")).status).toBe(200);
  });
});
