import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "./config.ts";
import { MARK } from "./sync.ts";
import { FILE, startApp, type TestApp } from "./test-app.ts";

let app: TestApp;
afterEach(() => app?.close());

const room = (alias: string) => app.fake.roomByAlias(`#${alias}:example.com`)!;

describe("bringing the Matrix server in step with the file", () => {
  it("makes an account for everyone in the directory, the company space, the channels and the apps", async () => {
    app = await startApp({ version: "0.0.0" });
    const { fake } = app;
    // Synapse's message rate limit would stop a company's first sync halfway: the service account has none.
    expect(fake.state.ratelimitOverrides.get("@openasy-chat:example.com")).toEqual({ messages_per_second: 0, burst_count: 0 });
    expect(fake.users.get("@emily:example.com")?.displayname).toBe("Emily Clark");
    expect(fake.users.get("@ben:example.com")?.threepids).toEqual([{ medium: "email", address: "ben@example.com" }]);
    const space = room("company");
    expect(fake.stateOf(space.id, "m.room.create")?.type).toBe("m.space");
    expect(fake.members(space.id)).toEqual(expect.arrayContaining(["@emily:example.com", "@ben:example.com", "@mark:example.com"]));

    const general = room("general");
    expect(fake.stateOf(general.id, "m.room.join_rules")).toEqual({ join_rule: "restricted", allow: [{ type: "m.room_membership", room_id: space.id }] });
    expect(fake.stateOf(general.id, "m.room.retention")).toEqual({ max_lifetime: 730 * 86_400_000 });
    expect(fake.stateOf(general.id, MARK)).toMatchObject({ managedBy: "file", members: ["group:everyone"] });
    expect(general.visibility).toBe("public");
    expect(fake.stateOf(space.id, "m.space.child", general.id)).toEqual({ via: ["example.com"], suggested: true });
    expect(fake.members(general.id)).toHaveLength(6);

    // Groups come from Identity: the platform group and Emily by name.
    expect(fake.members(room("ops-oncall").id).sort()).toEqual([
      "@app-alerts:example.com",
      "@ben:example.com",
      "@emily:example.com",
      "@openasy-chat:example.com",
    ]);
    const leadership = room("leadership");
    expect(fake.stateOf(leadership.id, "m.room.join_rules")).toEqual({ join_rule: "invite" });
    expect(leadership.visibility).toBe("private");
    expect(fake.stateOf(leadership.id, "m.room.retention")).toEqual({ max_lifetime: 365 * 86_400_000 });

    // Only admins post in announcements; nobody but Chat changes the rules or turns encryption on.
    const pl = fake.stateOf(room("announcements").id, "m.room.power_levels")!;
    expect(pl).toMatchObject({ events_default: 50, users: { "@emily:example.com": 50, "@openasy-chat:example.com": 100 } });
    expect(pl.events["m.room.encryption"]).toBe(100);
    expect(fake.stateOf(room("announcements").id, "m.room.retention")).toEqual({});

    expect(fake.users.get("@app-alerts:example.com")).toMatchObject({ displayname: "Alerts", user_type: "bot" });
  });

  it("changes nothing when nothing changed, and puts back what was changed by hand", async () => {
    app = await startApp({ version: "0.0.0" });
    const again = await app.chat.syncNow();
    expect(again).toMatchObject({ ok: true, created: [], updated: [], removed: [], released: [] });

    const general = room("general");
    app.fake.post(general.id, "@openasy-chat:example.com", { topic: "changed by hand" }, "m.room.topic");
    general.state.set("m.room.topic|", { ...general.state.get("m.room.topic|")!, content: { topic: "changed by hand" } });
    const r = await app.chat.syncNow();
    expect(r.updated).toEqual(["#general:example.com"]);
    expect(app.fake.stateOf(general.id, "m.room.topic")).toEqual({ topic: "Company-wide news and questions" });
  });

  it("takes people out of a private channel the file no longer gives them, and keeps the channel's guests", async () => {
    app = await startApp({ version: "0.0.0" });
    const leadership = room("leadership");
    await app.matrix.forceJoin(leadership.id, "@ben:example.com");
    const r = await app.chat.syncNow();
    expect(r.removed).toEqual(["@ben:example.com from #leadership"]);
    expect(app.fake.members(leadership.id)).not.toContain("@ben:example.com");
  });

  it("deactivates people turned off in Identity: out of every room, what they wrote stays", async () => {
    app = await startApp({ version: "0.0.0" });
    const general = room("general");
    app.fake.post(general.id, "@mark:example.com", { msgtype: "m.text", body: "My last day is Friday." });
    app.people.find((p) => p.email === "mark@example.com")!.disabled = true;
    const r = await app.chat.syncNow();
    expect(r.removed).toEqual(["mark@example.com"]);
    expect(app.fake.users.get("@mark:example.com")?.deactivated).toBe(true);
    expect(app.fake.members(general.id)).not.toContain("@mark:example.com");
    expect(general.timeline.some((e) => e.content.body === "My last day is Friday.")).toBe(true);
  });

  it("hands a channel taken out of the file to its members, and names a room Chat did not make", async () => {
    app = await startApp({ version: "0.0.0" });
    await app.matrix.svc("POST", "/_matrix/client/v3/createRoom", { body: { room_alias_name: "random", name: "random" } });
    const without = FILE.replace("  - { name: leadership, private: true, members: [group:leadership] }\n", "");
    const r = await app.chat.setConfig(parseConfig(without));
    expect(r.ok).toBe(true);
    expect(r.released).toEqual(["#leadership"]);
    expect(app.fake.stateOf(room("leadership").id, MARK)).toEqual({ managedBy: "people", guests: false, posts: "everyone" });

    const clash = await app.chat.setConfig(parseConfig(without.replace("apps:", "  - { name: random }\napps:")));
    expect(clash.warnings).toContain(
      "#random:example.com is a room Chat did not make; give the channel another name, or remove the room's address in Element.",
    );
  });

  it("keeps the messages of a channel under a legal hold, whatever the file's retention", async () => {
    app = await startApp({ version: "0.0.0" });
    const ops = room("ops-oncall");
    const started = await app.emily("/api/v1/exports", {
      method: "POST",
      body: JSON.stringify({ reference: "LR-2026-08", channel: ops.id, from: "2026-09-01", to: "2026-10-31", hold: true }),
    });
    expect(started.status).toBe(201);
    await app.chat.exportsIdle();
    expect(app.fake.stateOf(ops.id, "m.room.retention")).toEqual({});
    expect((await app.chat.syncNow()).updated).not.toContain("#ops-oncall:example.com");
    expect(app.fake.stateOf(ops.id, "m.room.retention")).toEqual({});
  });

  it("reports a Matrix server it cannot reach, and tries again later", async () => {
    app = await startApp({ version: "0.0.0" });
    app.fake.state.down = true;
    const r = await app.chat.syncNow();
    expect(r.ok).toBe(false);
    expect(r.error).toContain("Synapse did not answer");
    app.fake.state.down = false;
    expect((await app.chat.syncNow()).ok).toBe(true);
  });
});
