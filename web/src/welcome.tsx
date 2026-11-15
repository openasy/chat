// A guest's welcome link: they choose the password they sign in to Element with. Guests have no account in Chat's
// pages; they use Element, on the web, desktop or phone, against the company's Matrix server.
import { Button, Callout, EmptyState, Panel, TextField } from "@openasy/ui";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api.ts";
import { Code, longDay } from "./common.tsx";
import { useT } from "./i18n.ts";

export function WelcomePage({ token }: { token: string }) {
  const t = useT();
  const [info, setInfo] = useState<{ name: string; channel: string; userId: string; endsAt: string; homeserver: string } | null>();
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api<NonNullable<typeof info>>(`/api/v1/welcome/${encodeURIComponent(token)}`).then(setInfo, () => setInfo(null));
  }, [token]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password !== again) return setError(t("welcome.mismatch"));
    try {
      await api(`/api/v1/welcome/${encodeURIComponent(token)}`, { method: "POST", body: JSON.stringify({ password }) });
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  if (info === undefined) return <p className="p-6 text-sm text-fg-muted">{t("loading")}</p>;
  if (info === null) return <EmptyState title={t("welcome.gone")}>{t("welcome.goneDetail")}</EmptyState>;
  return (
    <main className="chat-welcome mx-auto flex flex-col gap-3 p-6">
      <h1 className="text-xl font-semibold text-fg">{t("welcome.title", { name: info.name })}</h1>
      <p className="text-sm text-fg">{t("welcome.detail", { channel: `#${info.channel}`, date: longDay(info.endsAt) })}</p>
      {done ? (
        <Panel title={t("welcome.next")}>
          <ol className="flex list-decimal flex-col gap-1 pl-4 text-sm text-fg">
            <li>{t("welcome.step1")}</li>
            <li>{t("welcome.step2")}</li>
            <li>{t("welcome.step3")}</li>
          </ol>
          <Code label={t("welcome.account")}>{`${t("welcome.homeserver")}: ${info.homeserver}
${t("welcome.user")}: ${info.userId}`}</Code>
        </Panel>
      ) : (
        <Panel title={t("welcome.choose")}>
          <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-2">
            <TextField
              label={t("welcome.password")}
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <TextField label={t("welcome.again")} type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
            {error && (
              <Callout tone="danger" title={t("welcome.notSet")}>
                {error}
              </Callout>
            )}
            <Button type="submit" variant="primary" className="self-start" disabled={password.length < 12}>
              {t("welcome.set")}
            </Button>
          </form>
        </Panel>
      )}
    </main>
  );
}
