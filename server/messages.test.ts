import { describe, expect, it } from "vitest";
import type { MatrixEvent } from "./matrix.ts";
import { cardOf, timeline, withMentions, type Who } from "./messages.ts";

const NAMES: Record<string, string> = { "@ben:x": "Ben Ortiz", "@emily:x": "Emily Clark" };
const who: Who = { name: (id) => NAMES[id] ?? id, app: () => null, guest: () => false };
let n = 0;
const ev = (sender: string, content: Record<string, unknown>, type = "m.room.message", extra: Partial<MatrixEvent> = {}): MatrixEvent => ({
  event_id: `$${++n}`,
  type,
  sender,
  origin_server_ts: 1_790_000_000_000 + n * 1000,
  content,
  ...extra,
});

describe("Matrix events as messages", () => {
  it("folds edits, reactions and thread replies into the message they belong to", () => {
    const root = ev("@ben:x", { msgtype: "m.text", body: "rollbak done" });
    const events = [
      root,
      ev("@ben:x", {
        msgtype: "m.text",
        body: "* rollback done",
        "m.new_content": { msgtype: "m.text", body: "rollback done" },
        "m.relates_to": { rel_type: "m.replace", event_id: root.event_id },
      }),
      ev("@emily:x", { "m.relates_to": { rel_type: "m.annotation", event_id: root.event_id, key: "🙏" } }, "m.reaction"),
      ev("@emily:x", { msgtype: "m.text", body: "Thanks", "m.relates_to": { rel_type: "m.thread", event_id: root.event_id } }),
      ev("@ben:x", { "m.relates_to": { rel_type: "m.annotation", event_id: root.event_id, key: "🙏" } }, "m.reaction", { unsigned: { redacted_because: {} } }),
    ];
    const [m, ...rest] = timeline(events.reverse(), "@emily:x", who);
    expect(rest).toEqual([]);
    expect(m).toMatchObject({ text: "rollback done", edited: true, reactions: [{ emoji: "🙏", count: 1, mine: true, by: ["Emily Clark"] }] });
    expect(m!.thread).toMatchObject({ count: 1, participants: [{ userId: "@emily:x", name: "Emily Clark" }] });
  });

  it("shows files by name, and a caption as the text", () => {
    const [plain, caption] = timeline(
      [
        ev("@ben:x", { msgtype: "m.file", body: "plan.pdf", url: "mxc://x/1", info: { size: 10, mimetype: "application/pdf" } }),
        ev("@ben:x", { msgtype: "m.file", body: "The plan", filename: "plan.pdf", url: "mxc://x/2" }),
      ],
      "@emily:x",
      who,
    );
    expect(plain).toMatchObject({ text: "", file: { uri: "mxc://x/1", name: "plan.pdf", size: 10, type: "application/pdf" } });
    expect(caption).toMatchObject({ text: "The plan", file: { name: "plan.pdf", size: null } });
  });

  it("turns @Name into a mention Matrix apps notify, and @here into one for the room", () => {
    const c = withMentions("@Emily Clark look <here>, @here", [{ userId: "@emily:x", name: "Emily Clark" }]);
    expect(c["m.mentions"]).toEqual({ user_ids: ["@emily:x"], room: true });
    expect(c.formatted_body).toBe('<a href="https://matrix.to/#/%40emily%3Ax">Emily Clark</a> look &lt;here&gt;, @here');
    expect(withMentions("no one", [])).toEqual({ msgtype: "m.text", body: "no one", "m.mentions": {} });
  });

  it("keeps an app's card to what the pages draw", () => {
    expect(
      cardOf({ title: "Down", severity: "loud", status: { label: "Open", tone: "pink" }, fields: [["a", 1], ["bad"]], link: { url: "javascript:alert(1)" } }),
    ).toEqual({ title: "Down", severity: null, status: { label: "Open", tone: "neutral" }, fields: [["a", "1"]], link: null });
    expect(cardOf({ fields: [] })).toBeNull();
  });
});
