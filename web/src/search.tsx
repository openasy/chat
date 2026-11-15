// Search: every message and file the person may see, narrowed by channel, sender and date. Matrix searches the text of
// messages and the names of files; channels open to the company are searched even when the person has not joined.
import { Badge, DataTable, EmptyState, PageHeader, Panel, SearchInput, SelectField, Tabs, useLocalePreference, type Column } from "@openasy/ui";
import { FileText, MessageSquare, Search as SearchIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { Ctx } from "./App.tsx";
import type { Conversation, Person, SearchResults } from "./api.ts";
import { bytes, enc, KindIcon, Highlight, Rich, when, Who } from "./common.tsx";
import { useT } from "./i18n.ts";

type FileHit = SearchResults["files"][number];

export function SearchPage({ ctx }: { ctx: Ctx }) {
  const t = useT();
  const [locale] = useLocalePreference();
  const [query, setQuery] = useState(() => new URLSearchParams(window.location.search).get("q") ?? "");
  const [where, setWhere] = useState("");
  const [from, setFrom] = useState("");
  const [period, setPeriod] = useState("any");
  const [tab, setTab] = useState<"messages" | "files">("messages");
  const [results, setResults] = useState<SearchResults | null>(null);
  const [busy, setBusy] = useState(false);
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [people, setPeople] = useState<Person[]>([]);

  useEffect(() => {
    void ctx.call<{ conversations: Conversation[] }>("/api/v1/conversations").then(
      (r) => setConvs(r.conversations.filter((c) => !c.invited)),
      () => {},
    );
    void ctx.call<{ people: Person[] }>("/api/v1/people").then(
      (r) => setPeople(r.people),
      () => {},
    );
  }, [ctx]);

  useEffect(() => {
    if (!query.trim()) {
      setResults(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      setBusy(true);
      const days = period === "any" ? null : period === "today" ? "1" : period;
      const params = new URLSearchParams({ q: query, ...(where && { in: where }), ...(from && { from }), ...(days && { days }) });
      void ctx
        .call<SearchResults>(`/api/v1/search?${params}`)
        .then(
          (r) => {
            if (!live) return;
            const today = new Date().toDateString();
            const keep = <X extends { ts: string }>(x: X) => period !== "today" || new Date(x.ts).toDateString() === today;
            setResults({ ...r, messages: r.messages.filter(keep), files: r.files.filter(keep) });
          },
          () => live && setResults({ messages: [], files: [], count: 0 }),
        )
        .finally(() => live && setBusy(false));
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [ctx, query, where, from, period]);

  const hits = results?.messages ?? [];
  const files = results?.files ?? [];
  const channels = new Map(convs.filter((c) => c.kind !== "dm").map((c) => [c.name, c.id]));
  const fileCols: Column<FileHit>[] = [
    {
      id: "name",
      header: t("search.file"),
      width: "38%",
      sortValue: (f) => f.file.name,
      cell: (f) => (
        <a
          href={`/api/v1/files/${f.file.uri.slice(6).split("/").map(enc).join("/")}?name=${enc(f.file.name)}`}
          className="flex min-w-0 items-center gap-2 no-underline"
        >
          <FileText aria-hidden className="size-4 shrink-0 text-fg-muted" />
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-medium text-fg">
              <Highlight text={f.file.name} query={query} />
            </span>
            {f.file.size !== null && <span className="text-2xs text-fg-muted">{bytes(f.file.size, locale)}</span>}
          </span>
        </a>
      ),
    },
    {
      id: "channel",
      header: t("search.sharedIn"),
      cell: (f) => <span className="truncate text-xs">{f.room.kind === "dm" ? f.room.name : `#${f.room.name}`}</span>,
    },
    { id: "by", header: t("search.by"), cell: (f) => <span className="truncate text-xs">{f.sender.name}</span> },
    { id: "when", header: t("search.when"), sortValue: (f) => f.ts, cell: (f) => <span className="text-xs text-fg-muted">{when(f.ts, locale)}</span> },
  ];

  return (
    <>
      <PageHeader title={t("search.title")} description={t("search.description")} />
      <div className="chat-side grid gap-2.5">
        <Panel flush>
          <div className="flex flex-col gap-2 px-3 pt-3">
            <SearchInput label={t("search.label")} value={query} onChange={(e) => setQuery(e.target.value)} shortcut="/" />
            <div className="chat-thirds grid gap-2">
              <SelectField
                label={t("search.in")}
                value={where}
                onChange={(e) => setWhere(e.target.value)}
                options={[{ value: "", label: t("search.anywhere") }, ...convs.map((c) => ({ value: c.id, label: c.kind === "dm" ? c.name : `#${c.name}` }))]}
              />
              <SelectField
                label={t("search.from")}
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                options={[{ value: "", label: t("search.anyone") }, ...people.map((p) => ({ value: p.userId, label: p.name }))]}
              />
              <SelectField
                label={t("search.when")}
                value={period}
                onChange={(e) => setPeriod(e.target.value)}
                options={[
                  { value: "any", label: t("search.anyTime") },
                  { value: "today", label: t("search.today") },
                  { value: "7", label: t("search.last7") },
                  { value: "30", label: t("search.last30") },
                ]}
              />
            </div>
            <Tabs
              label={t("search.results")}
              value={tab}
              onChange={setTab}
              items={[
                { value: "messages", label: t("search.messages"), count: hits.length },
                { value: "files", label: t("search.files"), count: files.length },
              ]}
              className="border-b-0"
            />
          </div>
          <div className="border-t border-line" aria-busy={busy}>
            {!query.trim() ? (
              <EmptyState icon={<SearchIcon />} title={t("search.start")}>
                {t("search.startDetail")}
              </EmptyState>
            ) : tab === "messages" ? (
              hits.length ? (
                <ol aria-label={t("search.resultsList")} className="chat-list flex flex-col">
                  {hits.map((h) => (
                    <li key={h.id} className="flex gap-2.5 border-b border-subtle px-3 py-2.5 last:border-0 hover:bg-canvas">
                      <Who sender={h.sender} />
                      <div className="flex min-w-0 grow flex-col gap-0.5">
                        <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
                          <span className="text-sm font-semibold text-fg">{h.sender.name}</span>
                          <span className="text-fg-subtle">{t("search.inWord")}</span>
                          <a href={`/messages/${enc(h.room.id)}`} className="flex items-center gap-1 font-medium text-accent-text no-underline">
                            {h.room.kind === "dm" ? <MessageSquare aria-hidden className="size-3" /> : <KindIcon kind={h.room.kind} className="size-3" />}
                            {h.room.kind === "dm" ? t("search.dmWith", { name: h.room.name }) : h.room.name}
                          </a>
                          {h.threadRoot && <Badge>{t("search.inThread")}</Badge>}
                          <span className="ms-auto text-2xs text-fg-subtle">{when(h.ts, locale)}</span>
                        </span>
                        <p className="chat-text text-sm text-fg">
                          {h.file && !h.text ? (
                            <Highlight text={h.file.name} query={query} />
                          ) : (
                            <Rich text={h.text} me={ctx.me.name} query={query} channels={channels} />
                          )}
                        </p>
                      </div>
                    </li>
                  ))}
                </ol>
              ) : (
                <EmptyState icon={<SearchIcon />} title={busy ? t("loading") : t("search.none")}>
                  {busy ? "" : t("search.noneDetail")}
                </EmptyState>
              )
            ) : (
              <DataTable label={t("search.files")} columns={fileCols} rows={files} getRowId={(f) => f.id} minWidth={560} />
            )}
          </div>
        </Panel>
        <div className="flex flex-col gap-2.5">
          <Panel title={t("search.narrow")} description={t("search.narrowDetail")}>
            <dl className="chat-tips grid gap-x-2 gap-y-1.5 text-xs">
              {[
                ["from:ben", t("search.tipFrom")],
                ["in:#deploys", t("search.tipIn")],
                ["has:file", t("search.tipFile")],
                ["before:2026-11-01", t("search.tipBefore")],
                ['"cache warm-up"', t("search.tipPhrase")],
              ].map(([k, v]) => (
                <div key={k} className="contents">
                  <dt>
                    <code className="rounded bg-subtle px-1 font-mono text-fg">{k}</code>
                  </dt>
                  <dd className="m-0 text-fg-muted">{v}</dd>
                </div>
              ))}
            </dl>
          </Panel>
          <Panel title={t("search.covers")}>
            <ul className="flex list-disc flex-col gap-1 pl-4 text-xs text-fg">
              <li>{t("search.covers1")}</li>
              <li>{t("search.covers2")}</li>
              <li>{t("search.covers3")}</li>
              <li>{t("search.covers4")}</li>
            </ul>
          </Panel>
        </div>
      </div>
    </>
  );
}
