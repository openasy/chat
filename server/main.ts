import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { createAuth, oidcFromEnv, readSecretsKey } from "@openasy/auth";
import { createApp, createMetricsHandler } from "./app.ts";
import { createChat } from "./chat.ts";
import { watchConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { identityDirectory } from "./identity.ts";
import { log } from "./log.ts";
import { createMatrix } from "./matrix.ts";
import { parseProducts } from "./products.ts";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const env = process.env;
const port = Number(env.PORT ?? 8080);
const dbPath = env.CHAT_DB ?? "/data/chat.db";
const configPath = env.CHAT_CONFIG?.trim() || "/config/chat.yaml";
const webDir = new URL("../dist/web", import.meta.url).pathname;
const docsDir = new URL("../dist/docs", import.meta.url).pathname;
const openapi = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Record<string, unknown>;
const headless = env.CHAT_HEADLESS === "true";
// Set it to keep /metrics off the port that is published or behind an ingress (ADR 0026).
const metricsPort = env.CHAT_METRICS_PORT ? Number(env.CHAT_METRICS_PORT) : undefined;

// The address people open Chat at, behind the TLS proxy (ADR 0026). Cookies, passkeys, OIDC redirects, guests' welcome
// links and the apps' webhook addresses use it.
const publicUrl = (env.CHAT_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
// Where Element and other Matrix apps reach Synapse: its public https address.
const homeserverUrl = (env.CHAT_HOMESERVER_URL?.trim() || "https://matrix.example.com").replace(/\/$/, "");
const synapseUrl = env.CHAT_SYNAPSE_URL?.trim() || "http://synapse:8008";
const serviceUser = env.CHAT_SYNAPSE_USER?.trim() || "openasy-chat";
const secretFile = env.CHAT_SYNAPSE_SECRET_FILE ?? "/run/secrets/synapse-registration-secret";
const sharedSecret = env.CHAT_SYNAPSE_SECRET ?? (existsSync(secretFile) ? readFileSync(secretFile, "utf8").trim() : "");
if (!sharedSecret)
  log("warn", "Synapse's registration shared secret is missing: Chat cannot make its service account. Mount it or set CHAT_SYNAPSE_SECRET", {
    file: secretFile,
  });
const identityUrl = env.CHAT_IDENTITY_URL?.trim();
const identityTokenFile = env.CHAT_IDENTITY_TOKEN_FILE ?? "/run/secrets/identity-token";
const identityToken = env.CHAT_IDENTITY_TOKEN ?? (existsSync(identityTokenFile) ? readFileSync(identityTokenFile, "utf8").trim() : "");
if (identityUrl && !identityToken)
  log("warn", "CHAT_IDENTITY_URL is set without an API token; the directory comes from the Matrix server", { file: identityTokenFile });

const db = openDb(dbPath);
const secretsKeyFile = env.CHAT_SECRETS_KEY_FILE ?? "/run/secrets/openasy-kek";
const auth = createAuth({
  db,
  product: "chat",
  productName: "OpenAsy Chat",
  origin: publicUrl,
  // Locally the same Chat is often opened as 127.0.0.1 too.
  trustedOrigins: publicUrl.startsWith("http://localhost:") ? [publicUrl.replace("localhost", "127.0.0.1")] : [],
  passwords: env.CHAT_PASSWORD_SIGN_IN !== "false",
  // Everyone in the company signs in to talk; only some of them manage Chat.
  users: true,
  oidc: oidcFromEnv(env, "CHAT_"),
  secretsKey: readSecretsKey(secretsKeyFile),
  // Audit log (ADR 0013): every sign-in, failure and change to members and tokens.
  onEvent: (event) => log(event.type === "sign-in-failed" ? "warn" : "info", "auth", { event }),
});
const matrix = createMatrix({ url: synapseUrl });
let file: ReturnType<typeof watchConfig> | undefined;
const chat = createChat(db, matrix, {
  publicUrl,
  homeserverUrl,
  directory: identityUrl && identityToken ? identityDirectory({ url: identityUrl, token: identityToken }) : undefined,
  organization: env.OPENASY_ORGANIZATION?.trim() || "Company",
  dataDir: dbPath === ":memory:" ? "/tmp" : dirname(dbPath),
  fileState: () => file?.state ?? null,
});

/** Signs in to Synapse as the service account, made with the shared secret the first time; tried again until it works. */
let connected = false;
async function connect() {
  if (connected || !sharedSecret) return;
  try {
    const user = await matrix.signInService(sharedSecret, serviceUser);
    connected = true;
    log("info", "connected to the Matrix server", { synapse: synapseUrl, user });
    await chat.syncNow();
  } catch (err) {
    log("warn", "the Matrix server did not take Chat's service account yet; trying again in 30 seconds", {
      synapse: synapseUrl,
      error: (err as Error).message,
    });
  }
}

// The channels and apps come from the file and only from it; a file with a mistake keeps the last good one in place.
file = watchConfig(configPath, (config) => (connected ? void chat.setConfig(config) : chat.useConfig(config)), {
  onChange: (state) =>
    state.error
      ? log("warn", "chat file not applied: the last good version stays until it is fixed", { file: state.path, error: state.error })
      : log("info", "chat file applied", { file: state.path, channels: state.channels, apps: state.apps }),
});
const products = parseProducts(env.OPENASY_PRODUCTS);
if (products.invalid.length) log("warn", "OPENASY_PRODUCTS: left out entries that are not id=https://address", { entries: products.invalid });
const server = createServer(
  createApp({
    db,
    chat,
    version,
    auth,
    webDir: !headless && existsSync(webDir) ? webDir : undefined,
    docsDir: existsSync(docsDir) ? docsDir : undefined,
    openapi,
    serveMetrics: metricsPort === undefined,
    products: products.products,
  }),
);
const metricsServer = metricsPort !== undefined ? createServer(createMetricsHandler(chat, version)) : undefined;
metricsServer?.listen(metricsPort, () => log("info", "metrics on their own port", { port: metricsPort }));

server.listen(port, () =>
  log("info", "chat started", { version, port, db: dbPath, config: configPath, synapse: synapseUrl, homeserver: homeserverUrl, headless }),
);
if (!publicUrl.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(publicUrl)) {
  log("warn", "CHAT_PUBLIC_URL is not https: browsers will not keep secure cookies or allow passkeys. Put Chat behind TLS (ADR 0026)", {
    url: publicUrl,
  });
}
if (auth.secretsInClear)
  log("warn", "no secrets key: TOTP secrets are stored unencrypted. Mount a 32-byte key (openssl rand -hex 32)", { file: secretsKeyFile });
const setup = auth.setupLink();
// No default password (ADR 0013): the first person to open this link becomes the owner.
if (setup) log("info", "no owner yet: open this link once to create the owner account", { url: setup });
void connect();

const timers: NodeJS.Timeout[] = [
  setInterval(() => auth.purge(), 5 * 60_000),
  setInterval(() => void connect(), 30_000),
  // Changes made on the server by hand are put back, leavers and guests whose access ended are taken out, and a sync
  // that failed is tried again.
  setInterval(() => void (connected && chat.syncNow()), 5 * 60_000),
];

function shutdown(signal: string) {
  log("info", "shutting down", { signal });
  for (const t of timers) clearInterval(t);
  file?.stop();
  metricsServer?.close();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
