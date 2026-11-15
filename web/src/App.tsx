import {
  AppShell,
  BrandProvider,
  Button,
  Callout,
  EmptyState,
  navigate,
  PageHeader,
  PRODUCT_IDS,
  toLocale,
  usePath,
  useLocalePreference,
  useThemePreference,
  type ProductId,
} from "@openasy/ui";
import { AccountSettings, AuthGate, MembersSettings, SignInSettings, TokensSettings, useAccountMenu, useAuth, useInstallBrand } from "@openasy/auth/react";
import colophon from "virtual:openasy-colophon";
import { Hash, KeyRound, LogIn, LogOut, MessagesSquare, Plug, Search as SearchIcon, Settings as SettingsIcon, UserRound, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Me, ProductLink, SearchResults, Summary } from "./api.ts";
import { ChannelsPage } from "./channels.tsx";
import { enc, useApi, type Call } from "./common.tsx";
import { setViewerLocale, useT } from "./i18n.ts";
import { MessagesPage } from "./messages.tsx";
import { IntegrationsPage, SettingsFilePage } from "./pages.tsx";
import { PeoplePage } from "./people.tsx";
import { SearchPage } from "./search.tsx";
import { WelcomePage } from "./welcome.tsx";

const PAGES = ["messages", "search", "people", "channels", "integrations", "settings", "account", "members", "signin", "tokens", "welcome"] as const;
type Page = (typeof PAGES)[number];
/** The first path segments that are pages of this UI, for followLinks. */
export const PATHS = [...PAGES];
/** Pages for viewers and above: the channels' rules, the file and the integrations. */
const VIEWERS: readonly Page[] = ["channels", "integrations", "settings"];

function parseRoute(path: string): { page: Page; id: string | null } {
  const [page, id] = path.replace(/^\//, "").split("/");
  if ((PAGES as readonly string[]).includes(page ?? "")) return { page: page as Page, id: id ? decodeURIComponent(id) : null };
  return { page: "messages", id: null };
}

export interface Ctx {
  call: Call;
  me: Me;
  /** Admins set the rules of channels people made, export for legal requests and make webhook addresses. */
  admin: boolean;
  /** Meet's address in this install, for calls from a channel; null without Meet. */
  meetUrl: string | null;
}

/** Account, Members, Sign-in and API tokens: the screens come from @openasy/auth. */
function AuthSettingsPage({ page }: { page: "account" | "members" | "signin" | "tokens" }) {
  const t = useT();
  const { signOut, can } = useAuth();
  if (page !== "account" && !can("admin")) return <EmptyState title={t("auth.adminsOnly")}>{t("auth.askAnAdmin")}</EmptyState>;
  return (
    <>
      <PageHeader
        title={t(`auth.${page}`)}
        description={t(`auth.${page}Detail`)}
        actions={
          page === "account" && (
            <Button icon={<LogOut />} onClick={() => void signOut()}>
              {t("auth.signOut")}
            </Button>
          )
        }
      />
      {page === "account" ? <AccountSettings /> : page === "members" ? <MembersSettings /> : page === "signin" ? <SignInSettings /> : <TokensSettings />}
    </>
  );
}

function Product() {
  const t = useT();
  const [theme, setTheme] = useThemePreference();
  const [, setLocale] = useLocalePreference();
  const { me: auth, can } = useAuth();
  const account = useAccountMenu();
  const route = parseRoute(usePath());
  const [me, setMe] = useState<Me>();
  const [failed, setFailed] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary>();
  const [products, setProducts] = useState<Array<ProductLink & { id: ProductId }>>([]);
  const call = useApi();
  const viewer = can("viewer");

  useEffect(() => {
    void call<{ products: ProductLink[] }>("/api/v1/products").then(
      (r) => setProducts(r.products.filter((p): p is ProductLink & { id: ProductId } => p.id !== "chat" && (PRODUCT_IDS as readonly string[]).includes(p.id))),
      () => {},
    );
    void call<Me>("/api/v1/me").then(setMe, (err: Error) => setFailed(err.message));
    if (viewer) void call<Summary>("/api/v1/summary").then(setSummary, () => {});
  }, [call, viewer]);

  // The search window (Cmd+K) finds messages the person may see.
  const onSearch = useMemo(
    () => async (q: string, signal: AbortSignal) => {
      const r = await call<SearchResults>(`/api/v1/search?${new URLSearchParams({ q })}`, { signal });
      return r.messages.slice(0, 8).map((m) => ({
        id: m.id,
        label: m.text || m.file?.name || "",
        detail: `${m.sender.name}, ${m.room.kind === "dm" ? m.room.name : `#${m.room.name}`}`,
        kind: t("search.message"),
        icon: MessagesSquare,
        href: `/messages/${enc(m.room.id)}`,
      }));
    },
    [call, t],
  );

  const nav = [
    { id: "messages", label: t("nav.messages"), icon: MessagesSquare },
    { id: "search", label: t("nav.search"), icon: SearchIcon },
    { id: "people", label: t("nav.people"), icon: Users },
    ...(viewer ? [{ id: "channels", label: t("nav.channels"), icon: Hash }] : []),
  ];
  const footerNav = [
    ...(viewer
      ? [
          { id: "integrations", label: t("nav.integrations"), icon: Plug },
          { id: "settings", label: t("nav.settings"), icon: SettingsIcon },
        ]
      : []),
    ...(can("admin")
      ? [
          { id: "members", label: t("nav.members"), icon: Users },
          { id: "signin", label: t("nav.signIn"), icon: LogIn },
          { id: "tokens", label: t("nav.apiTokens"), icon: KeyRound },
        ]
      : []),
    { id: "account", label: t("nav.account"), icon: UserRound },
  ];
  const roleName = t(`roles.${(["owner", "admin", "editor", "viewer", "user"].includes(auth.user.role) ? auth.user.role : "user") as "user"}`);
  const ctx: Ctx | null = me ? { call, me, admin: can("admin"), meetUrl: products.find((p) => p.id === "meet")?.url ?? null } : null;
  const viewersOnly = VIEWERS.includes(route.page) && !viewer;
  const page = route.page;

  return (
    <AppShell
      product="chat"
      onSearch={onSearch}
      about={colophon}
      nav={nav}
      activeNav={page}
      onNavigate={(id) => navigate(`/${id}`)}
      connectedProducts={products.map((p) => p.id)}
      onSwitchProduct={(id) => {
        const to = products.find((p) => p.id === id);
        if (to) window.location.assign(to.url);
      }}
      footerNav={account.settings(footerNav)}
      user={{ name: auth.user.name, role: roleName, ...account.user }}
      theme={theme}
      onThemeChange={setTheme}
      onLanguageChange={(code) => setLocale(toLocale(code))}
    >
      {summary?.file?.error && page !== "settings" && (
        <Callout tone="danger" title={t("file.notApplied")} className="mb-2.5">
          {summary.file.error}
        </Callout>
      )}
      {page === "account" || page === "members" || page === "signin" || page === "tokens" ? (
        <AuthSettingsPage page={page} />
      ) : viewersOnly ? (
        <EmptyState title={t("auth.viewersOnly")}>{t("auth.viewersOnlyDetail")}</EmptyState>
      ) : !ctx ? (
        failed ? (
          <EmptyState title={t("matrixDown")}>{failed}</EmptyState>
        ) : (
          <PageHeader title={t("loading")} />
        )
      ) : page === "search" ? (
        <SearchPage ctx={ctx} />
      ) : page === "people" ? (
        <PeoplePage ctx={ctx} />
      ) : page === "channels" ? (
        <ChannelsPage ctx={ctx} />
      ) : page === "integrations" ? (
        <IntegrationsPage ctx={ctx} />
      ) : page === "settings" ? (
        <SettingsFilePage ctx={ctx} />
      ) : (
        <MessagesPage ctx={ctx} roomId={route.id} />
      )}
    </AppShell>
  );
}

export function App() {
  const installBrand = useInstallBrand();
  const [theme] = useThemePreference();
  const [locale] = useLocalePreference();
  setViewerLocale(locale);
  const route = parseRoute(usePath());
  return (
    // The install's brand from config/brand.env (ADR 0053); OpenAsy's own look where it sets none.
    <BrandProvider theme={theme} locale={locale} brand={{ name: "OpenAsy", organization: undefined, ...installBrand }} className="min-h-screen">
      {route.page === "welcome" && route.id ? (
        <WelcomePage token={route.id} />
      ) : (
        <AuthGate product="OpenAsy Chat">
          <Product />
        </AuthGate>
      )}
    </BrandProvider>
  );
}
