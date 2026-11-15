import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Forward-only migrations (ADR 0010): append new entries, never edit or remove old ones. Messages, files and members
// are on the Matrix server; this file holds sign-in (from @openasy/auth), the service account's token, the history of
// bringing the server in step with the file, guests and their access, the apps' webhook tokens, legal holds and exports.
const MIGRATIONS = [
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   -- Each time the Matrix server was brought in step with the chat file, and what changed. The last 100 are kept.
   CREATE TABLE sync_runs (
     id INTEGER PRIMARY KEY,
     at TEXT NOT NULL,
     ok INTEGER NOT NULL,
     created INTEGER NOT NULL,
     updated INTEGER NOT NULL,
     released INTEGER NOT NULL,
     warnings INTEGER NOT NULL,
     error TEXT
   );
   -- People from outside the company, invited to one channel until a day. Only the hash of their welcome link is kept.
   CREATE TABLE guests (
     id TEXT PRIMARY KEY,
     email TEXT NOT NULL,
     name TEXT NOT NULL,
     company TEXT,
     user_id TEXT NOT NULL UNIQUE,
     room_id TEXT NOT NULL,
     channel TEXT NOT NULL,
     invited_by TEXT NOT NULL,
     created_at TEXT NOT NULL,
     ends_at TEXT NOT NULL,
     ended_at TEXT,
     link_hash TEXT,
     link_used_at TEXT
   );
   -- The secret address each app of the file posts to. Only the token's hash is kept.
   CREATE TABLE hooks (
     app TEXT PRIMARY KEY,
     token_hash TEXT NOT NULL UNIQUE,
     created_at TEXT NOT NULL,
     created_by TEXT NOT NULL,
     used_at TEXT
   );
   -- Exports for a legal request: who started it, what it covers, and the archive's hash. The archive is a file next to
   -- the database.
   CREATE TABLE exports (
     id TEXT PRIMARY KEY,
     reference TEXT NOT NULL,
     room_id TEXT NOT NULL,
     channel TEXT NOT NULL,
     from_day TEXT NOT NULL,
     to_day TEXT NOT NULL,
     senders TEXT NOT NULL,
     started_by TEXT NOT NULL,
     started_at TEXT NOT NULL,
     finished_at TEXT,
     state TEXT NOT NULL CHECK (state IN ('running', 'ready', 'failed')),
     messages INTEGER NOT NULL DEFAULT 0,
     files INTEGER NOT NULL DEFAULT 0,
     bytes INTEGER NOT NULL DEFAULT 0,
     sha256 TEXT,
     error TEXT
   );
   -- A legal hold keeps a room's messages past its retention until it is released. The retention it had is kept to
   -- put back.
   CREATE TABLE holds (
     id TEXT PRIMARY KEY,
     reference TEXT NOT NULL,
     room_id TEXT NOT NULL,
     channel TEXT NOT NULL,
     previous TEXT,
     placed_by TEXT NOT NULL,
     placed_at TEXT NOT NULL,
     released_by TEXT,
     released_at TEXT
   );
   CREATE INDEX holds_room ON holds (room_id) WHERE released_at IS NULL`,
];

/** Opens the product's single SQLite file in WAL mode (ADR 0011) and migrates it forward. */
export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as { v: number };
  for (let v = row.v; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]!);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(v + 1, new Date().toISOString());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return db;
}
