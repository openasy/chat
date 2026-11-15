// What the pages share: data loading with the session, dates and sizes in the viewer's language, and the small pieces
// of a message: who sent it, presence, the channel's icon, mentions and inline code.
import { useAuth } from "@openasy/auth/react";
import { Avatar, cn } from "@openasy/ui";
import { Bell, Bot, Hash, Lock, Rocket, Siren } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, MfaSetupRequired, Unauthorized, type Kind, type Presence, type Sender } from "./api.ts";
import { viewerLocale } from "./i18n.ts";

/** Data loading with the session; when it ends, the sign-in screen comes back. */
export function useApi() {
  const { expired, refresh } = useAuth();
  return useCallback(
    async <R,>(path: string, init?: RequestInit): Promise<R> => {
      try {
        return await api<R>(path, init);
      } catch (err) {
        if (err instanceof Unauthorized) expired();
        if (err instanceof MfaSetupRequired) void refresh();
        throw err;
      }
    },
    [expired, refresh],
  );
}
export type Call = ReturnType<typeof useApi>;

/** Loads a path when it changes; `reload` loads it again. undefined while loading, null when it failed. */
export function useLoad<R>(call: Call, path: string | null) {
  const [data, setData] = useState<R | null>();
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    void call<R>(path).then(
      (d) => live && setData(d),
      () => live && setData(null),
    );
    return () => {
      live = false;
    };
  }, [call, path, n]);
  return [data, () => setN((x) => x + 1)] as const;
}

export const post = (body?: unknown): RequestInit => ({ method: "POST", ...(body !== undefined && { body: JSON.stringify(body) }) });
export const patch = (body: unknown): RequestInit => ({ method: "PATCH", body: JSON.stringify(body) });
export const enc = encodeURIComponent;

/** A status line after something was done, read out by screen readers. */
export function Notice({ children, tone = "success" }: { children: ReactNode; tone?: "success" | "danger" }) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cn("rounded-md px-3 py-2 text-sm text-fg", tone === "danger" ? "bg-danger-soft" : "bg-success-soft")}
    >
      {children}
    </div>
  );
}

export type Note = { text: string; tone?: "danger" } | null;

export function Code({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <pre aria-label={label} className="chat-code m-0 overflow-x-auto rounded-md bg-canvas px-2.5 py-2 font-mono text-2xs leading-relaxed text-fg">
      {children}
    </pre>
  );
}

// ---------------------------------------------------------------- formatting, in the viewer's language

export const time = (iso: string, locale: string = viewerLocale()) => new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** "Today, Wednesday 4 November", "Yesterday" or "Monday 2 November", as the separators in a channel read. */
export function dayLabel(iso: string, words: { today: string; yesterday: string }, locale: string = viewerLocale(), now = new Date()) {
  const d = new Date(iso);
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  const full = d.toLocaleDateString(locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
    ...(d.getFullYear() !== now.getFullYear() && { year: "numeric" }),
  });
  if (days === 0) return `${words.today}, ${full}`;
  if (days === 1) return words.yesterday;
  return full;
}

/** When, short: "14:02" today, "21 Oct" this year, "21 Oct 2025" before. */
export function when(iso: string, locale: string = viewerLocale(), now = new Date()) {
  const d = new Date(iso);
  if (startOfDay(d) === startOfDay(now)) return time(iso, locale);
  return d.toLocaleDateString(locale, { day: "numeric", month: "short", ...(d.getFullYear() !== now.getFullYear() && { year: "numeric" }) });
}

export const longDay = (iso: string, locale: string = viewerLocale()) =>
  new Date(iso).toLocaleDateString(locale, { day: "numeric", month: "long", year: "numeric" });

export const num = (n: number, locale: string = viewerLocale()) => new Intl.NumberFormat(locale).format(n);

export function bytes(n: number, locale: string = viewerLocale()) {
  const f = (v: number, d: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: d }).format(v);
  if (n >= 1024 ** 3) return `${f(n / 1024 ** 3, 1)} GB`;
  if (n >= 1024 ** 2) return `${f(n / 1024 ** 2, 1)} MB`;
  return `${f(Math.max(1, Math.round(n / 1024)), 0)} KB`;
}

/** The time where someone is, from the time zone their Matrix profile shares. */
export function localTime(timeZone: string | null, locale: string = viewerLocale(), now = new Date()): string | null {
  if (!timeZone) return null;
  try {
    return now.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", timeZone });
  } catch {
    return null;
  }
}
export const tzPlace = (timeZone: string) => (timeZone.split("/").pop() ?? timeZone).replace(/_/g, " ");

/** The extension a file's name ends in, as its kind: PDF, PNG. */
export const fileKind = (name: string) => (name.includes(".") ? name.split(".").pop()!.toUpperCase() : "FILE");

// ---------------------------------------------------------------- pieces

const APP_ICON: Record<string, typeof Bell> = { alerts: Bell, incidents: Siren, deploys: Rocket };

export const PRESENCE_DOT: Record<Presence, string> = {
  online: "bg-success",
  away: "bg-warning",
  busy: "bg-danger",
  offline: "border-2 border-fg-subtle bg-surface",
};

export function PresenceDot({ presence, className }: { presence: Presence; className?: string }) {
  return <span aria-hidden className={cn("absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-surface", PRESENCE_DOT[presence], className)} />;
}

/** A person's picture, or an app's icon: apps post through webhooks and show as apps, not people. */
export function Who({ sender, size = "md" }: { sender: Pick<Sender, "name" | "app">; size?: "sm" | "md" }) {
  if (sender.app) {
    const Icon = APP_ICON[sender.app.toLowerCase()] ?? Bot;
    return (
      <span
        role="img"
        aria-label={sender.app}
        className={cn("grid shrink-0 place-items-center rounded-md bg-subtle text-fg-muted", size === "sm" ? "size-6" : "size-8")}
      >
        <Icon className="size-4" />
      </span>
    );
  }
  return (
    <span className="relative shrink-0">
      <Avatar name={sender.name} size={size} className={size === "md" ? "size-8" : undefined} />
    </span>
  );
}

export function KindIcon({ kind, className }: { kind: Kind; className?: string }) {
  const Icon = kind === "private" ? Lock : kind === "incident" ? Siren : Hash;
  return <Icon aria-hidden className={cn("size-3.5 shrink-0", className)} />;
}

/** Mentions (@Jane Doe, @here), channel links (#ops-oncall) and inline code in a message. A mention of you stands out. */
const RICH = /(@(?:here|room|channel|\p{Lu}[\p{L}'-]*(?: \p{Lu}[\p{L}'-]*)?)|#[a-z0-9][a-z0-9._-]*|`[^`]+`)/gu;

export function Rich({ text, me, query, channels }: { text: string; me: string; query?: string; channels?: Map<string, string> }) {
  return (
    <>
      {text.split(RICH).map((part, i) => {
        if (i % 2 === 0) return <Highlight key={i} text={part} query={query} />;
        if (part.startsWith("`")) {
          return (
            <code key={i} className="rounded bg-subtle px-1 font-mono text-xs text-fg">
              {part.slice(1, -1)}
            </code>
          );
        }
        if (part.startsWith("#")) {
          const id = channels?.get(part.slice(1));
          return id ? (
            <a key={i} href={`/messages/${enc(id)}`} className="font-medium text-accent-text no-underline">
              {part}
            </a>
          ) : (
            <span key={i} className="font-medium text-accent-text">
              {part}
            </span>
          );
        }
        const mine = part === `@${me}` || part === "@here" || part === "@room" || part === "@channel";
        return (
          <span key={i} className={cn("rounded px-0.5 font-medium", mine ? "bg-warning-soft text-warning-text" : "bg-accent-soft text-accent-text")}>
            {part}
          </span>
        );
      })}
    </>
  );
}

export function Highlight({ text, query }: { text: string; query?: string }) {
  const words = (query ?? "")
    .split(/\s+/)
    .filter((w) => w && !w.includes(":"))
    .map((w) => w.replace(/"/g, ""))
    .filter(Boolean);
  if (!words.length) return <>{text}</>;
  const parts = text.split(new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "ig"));
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded bg-warning-soft px-0.5 text-fg">
            {p}
          </mark>
        ) : (
          p
        ),
      )}
    </>
  );
}
