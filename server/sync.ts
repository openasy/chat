// Makes the Matrix server match the file and the directory. Everyone in the company has an account named after their
// email (jane@example.com is @jane:example.com), is a member of the company space, and is put into the channels the
// file gives their groups. People turned off in Identity are deactivated: taken out of every room and signed out on
// every device, while what they wrote stays. Each channel of the file is a room Chat made and marks as its own; Chat
// sets its name, topic, who may join, who may post and how long messages are kept, and touches no other room. A
// channel taken out of the file is not deleted: it is handed to its members, who may keep or archive it.
import type { App, Channel, ChatConfig, Retention } from "./config.ts";
import { appSlug } from "./config.ts";
import type { DirectoryPerson } from "./identity.ts";
import { MatrixError, seg, type AdminUser, type Matrix, type MatrixEvent } from "./matrix.ts";

/** The state event that marks a room Chat looks after, and says by whom it is managed. */
export const MARK = "org.openasy.chat.channel";
/** The company space's alias: every channel of the file is in it, and only people of the company are members. */
export const SPACE = "company";
/** The room version Chat makes rooms in: restricted joins, so guests cannot join channels open to the company. */
export const ROOM_VERSION = "10";

export interface Mark {
  managedBy: "file" | "people" | "api";
  /** For api: the API token's name, such as Incidents. */
  by?: string;
  /** For api: what the channel is for, such as INC-2041. */
  reference?: string;
  kind?: "incident";
  /** For file channels: the groups and people the file names, as the pages show where members come from. */
  members?: string[];
  /** For file channels: the moderators the file named, to take back when they leave the list. */
  admins?: string[];
  /** Guests from outside the company may be invited. */
  guests?: boolean;
  posts?: "everyone" | "admins";
}

export interface SyncResult {
  at: string;
  ok: boolean;
  /** People, channels and apps made. */
  created: string[];
  /** People and channels changed. */
  updated: string[];
  /** People who left, deactivated, and people taken out of private channels the file no longer gives them. */
  removed: string[];
  /** Channels taken out of the file, handed to their members. */
  released: string[];
  /** What the file names that the server or the directory does not have. */
  warnings: string[];
  error: string | null;
}

/** The Matrix localpart for an email: jane.doe@example.com is jane.doe. */
export const localpartOf = (email: string) =>
  email
    .slice(0, email.lastIndexOf("@"))
    .toLowerCase()
    .replace(/[^a-z0-9._=/+-]/g, "_");
export const userIdOf = (email: string, server: string) => `@${localpartOf(email)}:${server}`;

/** The m.room.retention content for a retention: none for forever or while a legal hold is on. */
export const retentionContent = (r: Retention | null): Record<string, number> => (r && r !== "forever" ? { max_lifetime: r.days * 86_400_000 } : {});
export function retentionOf(content: Record<string, unknown> | undefined): Retention {
  const ms = typeof content?.max_lifetime === "number" ? content.max_lifetime : 0;
  return ms > 0 ? { days: Math.max(1, Math.round(ms / 86_400_000)) } : "forever";
}

/** A room's current state, by type and state key. */
export function stateMap(events: MatrixEvent[]): Map<string, MatrixEvent> {
  return new Map(events.map((e) => [`${e.type}|${e.state_key ?? ""}`, e]));
}

/** The power levels a channel of the file has: the service account first, then its admins. */
export function powerLevels(current: Record<string, any> | undefined, service: string, channel: Channel, adminIds: string[], previous: string[]) {
  const users: Record<string, number> = { ...current?.users };
  for (const id of previous) if (users[id] === 50 && !adminIds.includes(id)) delete users[id];
  for (const id of adminIds) if ((users[id] ?? 0) < 50) users[id] = 50;
  users[service] = 100;
  return {
    ...current,
    users,
    users_default: 0,
    events_default: channel.posts === "admins" ? 50 : 0,
    state_default: 50,
    ban: 50,
    kick: 50,
    redact: 50,
    invite: channel.private ? 50 : 0,
    events: {
      ...current?.events,
      "m.room.name": 50,
      "m.room.topic": 50,
      "m.room.pinned_events": 50,
      "m.room.power_levels": 100,
      "m.room.join_rules": 100,
      "m.room.history_visibility": 100,
      "m.room.encryption": 100,
      "m.room.retention": 100,
      "m.room.tombstone": 100,
      "m.room.server_acl": 100,
      "m.space.parent": 100,
      [MARK]: 100,
    },
  };
}

/** JSON with its keys sorted: Synapse gives state back with its keys in another order than they were sent. */
const canonical = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(canonical).join(",")}]`
    : v && typeof v === "object"
      ? `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
          .join(",")}}`
      : JSON.stringify(v);
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

export interface SyncInput {
  config: ChatConfig;
  /** From Identity, or null without it: then everyone with an account is in the company, and there are no groups. */
  people: DirectoryPerson[] | null;
  /** Guests' user ids and the room each was invited to: kept in private channels, never put in the space. */
  guests: Array<{ userId: string; roomId: string }>;
  /** Rooms under a legal hold: their messages are kept whatever the retention says. */
  held: Set<string>;
  /** The company's name, for the space. */
  organization: string;
  now?: () => Date;
}

export async function sync(matrix: Matrix, input: SyncInput): Promise<SyncResult> {
  const { config, people, guests, held, organization, now = () => new Date() } = input;
  const result: SyncResult = { at: now().toISOString(), ok: false, created: [], updated: [], removed: [], released: [], warnings: [], error: null };
  try {
    const server = matrix.serverName;
    const service = matrix.serviceUser;
    const users = await matrix.users();
    const byId = new Map<string, AdminUser>(users.map((u) => [u.name, u]));
    const guestIds = new Set(guests.map((g) => g.userId));
    const appIds = new Set(config.apps.map((a) => `@${appSlug(a.name)}:${server}`));

    // People: an account for everyone in the directory, named as Identity names them; leavers deactivated.
    const company = new Map<string, DirectoryPerson & { userId: string }>();
    if (people) {
      for (const p of people) {
        const userId = userIdOf(p.email, server);
        const have = byId.get(userId);
        if (p.disabled) {
          if (have && !have.deactivated) {
            await matrix.deactivate(userId);
            result.removed.push(p.email);
          }
          continue;
        }
        if (company.has(userId)) {
          result.warnings.push(`${p.email} and ${company.get(userId)!.email} both have the Matrix account ${userId}; only the first is used.`);
          continue;
        }
        company.set(userId, { ...p, userId });
        if (!have) {
          await matrix.putUser(userId, { displayname: p.name, threepids: [{ medium: "email", address: p.email }] });
          result.created.push(p.email);
        } else if (have.deactivated) {
          result.warnings.push(`${p.email} is on in Identity but their Matrix account ${userId} was deactivated; an admin turns it on again in Synapse.`);
          company.delete(userId);
        } else if ((have.displayname ?? "") !== p.name) {
          await matrix.putUser(userId, { displayname: p.name });
          result.updated.push(p.email);
        }
      }
    } else {
      for (const u of users)
        if (!u.deactivated && u.name !== service && !guestIds.has(u.name) && !appIds.has(u.name) && u.user_type !== "bot" && u.user_type !== "support")
          company.set(u.name, { email: u.name, name: u.displayname ?? u.name, groups: [], disabled: false, userId: u.name });
    }

    // The company space: every channel of the file is in it, and joining a channel open to the company needs it.
    const spaceAlias = `#${SPACE}:${server}`;
    let spaceId = await matrix.roomIdOf(spaceAlias);
    if (!spaceId) {
      spaceId = (
        await matrix.svc<{ room_id: string }>("POST", "/_matrix/client/v3/createRoom", {
          body: {
            room_alias_name: SPACE,
            name: organization,
            topic: "Everyone in the company. Channels open to the company are joined from here.",
            preset: "private_chat",
            room_version: ROOM_VERSION,
            creation_content: { type: "m.space" },
            initial_state: [
              { type: MARK, state_key: "", content: { managedBy: "file" } },
              { type: "m.room.history_visibility", state_key: "", content: { history_visibility: "shared" } },
              { type: "m.room.guest_access", state_key: "", content: { guest_access: "forbidden" } },
            ],
            power_level_content_override: { users: { [service]: 100 }, events_default: 100, invite: 100, state_default: 100 },
          },
        })
      ).room_id;
      result.created.push(spaceAlias);
    }
    const spaceMembers = new Set(await matrix.roomMembers(spaceId));
    for (const id of company.keys()) if (!spaceMembers.has(id)) await matrix.forceJoin(spaceId, id);
    const spaceState = stateMap(await matrix.roomState(spaceId));

    const groupOf = new Map<string, string[]>();
    for (const p of company.values()) for (const g of p.groups) groupOf.set(g.toLowerCase(), [...(groupOf.get(g.toLowerCase()) ?? []), p.userId]);
    const resolve = (entries: string[], at: string): string[] => {
      const out = new Set<string>();
      for (const e of entries) {
        if (e === "group:everyone") for (const id of company.keys()) out.add(id);
        else if (e.startsWith("group:")) {
          if (!people) result.warnings.push(`${at}: ${e} needs Identity for groups (CHAT_IDENTITY_URL).`);
          for (const id of groupOf.get(e.slice(6).toLowerCase()) ?? []) out.add(id);
        } else {
          const id = userIdOf(e, server);
          if (company.has(id)) out.add(id);
          else result.warnings.push(`${at}: ${e} is not in the company directory.`);
        }
      }
      return [...out];
    };

    // Channels of the file.
    const listed = new Set<string>();
    for (const channel of config.channels) {
      const alias = `#${channel.name}:${server}`;
      const wanted = resolve(channel.members, `#${channel.name}`);
      const adminIds = resolve(channel.admins, `#${channel.name}.admins`);
      const joinRule = channel.private ? { join_rule: "invite" } : { join_rule: "restricted", allow: [{ type: "m.room_membership", room_id: spaceId }] };
      const mark: Mark = { managedBy: "file", members: channel.members, admins: channel.admins, guests: channel.guests, posts: channel.posts };
      let roomId = await matrix.roomIdOf(alias);
      if (!roomId) {
        roomId = (
          await matrix.svc<{ room_id: string }>("POST", "/_matrix/client/v3/createRoom", {
            body: {
              room_alias_name: channel.name,
              name: channel.name,
              ...(channel.topic && { topic: channel.topic }),
              preset: "private_chat",
              room_version: ROOM_VERSION,
              initial_state: [
                { type: MARK, state_key: "", content: mark },
                { type: "m.room.join_rules", state_key: "", content: joinRule },
                { type: "m.room.history_visibility", state_key: "", content: { history_visibility: "shared" } },
                { type: "m.room.guest_access", state_key: "", content: { guest_access: "forbidden" } },
                { type: "m.room.retention", state_key: "", content: retentionContent(channel.retention) },
                { type: "m.space.parent", state_key: spaceId, content: { via: [server], canonical: true } },
              ],
              power_level_content_override: powerLevels(undefined, service, channel, adminIds, []),
            },
          })
        ).room_id;
        result.created.push(alias);
      } else {
        const state = stateMap(await matrix.roomState(roomId));
        const have = state.get(`${MARK}|`)?.content as Mark | undefined;
        if (!have) {
          result.warnings.push(`${alias} is a room Chat did not make; give the channel another name, or remove the room's address in Element.`);
          continue;
        }
        const changes: Array<[string, string, unknown]> = [];
        if (!same(have, mark)) changes.push([MARK, "", mark]);
        if ((state.get("m.room.name|")?.content.name ?? "") !== channel.name) changes.push(["m.room.name", "", { name: channel.name }]);
        if ((state.get("m.room.topic|")?.content.topic ?? null) !== (channel.topic ?? null)) changes.push(["m.room.topic", "", { topic: channel.topic ?? "" }]);
        if (!same(state.get("m.room.join_rules|")?.content, joinRule)) changes.push(["m.room.join_rules", "", joinRule]);
        const retention = retentionContent(held.has(roomId) ? null : channel.retention);
        if (!same(state.get("m.room.retention|")?.content ?? {}, retention)) changes.push(["m.room.retention", "", retention]);
        const current = state.get("m.room.power_levels|")?.content;
        const pl = powerLevels(current, service, channel, adminIds, resolve(have.admins ?? [], `#${channel.name}.admins`));
        if (!same(current, pl)) changes.push(["m.room.power_levels", "", pl]);
        for (const [type, key, content] of changes) await matrix.putState(roomId, type, key, content);
        if (changes.length) result.updated.push(alias);
      }
      listed.add(roomId);

      // Open to the company: listed in the room directory, so Element's Explore shows it; private ones are not.
      const visibility = channel.private ? "private" : "public";
      const listedNow = await matrix.svc<{ visibility: string }>("GET", `/_matrix/client/v3/directory/list/room/${seg(roomId)}`);
      if (listedNow.visibility !== visibility)
        await matrix.svc("PUT", `/_matrix/client/v3/directory/list/room/${seg(roomId)}`, { body: { visibility } }).catch((err: unknown) => {
          if (!(err instanceof MatrixError && err.status === 403)) throw err;
          result.warnings.push(`#${channel.name} is not in the room directory: Synapse's room_list_publication_rules do not let ${service} publish rooms.`);
        });
      if (!same(spaceState.get(`m.space.child|${roomId}`)?.content, { via: [server], suggested: !channel.private }))
        await matrix.putState(spaceId, "m.space.child", roomId, { via: [server], suggested: !channel.private });

      // Members: the file's people are put in; a private channel also loses those it no longer gives.
      const members = new Set(await matrix.roomMembers(roomId));
      for (const id of new Set([...wanted, ...adminIds])) if (!members.has(id)) await matrix.forceJoin(roomId, id);
      if (channel.private) {
        const keep = new Set([service, ...wanted, ...adminIds, ...guests.filter((g) => g.roomId === roomId).map((g) => g.userId)]);
        for (const app of config.apps) if (app.channels.includes(channel.name)) keep.add(`@${appSlug(app.name)}:${server}`);
        for (const id of members) {
          if (keep.has(id) || !id.endsWith(`:${server}`)) continue;
          await matrix.svc("POST", `/_matrix/client/v3/rooms/${seg(roomId)}/kick`, {
            body: { user_id: id, reason: "Not given this channel by the chat file." },
          });
          result.removed.push(`${id} from #${channel.name}`);
        }
      }
    }

    // Channels the file made and no longer lists: handed to their members.
    for (const [key, event] of spaceState) {
      if (!key.startsWith("m.space.child|") || !event.content.via) continue;
      const roomId = event.state_key!;
      if (listed.has(roomId)) continue;
      let state: Map<string, MatrixEvent>;
      try {
        state = stateMap(await matrix.roomState(roomId));
      } catch (err) {
        if (err instanceof MatrixError && err.status === 404) continue;
        throw err;
      }
      const mark = state.get(`${MARK}|`)?.content as Mark | undefined;
      if (mark?.managedBy !== "file") continue;
      await matrix.putState(roomId, MARK, "", { managedBy: "people", guests: mark.guests ?? false, posts: mark.posts ?? "everyone" } satisfies Mark);
      result.released.push(`#${state.get("m.room.name|")?.content.name ?? roomId}`);
    }

    await syncApps(matrix, config.apps, byId, result);
    result.ok = true;
  } catch (err) {
    result.error = (err as Error).message;
  }
  return result;
}

/** Each app of the file posts as an account of its own, marked as a bot, and is a member of its channels. */
async function syncApps(matrix: Matrix, apps: App[], byId: Map<string, AdminUser>, result: SyncResult) {
  const server = matrix.serverName;
  for (const app of apps) {
    const userId = `@${appSlug(app.name)}:${server}`;
    const have = byId.get(userId);
    if (!have) {
      await matrix.putUser(userId, { displayname: app.name, user_type: "bot" });
      result.created.push(userId);
    } else if (have.displayname !== app.name) await matrix.putUser(userId, { displayname: app.name });
    for (const name of app.channels) {
      const roomId = await matrix.roomIdOf(`#${name}:${server}`);
      if (!roomId) continue;
      const members = await matrix.roomMembers(roomId);
      if (!members.includes(userId)) await matrix.forceJoin(roomId, userId);
    }
  }
}
