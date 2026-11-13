# OpenClaw Command Center

A voice-first command center for an [OpenClaw](https://github.com/openclaw/openclaw) gateway. One screen shows
what your assistant is doing, what needs your OK and how the gateway is holding up, and you can talk to the
assistant out loud or type to it.

- **Talk to your agent.** Tap the orb (or hold Space for push-to-talk) to open a realtime voice call through
  the gateway's Talk. The voice model consults your OpenClaw agent for anything real, and you watch it happen:
  listening, thinking, checking OpenClaw, speaking. Or type into the same session.
- **Approve from anywhere.** Exec, plugin and system approvals from the gateway's queue, plus (optionally)
  approval requests your agent writes as markdown files. Every decision takes two taps.
- **See the whole gateway.** Health checks, event loop, channels, paired devices, agents, active sessions,
  automations and heartbeats, provider usage limits and today's tokens.
- **Know when something needs you.** A badge in the tab title, a toast, and an optional desktop notification
  when the tab is in the background.
- **Reports.** When the agent finishes delegated work later, its report shows up on screen.
- Optional calendar and inbox panels through the `gog` CLI. Light, dark and system themes. Works on a phone.

The browser never sees your gateway token. A small Node server holds the gateway connection and hands the
browser a trimmed, read-only snapshot. For a voice call it relays the browser's WebRTC offer to the gateway,
so the browser doesn't need to reach the gateway at all; the audio itself goes straight to the provider.

```
browser (Angular)  ──HTTPS──▶  command center server (Node)  ──WebSocket──▶  OpenClaw gateway
       │                         holds the token, trims state,                   │
       └──── WebRTC audio ───────────────────────────────────────────────▶  realtime voice provider
```

## Requirements

- An OpenClaw gateway and its operator token (tested with OpenClaw 2026.11).
- Node.js 22.18 or newer (the server runs its TypeScript directly; no build step for the server).
- For voice: a realtime Talk provider configured in OpenClaw, and HTTPS (browsers only allow the microphone
  on HTTPS or `localhost`).

## Quick start

```bash
git clone https://github.com/abu-b-sidq/openclaw-command-center.git
cd openclaw-command-center
npm ci
npm run build
npm start
```

Open http://127.0.0.1:18821/. On first start the server prints a generated sign-in password once; change it
any time with `npm run set-password`.

With no config file the server talks to `ws://127.0.0.1:18789`, reads the gateway token from
`~/.openclaw/openclaw.json` and sends your turns to the `agent:main:main` session. To point it somewhere
else, copy `config.example.json` to `config.json` and edit it, or use environment variables:

```bash
OPENCLAW_GATEWAY_TOKEN=... CC_SESSION_KEY=agent:ops:main npm start
```

Try it without touching anything: `CC_DRY_RUN=true npm start` shows live state but records decisions and
messages instead of sending them.

## Configuration

Settings load in this order: built-in defaults, then a JSON file (`--config <file>`, `CC_CONFIG`, or
`./config.json`), then environment variables. Unknown keys are an error, so typos don't pass silently.
`config.example.json` lists every key with a short explanation.

| Key                           | Default                          | What it does                                                           |
| ----------------------------- | -------------------------------- | ---------------------------------------------------------------------- |
| `server.host`, `server.port`  | `127.0.0.1`, `18821`             | Where the server listens. Keep it on loopback behind a TLS proxy.      |
| `server.basePath`             | `/`                              | Public path when served under a prefix, e.g. `/command-center/`.       |
| `server.trustProxy`           | `false`                          | Honour `X-Forwarded-Proto`/`Host`/`X-Real-IP` from your reverse proxy. |
| `server.dryRun`               | `false`                          | Show live state; record decisions and messages without sending them.   |
| `auth.mode`                   | `password`                       | `password`, `proxy` or `none` (see below).                             |
| `gateway.url`                 | `ws://127.0.0.1:18789`           | The gateway WebSocket.                                                 |
| `gateway.token`               | from `~/.openclaw/openclaw.json` | Operator token. Prefer `OPENCLAW_GATEWAY_TOKEN`.                       |
| `gateway.device`              | `auto`                           | Sign in with a device identity when the gateway isn't on loopback.     |
| `assistant.sessionKey`        | `agent:main:main`                | The OpenClaw session that typed and spoken turns go to.                |
| `assistant.name`              | the agent's identity             | Name on the orb and in the title.                                      |
| `operator.name`               | `Operator`                       | Your name; initials appear in the top bar.                             |
| `ui.timeZone`                 | the browser's                    | IANA zone for every time on screen, e.g. `Europe/Berlin`.              |
| `ui.controlUiUrl`             | none                             | Your Control UI, for deep links to sessions and approvals.             |
| `ui.suggestions`              | six prompts                      | The "Try saying" list.                                                 |
| `talk.enabled`                | `true`                           | Realtime voice. Off leaves a typed-only command center.                |
| `approvals.native.enabled`    | `true`                           | Exec, plugin and system approvals from the gateway.                    |
| `approvals.files.enabled`     | `false`                          | Markdown approval requests in `approvals.files.dir`.                   |
| `integrations.google.enabled` | `false`                          | Calendar and inbox panels through the `gog` CLI.                       |
| `host.enabled`                | `true`                           | Memory, disk and gateway RSS of this machine.                          |

Environment variables: `CC_CONFIG`, `CC_HOST`, `CC_PORT` (or `PORT`), `CC_BASE_PATH`, `CC_DATA_DIR`,
`CC_STATIC_DIR`, `CC_TRUST_PROXY`, `CC_DRY_RUN`, `CC_AUTH_MODE`, `CC_PASSWORD`, `CC_SESSION_SECRET`,
`CC_SESSION_KEY`, `OPENCLAW_GATEWAY_URL`, `OPENCLAW_GATEWAY_TOKEN`, `OPENCLAW_GATEWAY_PASSWORD`.

### Sign-in

Anyone who can use this app can talk to your agent and approve what it asks for, so treat it like the
Control UI.

- **`password`** (default): built-in sign-in with an scrypt-hashed password and an HMAC-signed, HttpOnly,
  SameSite=Strict session cookie. Failed attempts are rate limited.
- **`proxy`**: your reverse proxy already authenticated the user (basic auth, oauth2-proxy, Tailscale, ...).
  Lock it down so nothing can skip the proxy: `auth.trustedPeerUids` accepts only TCP connections from those
  local users (Linux; e.g. `[33]` for nginx as `www-data`), and/or `auth.proxyHeader` requires a shared header.
- **`none`**: no sign-in. Allowed only when the server binds to loopback; meant for development.

State-changing requests must be same-origin JSON, so a cross-site form can't approve anything.

### Gateway off this machine

On loopback the server connects with the operator token. When the gateway is elsewhere it also signs in with
a device identity (kept in the data directory), and the first connection waits for you to approve it on the
gateway host. The command center shows the exact command:

```bash
openclaw devices approve <requestId>
```

### Approval files (optional)

Some setups have the agent write a markdown file when a colleague asks for something only you may OK,
e.g. `approvals/20260105-2.md`:

```markdown
# Approval 20260105-2 — restart the staging worker

- **Requester:** Sam Lee (agent:main:slack:direct:u123)
- **Their words:** "can you bounce the staging worker?"
- **Action:** `systemctl restart worker` on staging, then check the health endpoint.
- **Risk:** a few seconds of queue delay.
- **Rollback:** none needed.
- **Status:** pending
```

Turn on `approvals.files`, and pending files appear next to the gateway's own approvals. Approve or Deny
sends `approve <id>` / `deny <id>` to the agent in its own session (`approvals.files.sessionKeyPrefix` +
id), worded by the `approveMessage` / `denyMessage` templates; your agent's own rules decide what happens next. A status
matching `approvals.files.gatedPattern` marks a request as waiting at an external gate (a change board,
another approver).

**Duplicate protection.** Before it sends, the server reads the approval's session from the gateway. It refuses
with a 409 if a run is active or an input is queued, or if the session already holds an `approve <id>` /
`deny <id>` message (from this app, a second instance, another tool, or someone typing into that session) while
the file is still open. A decision typed into a different session isn't visible to this check. If the gateway can't
be read, it returns a 503 and sends nothing. `force: true` on `POST approvals/resolve` bypasses the
"already sent" check only, never an active run; the app's buttons don't set it. Concurrent requests for one
approval are serialized, and `chat.send` gets a stable `idempotencyKey` derived from the session, the decision and
the attempt number.

## Deploying

The server serves the built app and the API from one port, so any reverse proxy works.

- **systemd:** `deploy/systemd/openclaw-command-center.service` (user unit, install steps inside).
- **nginx:** `deploy/nginx/command-center.conf` serves it under `/command-center/` with either sign-in mode.
  Set `server.basePath` to `/command-center/` and `server.trustProxy` to `true` to match.
- **Docker:** `docker compose -f deploy/docker/compose.yaml up -d --build` (host networking, so the gateway
  can stay on loopback).

Voice needs HTTPS in front. Runtime state (password hash, session secret, device identity, decision log)
lives in `server.dataDir` (`./data` by default, mode 0700).

## Development

```bash
npm ci
npm run dev:server      # API on :18821, restarts on change (point it at a gateway; CC_DRY_RUN=true is handy)
npm run dev             # Angular dev server on :4200, proxies /api to :18821
npm run check           # typecheck the server, run its tests, build the app
```

The repo is one npm package:

- `web/` is the Angular app (standalone components, signals, zoneless change detection). The visual design
  lives in `web/src/styles/` as a small token-based system.
- `server/src/` is the Node server: `gateway.ts` (WebSocket client), `state.ts` (the trimmed snapshot and
  decisions), `talk.ts` (voice sessions and typed turns), `auth.ts`, `config.ts`.
- `shared/api.ts` holds the wire types both sides use.

### API

All JSON, under `<basePath>api/`. Everything except `health`, `bootstrap` and `auth/*` needs a session.

| Route                                                          |                                                                           |
| -------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `GET health`                                                   | Liveness and gateway connection.                                          |
| `GET bootstrap`                                                | Who the assistant is, which features are on, whether you're signed in.    |
| `POST auth/login`, `POST auth/logout`                          | Password sign-in.                                                         |
| `GET state?sig=`                                               | The live snapshot. Approval items are omitted while `sig` still matches.  |
| `POST approvals/resolve`                                       | `{kind, id, decision, force?}`: decide an approval.                       |
| `POST chat`                                                    | `{text}`: a typed turn to the assistant session; returns its answer.      |
| `POST talk/session`, `talk/offer`, `talk/events`, `talk/close` | Start a voice call, relay its WebRTC offer, long-poll its events, end it. |

## License

MIT
