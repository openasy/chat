import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appSlug, parseConfig, parseRetention, retentionText, watchConfig, type ChatConfig } from "./config.ts";

describe("the chat file", () => {
  it("reads channels, apps and rules with their defaults", () => {
    const c = parseConfig(`
defaults: { retention: 1y }
guests: { days: 30 }
channels:
  - name: "#General"
    topic: Company-wide news
    members: [group:everyone]
    retention: 2y
  - { name: leadership, private: true, members: [group:leadership, Emily@Example.com] }
  - { name: announcements, posts: admins, admins: [emily@example.com], retention: forever }
apps:
  - { name: Alerts, channels: ["#general"] }
`);
    expect(c.channels[0]).toEqual({
      name: "general",
      topic: "Company-wide news",
      private: false,
      members: ["group:everyone"],
      admins: [],
      retention: { days: 730 },
      guests: false,
      posts: "everyone",
    });
    expect(c.channels[1]).toMatchObject({ private: true, members: ["group:leadership", "emily@example.com"], retention: { days: 365 } });
    expect(c.channels[2]!.retention).toBe("forever");
    expect(c.apps).toEqual([{ name: "Alerts", channels: ["general"] }]);
    expect(c.guestsPolicy).toEqual({ days: 30 });
  });

  it("is empty when the file is", () => {
    expect(parseConfig("")).toEqual({ channels: [], apps: [], defaults: { retention: { days: 365 } }, guestsPolicy: { days: 90 } });
  });

  it.each([
    ["channels: [{ topic: x }]", "channels[0].name is required"],
    ["channels: [{ name: Bad Name }]", "channels[0].name is required"],
    ["channels: [{ name: a }, { name: a }]", "a is in the file twice"],
    ["channels: [{ name: a, members: [jane] }]", "channels[0].members[0] (group:<name> or an email address)"],
    ["channels: [{ name: a, retention: soon }]", "channels[0].retention is a time"],
    ["channels: [{ name: a, posts: admins }]", "posts: admins needs admins"],
    ["channels: [{ name: a, colour: red }]", "unknown colour"],
    ["apps: [{ name: Alerts, channels: [nowhere] }]", "nowhere is not a channel of this file"],
    ["guests: { days: 0 }", "guests.days is a number of days from 1 to 730"],
    ["teams: []", "Unknown teams"],
    ["channels: [", "Not valid YAML"],
  ])("refuses %s, saying what to fix", (source, message) => {
    expect(() => parseConfig(source)).toThrow(message);
  });

  it("writes retentions the way the file does", () => {
    expect(retentionText(parseRetention("2y", "x"))).toBe("2y");
    expect(retentionText(parseRetention("12w", "x"))).toBe("84d");
    expect(retentionText("forever")).toBe("forever");
    expect(appSlug("Deploy Bot")).toBe("app-deploy-bot");
  });

  it("keeps the last good file in place when a change has a mistake", () => {
    const dir = mkdtempSync(join(tmpdir(), "chat-config-"));
    const path = join(dir, "chat.yaml");
    writeFileSync(path, "channels: [{ name: general }]\n");
    const applied: ChatConfig[] = [];
    const w = watchConfig(path, (c) => applied.push(c), { everyMs: 60_000 });
    expect(applied).toHaveLength(1);
    writeFileSync(path, "channels: [{ name: Not Valid }]\n");
    w.read();
    expect(applied).toHaveLength(1);
    expect(w.state.error).toContain("channels[0].name");
    writeFileSync(path, "channels: [{ name: general }, { name: random }]\n");
    w.read();
    expect(applied.at(-1)!.channels.map((c) => c.name)).toEqual(["general", "random"]);
    expect(w.state).toMatchObject({ error: null, channels: 2 });
    w.stop();
  });
});
