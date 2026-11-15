// The channels, apps and rules Chat runs, from one YAML file (CHAT_CONFIG). As with the install's other files, the file
// is the only way in for what it lists: no screen or API route changes a channel the file sets. It is applied whole or
// not at all, read again within a minute of a change, and a file with a mistake leaves the last good version in place.
// Channels people make for themselves need nothing here; their retention starts at the file's default.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { parse } from "yaml";

/** How long messages are kept: a number of days, or forever. */
export type Retention = { days: number } | "forever";

export interface Channel {
  /** Its address in Matrix, #name:server, and what the pages show after #. */
  name: string;
  topic: string | null;
  /** Only its members see it; otherwise everyone in the company may read and join it. */
  private: boolean;
  /** group:<name> for a group from Identity (group:everyone for all), or a person's email. Empty: joined by choice. */
  members: string[];
  /** People who moderate it and, with posts: admins, the only ones who post. */
  admins: string[];
  retention: Retention;
  /** Guests from outside the company may be invited to it. */
  guests: boolean;
  posts: "everyone" | "admins";
}

export interface App {
  /** Shown as the sender, such as Alerts. */
  name: string;
  /** The channels it posts to. */
  channels: string[];
}

export interface ChatConfig {
  channels: Channel[];
  apps: App[];
  defaults: { retention: Retention };
  guestsPolicy: { days: number };
}

export const EMPTY: ChatConfig = { channels: [], apps: [], defaults: { retention: { days: 365 } }, guestsPolicy: { days: 90 } };

const NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const EMAIL = /^[a-z0-9._%+-]+@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const GROUP = /^group:[\p{L}\p{N} ._-]{1,128}$/u;
const TOP_KEYS = ["defaults", "guests", "channels", "apps"];
const CHANNEL_KEYS = ["name", "topic", "private", "members", "admins", "retention", "guests", "posts"];
const APP_KEYS = ["name", "channels"];
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** 30d, 12w, 6m, 2y or forever. */
export function parseRetention(v: unknown, at: string): Retention {
  if (v === "forever") return "forever";
  const m = typeof v === "string" ? /^(\d{1,4})([dwmy])$/.exec(v.trim()) : null;
  const days = m ? Number(m[1]) * { d: 1, w: 7, m: 30, y: 365 }[m[2] as "d" | "w" | "m" | "y"] : 0;
  if (!days || days > 36_500) throw new Error(`${at} is a time such as 30d, 12w, 6m or 2y, or forever.`);
  return { days };
}

/** The file's way of writing a retention, for the pages: 2y, 90d or forever. */
export function retentionText(r: Retention): string {
  if (r === "forever") return "forever";
  if (r.days % 365 === 0) return `${r.days / 365}y`;
  return `${r.days}d`;
}

function bool(v: unknown, at: string, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  if (typeof v !== "boolean") throw new Error(`${at} is true or false.`);
  return v;
}

function text(v: unknown, at: string, max: number): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || v.trim().length > max) throw new Error(`${at} is text of up to ${max} characters.`);
  return v.trim() || null;
}

function list(v: unknown, at: string, max: number, item: (x: unknown, at: string) => string): string[] {
  if (v === undefined || v === null || v === "by-hand") return [];
  if (!Array.isArray(v) || v.length > max) throw new Error(`${at} is a list of up to ${max} entries.`);
  const out = v.map((x, i) => item(x, `${at}[${i}]`));
  const twice = out.find((x, i) => out.indexOf(x) !== i);
  if (twice) throw new Error(`${at}: ${twice} is in the list twice.`);
  return out;
}

const email = (v: unknown, at: string) => {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (!EMAIL.test(s)) throw new Error(`${at} is an email address, such as jane@example.com.`);
  return s;
};
const member = (v: unknown, at: string) => {
  const s = typeof v === "string" ? v.trim() : "";
  if (s.startsWith("group:")) {
    if (!GROUP.test(s)) throw new Error(`${at} is group: and a group's name from Identity, such as group:platform.`);
    return s;
  }
  return email(s, `${at} (group:<name> or an email address)`);
};

/** Reads the file's text. Throws with the entry and field at fault, so one message says what to fix. */
export function parseConfig(source: string): ChatConfig {
  let doc: unknown;
  try {
    doc = parse(source);
  } catch (err) {
    throw new Error(`Not valid YAML: ${(err as Error).message.split("\n")[0]}`);
  }
  if (doc === null || doc === undefined) return structuredClone(EMPTY);
  if (!isObj(doc)) throw new Error("The file holds channels:, apps:, defaults: and guests:, and nothing else.");
  const extra = Object.keys(doc).filter((k) => !TOP_KEYS.includes(k));
  if (extra.length) throw new Error(`Unknown ${extra.join(", ")}; the file holds ${TOP_KEYS.join(", ")}.`);

  const defaultsIn = doc.defaults ?? {};
  if (!isObj(defaultsIn)) throw new Error("defaults is a map, such as defaults: { retention: 1y }.");
  const badDefaults = Object.keys(defaultsIn).filter((k) => k !== "retention");
  if (badDefaults.length) throw new Error(`defaults: unknown ${badDefaults.join(", ")}; defaults takes retention.`);
  const defaults = { retention: defaultsIn.retention === undefined ? EMPTY.defaults.retention : parseRetention(defaultsIn.retention, "defaults.retention") };

  const guestsIn = doc.guests ?? {};
  if (!isObj(guestsIn)) throw new Error("guests is a map, such as guests: { days: 90 }.");
  const badGuests = Object.keys(guestsIn).filter((k) => k !== "days");
  if (badGuests.length) throw new Error(`guests: unknown ${badGuests.join(", ")}; guests takes days.`);
  if (guestsIn.days !== undefined && (!Number.isInteger(guestsIn.days) || (guestsIn.days as number) < 1 || (guestsIn.days as number) > 730))
    throw new Error("guests.days is a number of days from 1 to 730.");
  const guestsPolicy = { days: (guestsIn.days as number | undefined) ?? 90 };

  const channelList = doc.channels ?? [];
  if (!Array.isArray(channelList)) throw new Error("channels must be a list.");
  if (channelList.length > 2000) throw new Error("channels holds at most 2000 entries.");
  const channels = channelList.map((c: unknown, i): Channel => {
    const at = `channels[${i}]`;
    if (!isObj(c)) throw new Error(`${at} must be a map with at least a name.`);
    const bad = Object.keys(c).filter((k) => !CHANNEL_KEYS.includes(k));
    if (bad.length) throw new Error(`${at}: unknown ${bad.join(", ")}; a channel takes ${CHANNEL_KEYS.join(", ")}.`);
    const name = typeof c.name === "string" ? c.name.trim().replace(/^#/, "").toLowerCase() : "";
    if (!NAME.test(name)) throw new Error(`${at}.name is required: lowercase letters, digits, dots, dashes and underscores, such as ops-oncall.`);
    if (c.posts !== undefined && c.posts !== "everyone" && c.posts !== "admins") throw new Error(`${at}.posts is everyone or admins.`);
    const admins = list(c.admins, `${at}.admins`, 200, email);
    if (c.posts === "admins" && !admins.length) throw new Error(`${at}: posts: admins needs admins, the people who post.`);
    return {
      name,
      topic: text(c.topic, `${at}.topic`, 500),
      private: bool(c.private, `${at}.private`, false),
      members: list(c.members, `${at}.members`, 5000, member),
      admins,
      retention: c.retention === undefined ? defaults.retention : parseRetention(c.retention, `${at}.retention`),
      guests: bool(c.guests, `${at}.guests`, false),
      posts: (c.posts as Channel["posts"] | undefined) ?? "everyone",
    };
  });
  const twice = channels.find((c, i) => channels.findIndex((x) => x.name === c.name) !== i);
  if (twice) throw new Error(`channels: ${twice.name} is in the file twice.`);
  const names = new Set(channels.map((c) => c.name));

  const appList = doc.apps ?? [];
  if (!Array.isArray(appList)) throw new Error("apps must be a list.");
  if (appList.length > 100) throw new Error("apps holds at most 100 entries.");
  const apps = appList.map((a: unknown, i): App => {
    const at = `apps[${i}]`;
    if (!isObj(a)) throw new Error(`${at} must be a map with name and channels.`);
    const bad = Object.keys(a).filter((k) => !APP_KEYS.includes(k));
    if (bad.length) throw new Error(`${at}: unknown ${bad.join(", ")}; an app takes ${APP_KEYS.join(", ")}.`);
    const name = text(a.name, `${at}.name`, 64);
    if (!name || !/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u.test(name)) throw new Error(`${at}.name is required: letters, digits and spaces, such as Alerts.`);
    const chans = list(a.channels, `${at}.channels`, 100, (v, where) => {
      const s = typeof v === "string" ? v.trim().replace(/^#/, "").toLowerCase() : "";
      if (!names.has(s)) throw new Error(`${where}: ${String(v)} is not a channel of this file.`);
      return s;
    });
    return { name, channels: chans };
  });
  const sameApp = apps.find((a, i) => apps.findIndex((x) => appSlug(x.name) === appSlug(a.name)) !== i);
  if (sameApp) throw new Error(`apps: ${sameApp.name} is in the file twice.`);

  return { channels, apps, defaults, guestsPolicy };
}

/** The Matrix user an app posts as: Alerts is @app-alerts:server. */
export const appSlug = (name: string) =>
  `app-${name
    .normalize("NFKD")
    .replace(/[^\w\s.-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s.]+/g, "-")}`;

export interface ConfigFileState {
  path: string;
  /** When the file was last read and applied, or null if it never was. */
  appliedAt: string | null;
  channels: number;
  apps: number;
  /** Why the file on disk is not what is applied; the last good version stays until it is fixed. */
  error: string | null;
  /** The file's text as it was last applied, for the Settings page. */
  text: string | null;
}

/**
 * Reads the file now and whenever it changes (checked every `everyMs`, by size, time and content), and hands each new
 * version to `apply`. A file that cannot be read or parsed leaves the last good one in place. A missing file is an
 * empty one: Chat works with only the channels people make. `stop()` ends the polling.
 */
export function watchConfig(
  path: string,
  apply: (config: ChatConfig) => void,
  { everyMs = 60_000, onChange }: { everyMs?: number; onChange?: (state: ConfigFileState) => void } = {},
) {
  const state: ConfigFileState = { path, appliedAt: null, channels: 0, apps: 0, error: null, text: null };
  let seen = "";
  const read = () => {
    let source: string;
    let stamp: string;
    try {
      const st = statSync(path);
      source = readFileSync(path, "utf8");
      stamp = `${st.size}:${st.mtimeMs}:${createHash("sha256").update(source).digest("hex")}`;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" && seen === "") {
        seen = "missing";
        apply(structuredClone(EMPTY));
        Object.assign(state, { appliedAt: new Date().toISOString(), channels: 0, apps: 0, error: null, text: "" });
        onChange?.(state);
        return;
      }
      const error = `Cannot read ${path}: ${code ?? (err as Error).message}`;
      if (state.error !== error && code !== "ENOENT") ((state.error = error), onChange?.(state));
      return;
    }
    if (stamp === seen) return;
    seen = stamp;
    try {
      const config = parseConfig(source);
      apply(config);
      Object.assign(state, { appliedAt: new Date().toISOString(), channels: config.channels.length, apps: config.apps.length, error: null, text: source });
    } catch (err) {
      state.error = (err as Error).message;
    }
    onChange?.(state);
  };
  read();
  const timer = setInterval(read, everyMs);
  timer.unref();
  return { state, read, stop: () => clearInterval(timer) };
}
