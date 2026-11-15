// Writes openapi.json (ADR 0014, 0024). Run `npm run openapi` after changing the API; a test fails when the file is out
// of date. Sign-in routes come from @openasy/auth and are merged in when the description is served.
import { readFileSync, writeFileSync } from "node:fs";

type S = Record<string, unknown>;
const ref = (n: string) => ({ $ref: `#/components/schemas/${n}` });
const str = { type: "string" };
const int = { type: "integer" };
const bool = { type: "boolean" };
const dt = { type: "string", format: "date-time" };
const day = { type: "string", format: "date", examples: ["2026-10-31"] };
const nul = (s: S) => ({ anyOf: [s, { type: "null" }] });
const arr = (s: S) => ({ type: "array", items: s });
const en = (...values: string[]) => ({ type: "string", enum: values });
const obj = (properties: Record<string, S>, required = Object.keys(properties)) => ({ type: "object", required, properties });
const retention = { type: "string", description: "30d, 12w, 6m, 2y or forever.", examples: ["1y", "90d", "forever"] };

const problem = { $ref: "#/components/responses/Problem" };
const ok = (schema: S, description = "OK") => ({ description, content: { "application/json": { schema } } });
const created = (schema: S, description = "Created.") => ({ description, content: { "application/json": { schema } } });
const noContent = (description: string) => ({ description });
const SECURE = [{ session: [] }, { apiToken: [] }, { adminToken: [] }];
const path = (name: string, description: string) => ({ name, in: "path", required: true, description, schema: str });
const ROOM = path("id", "The conversation's Matrix room id, such as !abc:example.com.");
const EVENT = path("event", "The message's Matrix event id, such as $abc.");
const query = (name: string, description: string, schema: S = str) => ({ name, in: "query", required: false, description, schema });
const json = (schema: S) => ({ required: true, content: { "application/json": { schema } } });

/** An operation that needs a role (ADR 0003), with the refusals every such operation can answer. */
function op(role: "user" | "viewer" | "editor" | "admin", o: S & { responses: Record<string, unknown> }) {
  return {
    ...o,
    security: SECURE,
    "x-openasy-role": role,
    description: [o.description, role === "user" ? "Any member (the user role is enough)." : `Needs the ${role} role.`].filter(Boolean).join("\n\n"),
    responses: { ...o.responses, "401": problem, "403": problem },
  };
}
/** A person's own conversations: a signed-in person, never an API token; Chat acts on the Matrix server as them. */
function self(o: S & { responses: Record<string, unknown> }) {
  return {
    ...o,
    security: [{ session: [] }],
    "x-openasy-role": "user",
    description: [o.description, "As the signed-in person, on their own Matrix account; API tokens are refused."].filter(Boolean).join("\n\n"),
    responses: { "502": problem, ...o.responses, "401": problem, "403": problem },
  };
}
const pub = (o: S & { responses: Record<string, unknown> }) => ({ ...o, security: [] });

const Sender = obj({
  userId: { type: "string", examples: ["@ben:example.com"] },
  name: str,
  app: { ...nul(str), description: "The app's name when an app of the file posted it." },
  guest: bool,
});
const FileRef = obj({ uri: { type: "string", examples: ["mxc://example.com/abc"] }, name: str, size: nul(int), type: nul(str) });
const Card = obj({
  title: str,
  severity: nul(en("critical", "high", "medium", "low", "info")),
  status: nul(obj({ label: str, tone: en("success", "warning", "danger", "info", "neutral") })),
  fields: arr({ type: "array", items: str, minItems: 2, maxItems: 2 }),
  link: nul(obj({ label: str, url: str })),
});
const Reaction = obj({ emoji: str, count: int, mine: bool, by: arr(str) });
const messageProps = {
  id: str,
  sender: ref("Sender"),
  ts: dt,
  text: str,
  edited: bool,
  deleted: bool,
  encrypted: { type: "boolean", description: "End-to-end encrypted: only the people's own Matrix apps read it." },
  file: nul(ref("FileRef")),
  card: nul(ref("Card")),
  reactions: arr(ref("Reaction")),
  thread: nul(obj({ count: int, lastTs: nul(dt), participants: arr(ref("Sender")) })),
  threadRoot: nul(str),
  mentionsMe: bool,
};
const Message = obj(messageProps);
const kind = en("public", "private", "guests", "incident", "dm");
const RoomRef = obj({ id: str, name: str, kind });

const Conversation = obj({
  id: str,
  name: str,
  kind,
  topic: nul(str),
  members: int,
  unread: int,
  mentions: int,
  encrypted: bool,
  guestsAllowed: { type: "boolean", description: "Guests from outside the company may be invited to it." },
  with: arr(ref("Sender")),
  lastTs: nul(dt),
  invited: { type: "boolean", description: "Invited and not joined yet; opening it joins." },
});
const ConversationDetail = obj({
  id: str,
  name: str,
  alias: nul(str),
  kind,
  topic: nul(str),
  members: int,
  someMembers: arr(ref("Sender")),
  with: arr(ref("Sender")),
  from: { type: "string", description: "Where the members come from, as the file names them." },
  managedBy: en("file", "people", "api"),
  reference: nul(str),
  retention,
  hold: { ...nul(str), description: "A legal hold's reference: nothing is deleted while it is on." },
  guestsAllowed: bool,
  guests: arr(obj({ id: str, name: str, company: nul(str), endsAt: dt, invitedBy: str })),
  encrypted: bool,
  canPost: bool,
  pinned: arr(ref("Message")),
});

const Person = obj({
  userId: str,
  name: str,
  email: nul(str),
  presence: en("online", "away", "busy", "offline"),
  status: nul(str),
  timeZone: { ...nul(str), description: "The IANA time zone the person shares in their Matrix profile (m.tz)." },
  groups: arr(str),
  channels: int,
  guest: nul(obj({ id: str, company: nul(str), channel: str, roomId: str, invitedBy: str, endsAt: dt, welcomed: bool })),
  me: bool,
});

const fileEntry = obj({
  name: str,
  topic: nul(str),
  private: bool,
  members: arr(str),
  admins: arr(str),
  retention,
  guests: bool,
  posts: en("everyone", "admins"),
});
const AdminChannel = obj({
  id: str,
  name: str,
  alias: nul(str),
  kind: en("public", "private", "guests", "incident"),
  topic: nul(str),
  members: int,
  from: str,
  managedBy: en("file", "people", "api"),
  by: { ...nul(str), description: "For api: the API token's name, such as Incidents." },
  reference: nul(str),
  retention,
  hold: nul(str),
  guests: { type: "boolean", description: "Guests may be invited." },
  guestCount: int,
  posts: en("everyone", "admins"),
  encrypted: bool,
  entry: { ...nul(fileEntry), description: "The channel's entry in the chat file." },
});

const Export = obj({
  id: str,
  reference: str,
  channel: str,
  roomId: str,
  from: day,
  to: day,
  senders: arr(str),
  startedBy: str,
  startedAt: dt,
  finishedAt: nul(dt),
  state: en("running", "ready", "failed"),
  messages: int,
  files: int,
  bytes: int,
  sha256: nul(str),
  error: nul(str),
  hold: nul(obj({ id: str, released: bool })),
});
const Hold = obj({ id: str, reference: str, channel: str, roomId: str, placedBy: str, placedAt: dt, releasedAt: nul(dt) });

const SyncResult = obj({
  at: dt,
  ok: bool,
  created: arr(str),
  updated: arr(str),
  removed: arr(str),
  released: arr(str),
  warnings: arr(str),
  error: nul(str),
});
const FileState = obj({ path: str, appliedAt: nul(dt), channels: int, apps: int, error: nul(str), text: nul(str) });

const schemas: Record<string, S> = {
  Problem: obj(
    {
      type: { type: "string", format: "uri" },
      title: str,
      status: int,
      code: {
        type: "string",
        description: "Stable; match on this.",
        enum: [
          "invalid-token",
          "invalid-json",
          "invalid-body",
          "forbidden",
          "not-found",
          "conflict",
          "encrypted",
          "matrix-unavailable",
          "payload-too-large",
          "internal-error",
          "unauthenticated",
          "invalid-credentials",
          "mfa-required",
          "mfa-setup-required",
          "cross-site",
          "rate-limited",
        ],
      },
      detail: str,
    },
    ["type", "title", "status", "code"],
  ),
  Status: obj({ status: str }),
  Version: obj({ product: { const: "chat" }, version: str }),
  Products: obj({ products: arr(obj({ id: str, url: str })) }),
  Me: obj({
    userId: str,
    email: str,
    name: str,
    role: en("user", "viewer", "editor", "admin", "owner"),
    homeserver: { type: "string", description: "Where Element and other Matrix apps reach the server." },
    serverName: str,
  }),
  Summary: obj({ channels: int, apps: int, file: nul(ref("FileState")), sync: nul(ref("SyncResult")), homeserver: str }),
  FileState,
  SyncResult,
  SyncRuns: obj({
    last: nul(ref("SyncResult")),
    runs: arr(obj({ at: dt, ok: bool, created: int, updated: int, released: int, warnings: int, error: nul(str) })),
  }),
  Config: obj({
    channels: arr(fileEntry),
    apps: arr(obj({ name: str, channels: arr(str) })),
    defaults: obj({ retention }),
    guests: obj({ days: int }),
    file: nul(ref("FileState")),
  }),
  Sender,
  FileRef,
  Card,
  Reaction,
  Message,
  Conversation,
  Conversations: obj({ userId: str, conversations: arr(ref("Conversation")) }),
  ConversationDetail,
  MessagePage: obj({ messages: arr(ref("Message")), before: { ...nul(str), description: "Pass as before= for the page of older messages." } }),
  Thread: obj({ root: ref("Message"), replies: arr(ref("Message")) }),
  Reactions: obj({ reactions: arr(ref("Reaction")) }),
  Wait: obj({ since: str, changed: arr(str) }),
  Opened: obj({ id: str, created: bool }),
  NewChannel: obj({ id: str, alias: str }),
  Directory: obj({ channels: arr(obj({ id: str, name: str, topic: nul(str), members: int, joined: bool })) }),
  SearchResults: obj({
    messages: arr({ allOf: [ref("Message"), obj({ room: RoomRef })] }),
    files: arr(obj({ id: str, file: ref("FileRef"), room: RoomRef, sender: ref("Sender"), ts: dt })),
    count: int,
  }),
  Person,
  People: obj({
    source: en("identity", "matrix"),
    people: arr(ref("Person")),
    leaving: { ...arr(obj({ name: str, email: str, channels: int })), description: "Turned off in Identity, taken out at the next sync." },
  }),
  GuestInvited: obj({ id: str, userId: str, endsAt: dt, link: { type: "string", description: "The welcome link; shown once." } }),
  Welcome: obj({ name: str, channel: str, userId: str, endsAt: dt, homeserver: str }),
  Welcomed: obj({ userId: str, homeserver: str }),
  AdminChannel,
  Channels: obj({
    channels: arr(ref("AdminChannel")),
    totals: obj({
      channels: int,
      fromFile: int,
      private: int,
      withGuests: int,
      guests: int,
      files: { ...nul(int), description: "Bytes of files on the server." },
      messages: { ...nul(int), description: "Bytes of messages in the database; Synapse tells it only on PostgreSQL." },
    }),
  }),
  Export,
  Hold,
  Exports: obj({ exports: arr(ref("Export")), holds: arr(ref("Hold")) }),
  Integrations: obj({
    matrix: obj({ homeserver: str, serverName: nul(str), version: nul(str), ok: bool, user: nul(str) }),
    identity: obj({ configured: bool, ok: bool, error: nul(str), people: int, at: nul(dt) }),
    apps: arr(obj({ name: str, userId: nul(str), channels: arr(str), hook: nul(obj({ createdAt: dt, usedAt: nul(dt) })) })),
  }),
  Hook: obj({ app: str, url: { type: "string", description: "The webhook address; shown once. Making a new one ends the old one." } }),
  Posted: obj({ eventId: str, channel: str }),
};

const paths: Record<string, S> = {
  "/api/v1/version": { get: pub({ operationId: "version", tags: ["Product"], summary: "Product and version", responses: { "200": ok(ref("Version")) } }) },
  "/api/v1/products": {
    get: op("user", { operationId: "products", tags: ["Product"], summary: "The install's other OpenAsy products", responses: { "200": ok(ref("Products")) } }),
  },
  "/api/v1/summary": {
    get: op("viewer", {
      operationId: "summary",
      tags: ["Product"],
      summary: "The file, the last sync and the server",
      responses: { "200": ok(ref("Summary")) },
    }),
  },
  "/api/v1/me": {
    get: self({
      operationId: "me",
      tags: ["Product"],
      summary: "The signed-in person's Matrix account",
      description: "Made the first time they open Chat when Identity has not made it yet.",
      responses: { "200": ok(ref("Me")) },
    }),
  },
  "/api/v1/config": {
    get: op("viewer", {
      operationId: "config",
      tags: ["File"],
      summary: "The channels, apps and rules of the chat file, as applied",
      responses: { "200": ok(ref("Config")) },
    }),
  },
  "/api/v1/sync": {
    get: op("viewer", {
      operationId: "syncRuns",
      tags: ["File"],
      summary: "The last times the server was brought in step with the file",
      responses: { "200": ok(ref("SyncRuns")) },
    }),
    post: op("admin", {
      operationId: "syncNow",
      tags: ["File"],
      summary: "Bring the server in step with the file now",
      description: "Also happens after every change of the file and every five minutes.",
      responses: { "200": ok(ref("SyncResult")) },
    }),
  },

  "/api/v1/conversations": {
    get: self({
      operationId: "conversations",
      tags: ["Messages"],
      summary: "Channels and direct messages the person is in, with unread counts",
      responses: { "200": ok(ref("Conversations")) },
    }),
  },
  "/api/v1/conversations/direct": {
    post: self({
      operationId: "openDirect",
      tags: ["Messages"],
      summary: "Open a direct conversation",
      description: "The existing one with the same person, or a new one; the others are invited.",
      requestBody: json(obj({ people: arr(str) })),
      responses: { "200": ok(ref("Opened")), "400": problem, "422": problem },
    }),
  },
  "/api/v1/conversations/{id}": {
    get: self({
      operationId: "conversation",
      tags: ["Messages"],
      summary: "A conversation: topic, members, retention, guests and pinned messages",
      parameters: [ROOM],
      responses: { "200": ok(ref("ConversationDetail")), "404": problem },
    }),
  },
  "/api/v1/conversations/{id}/messages": {
    get: self({
      operationId: "messages",
      tags: ["Messages"],
      summary: "A page of messages, oldest first",
      description: "Thread replies are counted on the thread's first message; edits and reactions are folded in.",
      parameters: [ROOM, query("before", "The before value of the previous page, for older messages.")],
      responses: { "200": ok(ref("MessagePage")), "404": problem },
    }),
    post: self({
      operationId: "send",
      tags: ["Messages"],
      summary: "Send a message, a file or a reply in a thread",
      description: "@ and a member's name mentions them; @here mentions everyone in the channel.",
      parameters: [ROOM],
      requestBody: json(
        obj(
          {
            text: str,
            file: { ...ref("FileRef"), description: "From POST /api/v1/files." },
            threadRoot: { ...nul(str), description: "The thread's first message, to reply in it." },
            alsoInChannel: { type: "boolean", description: "A reply in a thread is also sent to the channel." },
          },
          [],
        ),
      ),
      responses: { "201": created(ref("Message")), "400": problem, "404": problem, "422": problem },
    }),
  },
  "/api/v1/conversations/{id}/threads/{event}": {
    get: self({
      operationId: "thread",
      tags: ["Messages"],
      summary: "A thread: its first message and the replies",
      parameters: [ROOM, EVENT],
      responses: { "200": ok(ref("Thread")), "404": problem },
    }),
  },
  "/api/v1/conversations/{id}/messages/{event}/reactions": {
    post: self({
      operationId: "react",
      tags: ["Messages"],
      summary: "Add a reaction, or take yours back",
      parameters: [ROOM, EVENT],
      requestBody: json(obj({ emoji: str })),
      responses: { "200": ok(ref("Reactions")), "400": problem, "404": problem, "422": problem },
    }),
  },
  "/api/v1/conversations/{id}/read": {
    post: self({
      operationId: "markRead",
      tags: ["Messages"],
      summary: "Mark the conversation read up to a message",
      parameters: [ROOM],
      requestBody: json(obj({ eventId: str })),
      responses: { "204": noContent("Marked."), "400": problem, "404": problem, "422": problem },
    }),
  },
  "/api/v1/conversations/{id}/join": {
    post: self({
      operationId: "join",
      tags: ["Messages"],
      summary: "Join a channel open to the company, or accept an invitation",
      parameters: [ROOM],
      responses: { "204": noContent("Joined."), "404": problem },
    }),
  },
  "/api/v1/conversations/{id}/leave": {
    post: self({
      operationId: "leave",
      tags: ["Messages"],
      summary: "Leave a conversation",
      parameters: [ROOM],
      responses: { "204": noContent("Left."), "404": problem },
    }),
  },
  "/api/v1/wait": {
    get: self({
      operationId: "wait",
      tags: ["Messages"],
      summary: "Wait for anything new",
      description: "Without since it answers at once with the place to start; with it, it waits up to 25 seconds and names the conversations that changed.",
      parameters: [query("since", "The since value of the previous answer.")],
      responses: { "200": ok(ref("Wait")) },
    }),
  },
  "/api/v1/files": {
    post: self({
      operationId: "upload",
      tags: ["Messages"],
      summary: "Upload a file to attach to a message",
      description: "The body is the file; Content-Type its type and X-File-Name its name. It is kept on the Matrix server.",
      requestBody: { required: true, content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } },
      responses: { "201": created(ref("FileRef")), "413": problem, "422": problem },
    }),
  },
  "/api/v1/files/{server}/{media}": {
    get: self({
      operationId: "download",
      tags: ["Messages"],
      summary: "Download a file of a message",
      parameters: [
        path("server", "The server part of the mxc:// address."),
        path("media", "The media id of the mxc:// address."),
        query("name", "The name to save it as."),
      ],
      responses: {
        "200": {
          description: "The file.",
          content: Object.fromEntries(
            ["application/octet-stream", "image/png", "image/jpeg", "image/gif", "image/webp"].map((t) => [
              t,
              { schema: { type: "string", format: "binary" } },
            ]),
          ),
        },
        "404": problem,
      },
    }),
  },
  "/api/v1/search": {
    get: self({
      operationId: "search",
      tags: ["Search"],
      summary: "Messages and files the person may see",
      description:
        'Channels open to the company, even ones the person has not joined, and the private channels and direct messages they are in. q takes from:name, in:#channel, has:file, before:YYYY-MM-DD, after:YYYY-MM-DD and "exact words".',
      parameters: [
        query("q", "What to look for."),
        query("in", "A conversation's id."),
        query("from", "A sender's Matrix user id."),
        query("days", "Only the last this many days."),
      ],
      responses: { "200": ok(ref("SearchResults")), "422": problem },
    }),
  },
  "/api/v1/people": {
    get: self({
      operationId: "people",
      tags: ["People"],
      summary: "Members and guests, with presence, local time and groups",
      responses: { "200": ok(ref("People")) },
    }),
  },
  "/api/v1/directory": {
    get: self({ operationId: "browse", tags: ["Channels"], summary: "Channels open to the company, to join", responses: { "200": ok(ref("Directory")) } }),
  },
  "/api/v1/channels": {
    get: op("viewer", {
      operationId: "channels",
      tags: ["Channels"],
      summary: "Every channel with where its members come from, its retention, holds and guests",
      responses: { "200": ok(ref("Channels")) },
    }),
    post: {
      operationId: "createChannel",
      tags: ["Channels"],
      summary: "Make a channel",
      description:
        "A signed-in person makes one for themselves. A product such as Incidents makes one with an API token that has the editor role, with its members, a reference and kind incident.",
      security: SECURE,
      "x-openasy-role": "user",
      requestBody: json(
        obj(
          {
            name: { type: "string", examples: ["inc-2041-api-latency"] },
            topic: str,
            private: bool,
            members: arr(str),
            kind: en("incident"),
            reference: { type: "string", examples: ["INC-2041"] },
          },
          ["name"],
        ),
      ),
      responses: { "201": created(ref("NewChannel")), "400": problem, "401": problem, "403": problem, "409": problem, "422": problem, "502": problem },
    },
  },
  "/api/v1/channels/{id}": {
    patch: op("admin", {
      operationId: "updateChannel",
      tags: ["Channels"],
      summary: "Retention, who posts and guests of a channel people or a product made",
      description: "The file's channels change in the file: they answer 409.",
      parameters: [path("id", "The channel's Matrix room id.")],
      requestBody: json(obj({ retention, posts: en("everyone", "admins"), guests: bool }, [])),
      responses: { "200": ok(ref("AdminChannel")), "400": problem, "404": problem, "409": problem, "422": problem, "502": problem },
    }),
  },
  "/api/v1/guests": {
    post: self({
      operationId: "inviteGuest",
      tags: ["People"],
      summary: "Invite a guest to a channel that takes guests",
      description: "The guest gets a Matrix account that sees only that channel, until the day it ends, and a welcome link to choose a password.",
      requestBody: json(obj({ email: str, name: str, company: str, channel: str, days: int }, ["email", "name", "channel"])),
      responses: { "201": created(ref("GuestInvited")), "400": problem, "404": problem, "409": problem, "422": problem },
    }),
  },
  "/api/v1/guests/{id}": {
    delete: self({
      operationId: "endGuest",
      tags: ["People"],
      summary: "End a guest's access",
      description: "Who invited them, or an admin.",
      parameters: [path("id", "The guest's id.")],
      responses: { "204": noContent("Ended."), "404": problem },
    }),
  },
  "/api/v1/welcome/{token}": {
    get: pub({
      operationId: "welcome",
      tags: ["People"],
      summary: "A guest's welcome link",
      parameters: [path("token", "From the link.")],
      responses: { "200": ok(ref("Welcome")), "404": problem },
    }),
    post: pub({
      operationId: "acceptWelcome",
      tags: ["People"],
      summary: "The guest chooses a password for Element",
      parameters: [path("token", "From the link.")],
      requestBody: json(obj({ password: str })),
      responses: { "200": ok(ref("Welcomed")), "400": problem, "404": problem, "422": problem, "502": problem },
    }),
  },
  "/api/v1/exports": {
    get: op("admin", {
      operationId: "exports",
      tags: ["Legal"],
      summary: "Exports for legal requests and legal holds",
      responses: { "200": ok(ref("Exports")) },
    }),
    post: op("admin", {
      operationId: "startExport",
      tags: ["Legal"],
      summary: "Export a channel for a legal request",
      description:
        "Every message, edit, reaction and file in the range, as a ZIP with a manifest signed with Ed25519. With hold, nothing in the channel is deleted until the hold is released. Recorded in the audit log.",
      requestBody: json(obj({ reference: str, channel: str, from: day, to: day, senders: arr(str), hold: bool }, ["reference", "channel", "from", "to"])),
      responses: { "201": created(ref("Export")), "400": problem, "404": problem, "422": problem, "502": problem },
    }),
  },
  "/api/v1/exports/key": {
    get: op("viewer", {
      operationId: "exportKey",
      tags: ["Legal"],
      summary: "The public key export manifests are signed with",
      responses: { "200": { description: "PEM.", content: { "application/x-pem-file": { schema: str } } } },
    }),
  },
  "/api/v1/exports/{id}": {
    get: op("admin", {
      operationId: "export",
      tags: ["Legal"],
      summary: "An export",
      parameters: [path("id", "The export's id.")],
      responses: { "200": ok(ref("Export")), "404": problem },
    }),
  },
  "/api/v1/exports/{id}/archive": {
    get: op("admin", {
      operationId: "exportArchive",
      tags: ["Legal"],
      summary: "Download an export",
      parameters: [path("id", "The export's id.")],
      responses: {
        "200": { description: "ZIP.", content: { "application/zip": { schema: { type: "string", format: "binary" } } } },
        "404": problem,
        "409": problem,
      },
    }),
  },
  "/api/v1/holds/{id}/release": {
    post: op("admin", {
      operationId: "releaseHold",
      tags: ["Legal"],
      summary: "Release a legal hold",
      description: "The channel's retention applies again.",
      parameters: [path("id", "The hold's id.")],
      responses: { "200": ok(ref("Hold")), "404": problem, "409": problem, "502": problem },
    }),
  },
  "/api/v1/integrations": {
    get: op("viewer", {
      operationId: "integrations",
      tags: ["Apps"],
      summary: "The Matrix server, Identity and the apps of the file",
      responses: { "200": ok(ref("Integrations")) },
    }),
  },
  "/api/v1/apps/{name}/hook": {
    post: op("admin", {
      operationId: "makeHook",
      tags: ["Apps"],
      summary: "Make an app's webhook address",
      parameters: [path("name", "The app's name in the file, such as Alerts.")],
      responses: { "201": created(ref("Hook")), "404": problem },
    }),
  },
  "/hooks/{token}": {
    post: pub({
      operationId: "postHook",
      tags: ["Apps"],
      summary: "An app posts a message",
      description: "The address is the key. Element shows the text; the pages also draw the card.",
      parameters: [path("token", "From the webhook address.")],
      requestBody: json(obj({ text: str, channel: { type: "string", examples: ["ops-oncall"] }, card: ref("Card") }, ["text"])),
      responses: { "202": ok(ref("Posted"), "Posted."), "400": problem, "401": problem, "404": problem, "422": problem, "502": problem },
    }),
  },

  "/healthz": { get: pub({ operationId: "healthz", tags: ["Product"], summary: "Alive", responses: { "200": ok(ref("Status")) } }) },
  "/readyz": {
    get: pub({ operationId: "readyz", tags: ["Product"], summary: "Ready", responses: { "200": ok(ref("Status")), "503": ok(ref("Status"), "Not ready.") } }),
  },
  "/metrics": {
    get: pub({
      operationId: "metrics",
      tags: ["Product"],
      summary: "Prometheus metrics",
      responses: { "200": { description: "Metrics.", content: { "text/plain": { schema: str } } } },
    }),
  },
};

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const doc = {
  openapi: "3.1.0",
  info: {
    title: "OpenAsy Chat",
    version,
    description:
      "Channels, threads, direct messages, files and search on the company's own Matrix server (Synapse), with channels set in chat.yaml and guests, retention, legal holds and exports. The messages stay on the Matrix server; a person's routes act as that person there. Every member talks; viewers read the channels and the file; admins also set the rules of channels people made, export for legal requests and manage members and tokens.",
    license: { name: "AGPL-3.0-only", identifier: "AGPL-3.0-only" },
  },
  servers: [{ url: "/" }],
  security: SECURE,
  paths,
  components: {
    securitySchemes: {
      session: { type: "apiKey", in: "cookie", name: "openasy_session" },
      apiToken: { type: "http", scheme: "bearer", description: "An API token made under Settings, API tokens." },
      adminToken: { type: "http", scheme: "bearer", description: "Tests only." },
    },
    responses: { Problem: { description: "A problem (RFC 9457).", content: { "application/problem+json": { schema: ref("Problem") } } } },
    schemas,
  },
};

export const OPENAPI = doc;
const text = JSON.stringify(doc, null, 2) + "\n";
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) {
  writeFileSync(new URL("../openapi.json", import.meta.url), text);
  console.log("openapi.json written");
}
export const OPENAPI_TEXT = text;
