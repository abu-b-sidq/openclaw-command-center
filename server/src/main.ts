// OpenClaw Command Center server: the JSON API under <basePath>api/ and the built Angular app at <basePath>.
// Run with Node 22.18+ (native TypeScript): node server/src/main.ts [--config path/to/config.json]
import { mkdirSync, readFileSync } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { Bootstrap, ResolveRequest } from '../../shared/api.ts';
import { Auth } from './auth.ts';
import { agentOf, loadConfig, type Config } from './config.ts';
import { Gateway } from './gateway.ts';
import { StateService } from './state.ts';
import { StaticFiles } from './static.ts';
import { Talk } from './talk.ts';
import { HttpError, log, obj, str } from './util.ts';

const VERSION: string = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
).version;
const MAX_BODY = 256 * 1024;

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'SAMEORIGIN',
  'permissions-policy': 'microphone=(self), camera=(), geolocation=()',
  'x-robots-tag': 'noindex, nofollow',
  // connect-src https: lets the browser post its WebRTC offer to the Talk provider the gateway picked.
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: mediastream:; connect-src 'self' https: wss:; font-src 'self' data:; object-src 'none'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'",
};

/** The assistant's display name and emoji: config first, else the agent's identity from the gateway. */
class Identity {
  private readonly cfg: Config;
  private readonly gw: Gateway;
  readonly agentId: string | null;
  name: string;
  emoji: string | null = null;

  constructor(cfg: Config, gw: Gateway) {
    this.cfg = cfg;
    this.gw = gw;
    this.agentId = agentOf(cfg.assistant.sessionKey);
    const id = this.agentId ?? '';
    this.name =
      cfg.assistant.name ||
      (id && id !== 'main' ? id.charAt(0).toUpperCase() + id.slice(1) : 'Assistant');
  }

  async refresh(): Promise<void> {
    try {
      const r = obj(await this.gw.request('agents.list', {}, 15000));
      const a = (Array.isArray(r['agents']) ? r['agents'] : [])
        .map(obj)
        .find((x) => x['id'] === this.agentId);
      if (!a) return;
      const ident = obj(a['identity']);
      this.emoji = str(ident['emoji']) ?? str(a['emoji']);
      if (!this.cfg.assistant.name) this.name = str(ident['name']) ?? str(a['name']) ?? this.name;
    } catch {
      /* keep what we have; the gateway may be down */
    }
  }
}

const initialsOf = (name: string) => {
  const w = name.trim().split(/\s+/).filter(Boolean);
  return (
    w.length > 1 ? (w[0]![0] ?? '') + (w[1]![0] ?? '') : (w[0] ?? '?').slice(0, 2)
  ).toUpperCase();
};

function main(): void {
  let cfg: Config;
  try {
    cfg = loadConfig();
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
  mkdirSync(cfg.server.dataDir, { recursive: true, mode: 0o700 });

  const gw = new Gateway(cfg, VERSION);
  const auth = new Auth(cfg);
  const identity = new Identity(cfg, gw);
  const talk = new Talk(cfg, gw);
  const state = new StateService(cfg, gw, () => identity.name);
  const web = new StaticFiles(cfg.server.staticDir, cfg.server.basePath);
  const google = cfg.integrations.google;
  const prefix = cfg.server.basePath.replace(/\/$/, '');

  const isHttps = (req: IncomingMessage) =>
    (cfg.server.trustProxy &&
      String(req.headers['x-forwarded-proto'] || '')
        .split(',')[0]
        ?.trim() === 'https') ||
    !!(req.socket as { encrypted?: boolean }).encrypted;

  // CSRF: state-changing calls must be same-origin JSON. Cookies are SameSite=Strict too; proxy basic auth is
  // ambient, so this check is what stops a cross-site form.
  const originOk = (req: IncomingMessage) => {
    const origin = req.headers.origin;
    if (!origin) return false;
    if (cfg.server.allowedOrigins.includes(origin)) return true;
    const host =
      (cfg.server.trustProxy &&
        String(req.headers['x-forwarded-host'] || '')
          .split(',')[0]
          ?.trim()) ||
      req.headers.host;
    try {
      return !!host && new URL(origin).host === host;
    } catch {
      return false;
    }
  };

  function bootstrap(req: IncomingMessage): Bootstrap {
    const signedIn = auth.authenticated(req);
    return {
      version: VERSION,
      authMode: cfg.auth.mode,
      authenticated: signedIn,
      assistant: {
        name: identity.name,
        tagline: cfg.assistant.tagline,
        agentId: identity.agentId,
        emoji: identity.emoji,
      },
      operator: signedIn
        ? {
            name: cfg.operator.name,
            initials: cfg.operator.initials || initialsOf(cfg.operator.name),
          }
        : { name: '', initials: '' },
      ui: signedIn
        ? { ...cfg.ui }
        : {
            timeZone: null,
            timeZoneLabel: null,
            suggestions: [],
            controlUiUrl: null,
            calendarUrl: null,
          },
      features: {
        talk: cfg.talk.enabled && !cfg.server.dryRun,
        nativeApprovals: cfg.approvals.native.enabled,
        fileApprovals: cfg.approvals.files.enabled,
        calendar: google.enabled && google.calendar,
        mail: google.enabled && google.mail,
        host: cfg.host.enabled,
      },
      talk: { sessionKey: signedIn ? cfg.assistant.sessionKey : '' },
      dryRun: cfg.server.dryRun,
    };
  }

  type Handler = (
    req: IncomingMessage,
    res: ServerResponse,
    body: Record<string, any>,
    query: URLSearchParams,
  ) => Promise<unknown> | unknown;
  interface Route {
    method: 'GET' | 'POST';
    public?: boolean;
    handle: Handler;
  }
  const routes: Record<string, Route> = {
    health: {
      method: 'GET',
      public: true,
      handle: () => ({ ok: true, gateway: gw.status.connected, talkSessions: talk.live }),
    },
    bootstrap: { method: 'GET', public: true, handle: (req) => bootstrap(req) },
    'auth/login': {
      method: 'POST',
      public: true,
      handle: (req, res, b) => {
        const err = auth.login(req, res, String(b['password'] ?? ''), isHttps(req));
        if (err) throw new HttpError(err.startsWith('Too many') ? 429 : 401, err);
        return { ok: true };
      },
    },
    'auth/logout': {
      method: 'POST',
      public: true,
      handle: (req, res) => {
        auth.logout(res, isHttps(req));
        return { ok: true };
      },
    },
    state: { method: 'GET', handle: (_req, _res, _b, q) => state.snapshot(q.get('sig')) },
    chat: { method: 'POST', handle: (_req, _res, b) => talk.chat(String(b['text'] ?? '')) },
    'talk/session': { method: 'POST', handle: () => talk.open() },
    'talk/events': {
      method: 'POST',
      handle: (_req, _res, b) =>
        talk.events(String(b['voiceSessionId'] ?? ''), Number(b['after']) || 0),
    },
    'talk/offer': {
      method: 'POST',
      handle: (_req, _res, b) =>
        talk.offer(String(b['voiceSessionId'] ?? ''), String(b['sdp'] ?? '')),
    },
    'talk/close': {
      method: 'POST',
      handle: (_req, _res, b) => talk.close(String(b['voiceSessionId'] ?? '')),
    },
    'approvals/resolve': {
      method: 'POST',
      handle: (_req, _res, b) => state.resolve(b as Partial<ResolveRequest>),
    },
  };

  const send = (res: ServerResponse, code: number, obj: unknown) => {
    if (res.headersSent) return void res.end();
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify(obj));
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    const url = new URL(req.url || '/', 'http://local');
    let path = url.pathname;
    if (prefix && (path === prefix || path.startsWith(`${prefix}/`)))
      path = path.slice(prefix.length);
    path = path.replace(/^\/+/, '');

    if (path === 'api/health')
      return send(res, 200, routes['health']!.handle(req, res, {}, url.searchParams));
    if (!auth.admits(req)) return send(res, 403, { error: 'forbidden' });

    if (!path.startsWith('api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD')
        return send(res, 405, { error: 'method not allowed' });
      return web.serve(path, res, req.method === 'HEAD');
    }

    const name = path.slice(4).replace(/\/+$/, '');
    const route = Object.hasOwn(routes, name) ? routes[name]! : null;
    if (!route) return send(res, 404, { error: 'not found' });
    if (req.method !== route.method) return send(res, 405, { error: 'method not allowed' });
    if (!route.public && !auth.authenticated(req))
      return send(res, 401, { error: 'sign in first' });

    let body: Record<string, any> = {};
    if (route.method === 'POST') {
      if (
        !originOk(req) ||
        !String(req.headers['content-type'] || '').startsWith('application/json')
      ) {
        log('refused cross-origin or non-JSON POST', name, req.headers.origin ?? '-');
        return send(res, 403, { error: 'forbidden' });
      }
      let raw = '',
        size = 0;
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY) return send(res, 413, { error: 'request too large' });
        raw += chunk;
      }
      try {
        body = raw ? obj(JSON.parse(raw)) : {};
      } catch {
        return send(res, 400, { error: 'invalid JSON' });
      }
    }
    try {
      send(res, 200, await route.handle(req, res, body, url.searchParams));
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status >= 500) log(name, 'error:', (e as Error).message);
      send(res, status, { error: (e as Error).message });
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e: Error) => {
      log('request failed:', e.message);
      send(res, 500, { error: 'internal error' });
    });
  });
  server.requestTimeout = 120000;

  server.listen(cfg.server.port, cfg.server.host, () => {
    log(
      `OpenClaw Command Center ${VERSION} on http://${cfg.server.host}:${cfg.server.port}${cfg.server.basePath} (auth: ${cfg.auth.mode}${cfg.server.dryRun ? ', DRY RUN' : ''})`,
    );
    log(
      `gateway ${cfg.gateway.url}, talk session ${cfg.assistant.sessionKey}${cfg.configFile ? `, config ${cfg.configFile}` : ''}`,
    );
    if (!web.available) log(`no web build in ${cfg.server.staticDir} yet: run "npm run build"`);
    if (auth.generatedPassword) {
      log('────────────────────────────────────────────────────────────');
      log(`First run: generated sign-in password: ${auth.generatedPassword}`);
      log('It is shown once. Change it with: npm run set-password');
      log('────────────────────────────────────────────────────────────');
    }
    if (cfg.auth.mode === 'none')
      log('WARNING: auth.mode is "none". Anyone who can reach this port controls your assistant.');
    identity.refresh().catch(() => {});
  });
  setInterval(() => identity.refresh().catch(() => {}), 10 * 60e3).unref();

  let stopping = false;
  const stop = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    log(`${sig}: shutting down`);
    await talk.closeAll().catch(() => {});
    server.close();
    gw.close();
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
}

main();
