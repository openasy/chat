# chat

[![CI](https://github.com/openasy/chat/actions/workflows/ci.yml/badge.svg)](https://github.com/openasy/chat/actions/workflows/ci.yml)
[![Node.js 26 LTS](https://img.shields.io/badge/node-26%20LTS-339933?logo=nodedotjs&logoColor=white)](./.nvmrc)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](./LICENSE)

The [OpenAsy](https://github.com/openasy) Chat product: team messaging on your company's own server. Channels set in
a file and channels people make, private channels and direct messages, threads, mentions, reactions, files, search,
guests from other companies, retention per channel, legal holds and exports, and apps that post into channels, on
[Synapse](https://github.com/element-hq/synapse), the open-source [Matrix](https://matrix.org) server. Synapse stores
every message and file and serves them to Element on phones and computers, so people can use Chat's pages in the
browser and Element everywhere else, on the same messages.

```
chat.yaml ──▶ chat ── admin API ──────────────▶ Synapse ◀── Matrix client API ── Element (phone, desktop, web)
  Identity ──▶  │  ▲                               ▲    ▲
     the pages ─┘  └── client API, as the person ──┘    └── PostgreSQL
  apps' webhooks ──▶ chat ── client API, as the app ──▶ Synapse
```

Chat keeps no messages. It talks to Synapse over two documented APIs: the admin API with its own admin account, to
keep the server in step with the file and the directory, and the Matrix client-server API as the signed-in person,
with a token Synapse's admin login gives for them, for their conversations. People never give Chat a password, and
everything a person does in the pages is done on the server as them, with their rights: a private channel they are
not in stays closed to them in the pages as it does in Element.

Chat uses only what Synapse's open-source release offers (tested against 1.165): the admin API (users, rooms, joins,
deactivation, room messages, statistics), restricted joins (room version 10), room retention (`m.room.retention` and
Synapse's purge jobs), threads, reactions, edits and redactions, server-side search, presence, `m.tz` in profiles,
authenticated media and the room directory.

## What it does

- **Messages**: channels and direct messages with unread counts and mentions, threads (a reply can also go to the
  channel), reactions, files kept in Synapse's media store, mentions that Element notifies (`@Jane Doe`, `@here`),
  edits and deletions made in any Matrix app, and pinned messages. The pages follow the server's own sync, so a
  message sent from Element shows within a second.
- **Search**: messages and file names in the channels open to the company, even ones the person has not joined, and in
  the private channels and direct messages they are in; `from:`, `in:`, `has:file`, `before:`, `after:` and phrases.
- **People**: members and their groups from Identity, presence and status as set in Element, local time from the time
  zone they share, how many channels each is in, and who is leaving.
- **Guests**: a member of a channel that takes guests invites someone from outside, for a number of days. The guest
  gets a Matrix account in that channel only and a welcome link to choose a password, and signs in with Element. On
  the last day Chat deactivates the account.
- **Channels**: every channel with where its members come from, its retention, holds and guests. The file's channels
  show their entry; for channels people or products made, an admin sets retention, who posts and guests.
- **Legal requests**: an admin exports a channel and a date range, optionally from some people only, as a ZIP of every
  event (messages, edits, reactions, deletions) and file, with a manifest signed with Ed25519. A hold keeps every
  message of the channel past its retention until it is released. Both are written to the audit log.
- **Apps**: each app of the file posts into its channels through a secret webhook address, as its own account marked
  as a bot, with a text Element shows and a card the pages draw. Incidents opens a channel per incident with an API
  token. A call starts in Meet when Meet is in the install.
- **Leaving**: when Identity turns someone off, Chat deactivates their Matrix account: out of every room and signed
  out on every device, while what they wrote stays under each channel's retention.

## Channels

List them in the chat file, `/config/chat.yaml` (`CHAT_CONFIG`):

```yaml
defaults: { retention: 1y }
guests: { days: 90 }
channels:
  - { name: general, topic: Company-wide news, members: [group:everyone], retention: 2y }
  - { name: announcements, members: [group:everyone], posts: admins, admins: [ceo@example.com], retention: forever }
  - { name: leadership, private: true, members: [group:leadership] }
  - { name: northwind-shared, private: true, members: [chris@example.com], guests: true }
apps:
  - { name: Alerts, channels: [ops-oncall] }
```

The file is the only way in for what it lists: no screen and no API route changes a channel the file sets, so the
list can live in git and be reviewed like code. It is read at start and again within a minute of a change, and
applied whole or not at all. A file with a mistake leaves the last good version in place, and the log and the Settings
page say which entry and field to fix. Without a file, Chat runs with the channels people make.

| Field | | |
| --- | --- | --- |
| `defaults.retention` | `1y` | Retention of channels people and products make |
| `guests.days` | `90` | The longest a guest's access lasts |
| `channels[].name` | required | Its address, `#name:server`; lowercase letters, digits, `.`, `-`, `_` |
| `channels[].topic` | | |
| `channels[].private` | `false` | Only its members see it; otherwise anyone in the company may read and join it |
| `channels[].members` | joined by choice | `group:<name>` from Identity, `group:everyone`, or emails |
| `channels[].admins` | | Emails of its moderators |
| `channels[].retention` | `defaults.retention` | `30d`, `12w`, `6m`, `2y` or `forever` |
| `channels[].guests` | `false` | Its members may invite guests |
| `channels[].posts` | `everyone` | `admins`: only its admins post |
| `apps[].name`, `apps[].channels` | required | An app and the channels it posts to |

After every change, and every five minutes, Chat brings Synapse in step. Everyone in the directory has an account
named after their email (`jane@example.com` is `@jane:server`), is a member of the company space, and is put into
the channels their groups give them. Each channel is a room Chat made and marks with an `org.openasy.chat.channel`
state event; Chat sets its name, topic, join rule, power levels and retention, and touches no other room. A channel
open to the company may be joined only from the company space, so guests cannot join it. A private channel also loses
the people the file no longer gives it. A channel taken out of the file is not deleted: it is handed to its members.

## Run

`compose.yaml` runs Chat with Synapse and PostgreSQL. Edit `config/synapse/homeserver.yaml` first: the server name,
the public address, and Identity as the identity provider, so Element signs in through it. Synapse makes a person's
account at their first sign-in with their email's local part, the same account Chat made from the directory.

```bash
openssl rand -hex 32 > openasy-kek
printf '%s' "$(openssl rand -hex 32)" > synapse-registration-secret
printf '%s' "$(openssl rand -hex 24)" > synapse-postgres-password
printf 'database:\n  name: psycopg2\n  args: { user: synapse, password: "%s", database: synapse, host: postgres }\n' \
  "$(cat synapse-postgres-password)" > synapse-database.yaml
printf '%s' "<the client secret of Synapse in Identity>" > synapse-oidc-secret
$EDITOR config/synapse/homeserver.yaml config/chat.yaml
docker compose run --rm synapse generate-keys
docker compose up -d
docker compose logs chat | grep 'no owner yet'
```

Synapse reads no password from a file, so its database settings, with the password, are a second settings file it
reads after `homeserver.yaml`: `synapse-database.yaml`, kept beside the other secrets. At its first start Chat makes its own admin account on Synapse, `@openasy-chat:server`, with the registration shared
secret, and signs in to it at every start after; nothing else needs keeping. It also lifts Synapse's message rate limit
for that account, which would otherwise stop a company's first sync halfway. Open the link from the log once to
create the owner account; there is no default password (ADR 0013). Chat is on http://localhost:8080 in
`compose.yaml` and Synapse on 8008; put both behind TLS. Everyone in the company signs in to Chat with their identity
provider and `OPENASY_OIDC_DEFAULT_ROLE=user`, or is invited as a member with the user role.

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `CHAT_PUBLIC_URL` | `http://localhost:8080` | The address people open, with `https://` behind your TLS proxy; welcome links and webhook addresses use it |
| `CHAT_HOMESERVER_URL` | `https://matrix.example.com` | Where Element reaches Synapse: `public_baseurl` |
| `CHAT_CONFIG` | `/config/chat.yaml` | The chat file |
| `CHAT_SYNAPSE_URL` | `http://synapse:8008` | Where Chat reaches Synapse's client listener |
| `CHAT_SYNAPSE_USER` | `openasy-chat` | The local part of Chat's admin account |
| `CHAT_SYNAPSE_SECRET_FILE` | `/run/secrets/synapse-registration-secret` | Synapse's registration shared secret, or `CHAT_SYNAPSE_SECRET` |
| `CHAT_IDENTITY_URL` | | OpenAsy Identity, for names, groups and leavers |
| `CHAT_IDENTITY_TOKEN_FILE` | `/run/secrets/identity-token` | An Identity API token with the viewer role, or `CHAT_IDENTITY_TOKEN` |
| `OPENASY_ORGANIZATION` | `Company` | The company space's name |
| `OPENASY_PRODUCTS` | | The install's other OpenAsy products, for the product switcher and Meet |
| `CHAT_SECRETS_KEY_FILE` | `/run/secrets/openasy-kek` | 32-byte key-encryption key (ADR 0021) |
| `CHAT_DB` | `/data/chat.db` | SQLite file (WAL), on the `/data` volume, with export archives next to it |
| `CHAT_METRICS_PORT` | | Serve `/metrics` on this port only (ADR 0026) |
| `CHAT_HEADLESS` | `false` | `true` serves only the API |
| `CHAT_PASSWORD_SIGN_IN`, `OPENASY_OIDC_*` | | Sign-in, as in every OpenAsy product ([@openasy/auth](https://github.com/openasy/auth)) |

The container runs as non-root with a read-only root filesystem, no capabilities and `no-new-privileges`. Its database
holds sign-in, the history of syncs, guests, the hashes of webhook tokens and welcome links, holds, exports and the key
exports are signed with; the messages are in PostgreSQL and the files in Synapse's media store, which are the ones to
back up.

## Roles

Users talk: their conversations, search, people, their own channels and guests in their channels. Viewers also see
every channel's rules, the file and the integrations; admins also set the rules of channels people made, export for
legal requests, release holds, make webhook addresses, sync on request and manage members and API tokens (ADR 0003).
API tokens never read anyone's messages; a token with the editor role may open a channel, as Incidents does.

## Notes on Matrix

- End-to-end encryption is off by default for channels, so search, retention, exports and the pages can read them.
  People can still turn it on in direct messages in Element; the pages then say to read those in Element, and search
  and exports cannot see them. Chat's channels give only Chat the power to turn it on.
- Matrix has no "also send to the channel" for a thread reply; Chat sends a second message in the channel that
  replies to the thread's first message.
- Search covers message text and file names; Synapse does not read the text inside PDFs and documents.
- Synapse deletes what is past a retention in a daily purge job; it does not say beforehand how many messages that is.
- A legal hold keeps the whole channel, not only the export's dates: Matrix retention is per room.
- A guest can see the names of channels open to the company in Element's room directory, though they cannot join
  them, and can start a direct message with anyone they share a room with. Synapse has no per-user rule against that
  without a Python module, which Chat does not add.
- Guests sign in with a password in Element; Synapse has no email link or passkey sign-in.
- "Do not disturb" is a status starting with "Busy" or "DND": Matrix presence has online, away and offline only.

## Not yet

Federation with other companies' servers, editing and deleting messages in the pages (Element does both), pinning
from the pages, message counts before a retention change, and calls inside Chat (Meet starts them).

## Develop

```bash
npm install
npm test        # the file, the sync, messages, permissions, guests, holds, exports, webhooks, and every API response against openapi.json
npm run dev     # the UI, with the API on :8080
```

Tests run against a Matrix server in memory (`server/fake-synapse.ts`) that answers the admin and client-server calls
Chat makes, checking membership, join rules and power levels as Synapse does.

`npm run e2e` (`e2e/run.sh`, also in CI) starts the Synapse that `compose.yaml` pins, on SQLite, and runs Chat's
server against it: Chat's own admin account, the file applied, messages with a mention, a thread, reactions, an edit
made through the client API, search across channels, a direct conversation and a file, a guest who signs in with a
password and is taken out again, a webhook with a card, the people with presence and the channels, a legal export
with a hold, a private channel kept to its members and a leaver deactivated, each checked in Synapse itself.

## Licence

AGPL-3.0 (ADR 0008). Synapse is AGPL-3.0 too.
