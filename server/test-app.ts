// Starts the app on a random port for tests, against a Matrix server in memory and a company directory.
import { mkdtempSync } from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuth } from "@openasy/auth";
import { createApp, type AppOptions } from "./app.ts";
import { createChat } from "./chat.ts";
import { parseConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { fakeSynapse, SHARED_SECRET } from "./fake-synapse.ts";
import type { DirectoryPerson } from "./identity.ts";
import { createMatrix } from "./matrix.ts";

export const ADMIN_TOKEN = "test-admin-token";
/** Tokens that act as a signed-in person, as personTokens. */
export const EMILY = "test-emily-token";
export const BEN = "test-ben-token";
export const DANA = "test-dana-token";
export const CHRIS = "test-chris-token";
export const VIEWER = "test-viewer-token";

/** The chat file the tests start with. */
export const FILE = `
defaults: { retention: 1y }
guests: { days: 60 }
channels:
  - { name: general, topic: Company-wide news and questions, members: [group:everyone], retention: 2y }
  - { name: ops-oncall, topic: Paging and alerts, members: [group:platform, emily@example.com], retention: 1y }
  - { name: leadership, private: true, members: [group:leadership] }
  - { name: northwind-shared, private: true, members: [chris@example.com, emily@example.com], guests: true }
  - { name: announcements, members: [group:everyone], posts: admins, admins: [emily@example.com], retention: forever }
apps:
  - { name: Alerts, channels: [ops-oncall] }
`;

export function directoryOf(people: DirectoryPerson[]) {
  return { people: async () => people };
}

export const PEOPLE: DirectoryPerson[] = [
  { email: "emily@example.com", name: "Emily Clark", groups: ["Operations", "Leadership"], disabled: false },
  { email: "ben@example.com", name: "Ben Ortiz", groups: ["Platform"], disabled: false },
  { email: "dana@example.com", name: "Dana Kim", groups: ["Security"], disabled: false },
  { email: "chris@example.com", name: "Chris Shaw", groups: ["Sales"], disabled: false },
  { email: "mark@example.com", name: "Mark Lee", groups: ["Sales"], disabled: false },
];

export async function startApp(opts: Partial<AppOptions> & { version: string; file?: string; people?: DirectoryPerson[] }) {
  const db = openDb(":memory:");
  const { file = FILE, people = PEOPLE.map((p) => ({ ...p })), ...rest } = opts;
  const fake = fakeSynapse();
  const matrix = createMatrix({ url: "http://synapse:8008", fetch: fake.fetch });
  await matrix.signInService(SHARED_SECRET, "openasy-chat");
  const dataDir = mkdtempSync(join(tmpdir(), "chat-test-"));
  let clock = Date.now();
  const chat = createChat(db, matrix, {
    publicUrl: "https://chat.example.com",
    homeserverUrl: "https://matrix.example.com",
    directory: directoryOf(people),
    organization: "Acme",
    dataDir,
    clock: () => clock,
  });
  const first = await chat.setConfig(parseConfig(file));
  if (!first.ok) throw new Error(`first sync failed: ${first.error}`);
  // The origin is known once the port is, so the handler is set after listening.
  let handler: RequestListener = (_req, res) => res.writeHead(503).end();
  const server: Server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const auth = createAuth({ db, product: "chat", productName: "OpenAsy Chat", origin: base, users: true });
  const personTokens = {
    [EMILY]: { email: "emily@example.com", name: "Emily Clark", role: "admin" as const },
    [BEN]: { email: "ben@example.com", name: "Ben Ortiz", role: "user" as const },
    [DANA]: { email: "dana@example.com", name: "Dana Kim", role: "user" as const },
    [CHRIS]: { email: "chris@example.com", name: "Chris Shaw", role: "user" as const },
    [VIEWER]: { email: "dana@example.com", name: "Dana Kim", role: "viewer" as const },
  };
  handler = createApp({ db, chat, auth, adminToken: ADMIN_TOKEN, personTokens, ...rest });
  const as =
    (token: string) =>
    (path: string, init: RequestInit = {}) =>
      fetch(base + path, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers } });
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return {
    db,
    chat,
    fake,
    matrix,
    auth,
    base,
    people,
    dataDir,
    tick: (ms: number) => (clock += ms),
    admin: as(ADMIN_TOKEN),
    emily: as(EMILY),
    ben: as(BEN),
    dana: as(DANA),
    chris: as(CHRIS),
    as,
    close,
  };
}

export type TestApp = Awaited<ReturnType<typeof startApp>>;
