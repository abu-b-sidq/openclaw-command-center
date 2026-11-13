// Configuration: defaults, then a JSON file (--config, CC_CONFIG or ./config.json), then environment overrides.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { AuthMode } from '../../shared/api.ts';

export interface FileApprovalsConfig {
  enabled: boolean;
  /** Directory of <YYYYMMDD>-<n>.md request files. */
  dir: string;
  /** Each decision runs in its own session: <prefix><id>. */
  sessionKeyPrefix: string;
  /** Message templates. Placeholders: {id} {decision} {operator} {time} {file} {gateNote}. */
  approveMessage: string;
  denyMessage: string;
  /** Case-insensitive regex on the status text that marks a request as waiting at an external gate. */
  gatedPattern: string | null;
  gatedLabel: string;
  /** Appended to the approve message as {gateNote} when the request is gated. */
  gatedMessageNote: string;
  /** Shown under the buttons in the request drawer. */
  approveNote: string;
  gatedNote: string;
}

export interface Config {
  configFile: string | null;
  server: {
    host: string;
    port: number;
    /** Public path the app is served under, e.g. "/" or "/command-center/". */
    basePath: string;
    /** Honour X-Forwarded-Proto/Host from a reverse proxy. */
    trustProxy: boolean;
    /** Extra origins allowed to POST (same-origin is always allowed). */
    allowedOrigins: string[];
    dataDir: string;
    staticDir: string;
    /** Record decisions and chat sends without sending anything to the gateway. */
    dryRun: boolean;
  };
  auth: {
    mode: AuthMode;
    password: string | null;
    passwordHash: string | null;
    sessionSecret: string | null;
    sessionDays: number;
    /** Linux only: accept only TCP peers owned by these uids (e.g. nginx's www-data = 33). */
    trustedPeerUids: number[];
    /** proxy mode: require this header (name: value) on every request. */
    proxyHeader: { name: string; value: string } | null;
  };
  gateway: {
    url: string;
    token: string | null;
    password: string | null;
    /** Where to read gateway.auth.token when no token is configured. */
    openclawConfig: string;
    /** "auto" signs in with a device identity when the gateway isn't on loopback. */
    device: 'auto' | 'always' | 'never';
  };
  assistant: {
    /** Display name. Default: the agent's identity name from the gateway. */
    name: string | null;
    tagline: string;
    /** The OpenClaw session that typed and spoken turns go to. */
    sessionKey: string;
  };
  operator: { name: string; initials: string | null };
  ui: {
    timeZone: string | null;
    timeZoneLabel: string | null;
    controlUiUrl: string | null;
    calendarUrl: string | null;
    suggestions: string[];
  };
  talk: { enabled: boolean; maxLive: number };
  approvals: { native: { enabled: boolean }; files: FileApprovalsConfig };
  integrations: {
    google: {
      enabled: boolean;
      /** argv prefix for the gog CLI, e.g. ["gog"] or ["/usr/local/bin/gog", "--account", "me@example.com"]. */
      command: string[];
      calendar: boolean;
      calendarHours: number;
      mail: boolean;
      mailQuery: string;
      mailMax: number;
    };
  };
  host: { enabled: boolean };
}

const DEFAULT_SUGGESTIONS = [
  'What needs me right now?',
  'Any automations failing?',
  'What’s running on the gateway right now?',
  'Summarise what happened today',
  'What did I miss in my channels?',
  'How much have I used today?',
];

function defaults(): Omit<Config, 'configFile'> {
  return {
    server: {
      host: '127.0.0.1',
      port: 18821,
      basePath: '/',
      trustProxy: false,
      allowedOrigins: [],
      dataDir: './data',
      staticDir: './dist/web/browser',
      dryRun: false,
    },
    auth: {
      mode: 'password',
      password: null,
      passwordHash: null,
      sessionSecret: null,
      sessionDays: 30,
      trustedPeerUids: [],
      proxyHeader: null,
    },
    gateway: {
      url: 'ws://127.0.0.1:18789',
      token: null,
      password: null,
      openclawConfig: '~/.openclaw/openclaw.json',
      device: 'auto',
    },
    assistant: { name: null, tagline: 'Command Center', sessionKey: 'agent:main:main' },
    operator: { name: 'Operator', initials: null },
    ui: {
      timeZone: null,
      timeZoneLabel: null,
      controlUiUrl: null,
      calendarUrl: 'https://calendar.google.com/',
      suggestions: DEFAULT_SUGGESTIONS,
    },
    talk: { enabled: true, maxLive: 3 },
    approvals: {
      native: { enabled: true },
      files: {
        enabled: false,
        dir: '~/.openclaw/workspace/approvals',
        sessionKeyPrefix: 'agent:main:command-center-approval-',
        approveMessage:
          'approve {id}\n\n({operator} approved this in the OpenClaw Command Center at {time}. Run exactly what {file} describes and nothing more, then record the result in the file.{gateNote})',
        denyMessage:
          'deny {id}\n\n({operator} denied this in the OpenClaw Command Center at {time}. Mark {file} as denied and tell the requester. Don’t run the action.)',
        gatedPattern: null,
        gatedLabel: 'Gated',
        gatedMessageNote:
          ' It is waiting at an external gate, so don’t run it directly: say what the gate still needs.',
        approveNote:
          'Approve sends “approve {id}” to the agent, same as typing it in chat. It runs exactly what’s in this file and nothing more.',
        gatedNote:
          'This request is waiting at an external gate. Approving records your OK; the agent tells you what the gate still needs.',
      },
    },
    integrations: {
      google: {
        enabled: false,
        command: ['gog'],
        calendar: true,
        calendarHours: 36,
        mail: true,
        mailQuery: 'is:unread is:important in:inbox newer_than:2d',
        mailMax: 8,
      },
    },
    host: { enabled: true },
  };
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

function merge(base: Json, over: Json, path = ''): Json {
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (k.startsWith('$') || k.startsWith('//')) continue; // "$schema", "//": comments
    if (!(k in base)) throw new Error(`Unknown config key "${path}${k}"`);
    out[k] = isObj(base[k]) && isObj(v) ? merge(base[k] as Json, v, `${path}${k}.`) : v;
  }
  return out;
}

export const expandHome = (p: string): string =>
  p === '~' || p.startsWith('~/') ? homedir() + p.slice(1) : p;

function argConfigPath(argv: string[]): string | null {
  const i = argv.indexOf('--config');
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith('--config='));
  return eq ? eq.slice('--config='.length) : null;
}

const envBool = (v: string | undefined): boolean | undefined =>
  v === undefined || v === '' ? undefined : /^(1|true|yes|on)$/i.test(v);

export function loadConfig(argv = process.argv.slice(2), env = process.env): Config {
  const explicit = argConfigPath(argv) || env['CC_CONFIG'] || null;
  const file = explicit
    ? resolve(expandHome(explicit))
    : existsSync('config.json')
      ? resolve('config.json')
      : null;
  let raw: Json = {};
  if (file) {
    try {
      raw = JSON.parse(readFileSync(file, 'utf8')) as Json;
    } catch (e) {
      throw new Error(`Can't read config ${file}: ${(e as Error).message}`);
    }
    if (!isObj(raw)) throw new Error(`Config ${file} must be a JSON object`);
  }
  const c = merge(defaults() as unknown as Json, raw) as unknown as Omit<Config, 'configFile'>;
  const cfg: Config = { configFile: file, ...c };

  // Environment wins over the file, so secrets can stay out of it.
  const s = cfg.server,
    a = cfg.auth,
    g = cfg.gateway;
  if (env['CC_HOST']) s.host = env['CC_HOST'];
  if (env['CC_PORT'] || env['PORT']) s.port = Number(env['CC_PORT'] || env['PORT']);
  if (env['CC_BASE_PATH']) s.basePath = env['CC_BASE_PATH'];
  if (env['CC_DATA_DIR']) s.dataDir = env['CC_DATA_DIR'];
  if (env['CC_STATIC_DIR']) s.staticDir = env['CC_STATIC_DIR'];
  s.trustProxy = envBool(env['CC_TRUST_PROXY']) ?? s.trustProxy;
  s.dryRun = envBool(env['CC_DRY_RUN']) ?? s.dryRun;
  if (env['CC_AUTH_MODE']) a.mode = env['CC_AUTH_MODE'] as AuthMode;
  if (env['CC_PASSWORD']) a.password = env['CC_PASSWORD'];
  if (env['CC_SESSION_SECRET']) a.sessionSecret = env['CC_SESSION_SECRET'];
  if (env['OPENCLAW_GATEWAY_URL']) g.url = env['OPENCLAW_GATEWAY_URL'];
  if (env['OPENCLAW_GATEWAY_TOKEN']) g.token = env['OPENCLAW_GATEWAY_TOKEN'];
  if (env['OPENCLAW_GATEWAY_PASSWORD']) g.password = env['OPENCLAW_GATEWAY_PASSWORD'];
  if (env['CC_SESSION_KEY']) cfg.assistant.sessionKey = env['CC_SESSION_KEY'];

  // Relative paths resolve against the config file's directory (or the working directory without one).
  const base = file ? dirname(file) : process.cwd();
  const abs = (p: string) => (isAbsolute(expandHome(p)) ? expandHome(p) : resolve(base, p));
  s.dataDir = abs(s.dataDir);
  s.staticDir = abs(s.staticDir);
  g.openclawConfig = abs(g.openclawConfig);
  cfg.approvals.files.dir = abs(cfg.approvals.files.dir);

  validate(cfg);
  return cfg;
}

export const isLoopbackHost = (h: string): boolean =>
  /^(127\.\d+\.\d+\.\d+|localhost|::1|\[::1\])$/i.test(h);

function validate(cfg: Config): void {
  const fail = (m: string) => {
    throw new Error(`Config: ${m}`);
  };
  const s = cfg.server;
  if (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535)
    fail(`server.port must be 1-65535 (got ${s.port})`);
  s.basePath = `/${s.basePath.replace(/^\/+|\/+$/g, '')}/`.replace(/^\/\/$/, '/');
  if (!/^\/[\w\-./]*$/.test(s.basePath))
    fail(`server.basePath "${s.basePath}" has unsupported characters`);
  if (!['password', 'proxy', 'none'].includes(cfg.auth.mode))
    fail(`auth.mode must be password, proxy or none`);
  if (cfg.auth.mode === 'none' && !isLoopbackHost(s.host))
    fail(`auth.mode "none" is only allowed when server.host is a loopback address`);
  if (
    !Array.isArray(cfg.auth.trustedPeerUids) ||
    cfg.auth.trustedPeerUids.some((u) => !Number.isInteger(u))
  )
    fail('auth.trustedPeerUids must be a list of integer uids');
  const ph = cfg.auth.proxyHeader;
  if (ph && (!ph.name || !ph.value)) fail('auth.proxyHeader needs both name and value');
  if (!/^wss?:\/\//.test(cfg.gateway.url))
    fail(`gateway.url must start with ws:// or wss:// (got ${cfg.gateway.url})`);
  if (!['auto', 'always', 'never'].includes(cfg.gateway.device))
    fail('gateway.device must be auto, always or never');
  if (!/^agent:[\w.-]+:\S+$/.test(cfg.assistant.sessionKey))
    fail(
      `assistant.sessionKey must look like agent:<agentId>:<name> (got ${cfg.assistant.sessionKey})`,
    );
  if (cfg.ui.timeZone) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: cfg.ui.timeZone });
    } catch {
      fail(`ui.timeZone "${cfg.ui.timeZone}" is not a valid IANA time zone`);
    }
  }
  for (const k of ['controlUiUrl', 'calendarUrl'] as const) {
    const u = cfg.ui[k];
    if (u && !/^https?:\/\//.test(u)) fail(`ui.${k} must be an http(s) URL`);
    if (u) cfg.ui[k] = u.replace(/\/+$/, '') + (k === 'calendarUrl' ? '/' : '');
  }
  if (!Array.isArray(cfg.ui.suggestions)) fail('ui.suggestions must be a list of strings');
  cfg.ui.suggestions = cfg.ui.suggestions.map(String).filter(Boolean).slice(0, 20);
  if (!Number.isInteger(cfg.talk.maxLive) || cfg.talk.maxLive < 1)
    fail('talk.maxLive must be a positive integer');
  const f = cfg.approvals.files;
  if (f.gatedPattern) {
    try {
      new RegExp(f.gatedPattern, 'i');
    } catch {
      fail(`approvals.files.gatedPattern is not a valid regex`);
    }
  }
  if (!/^agent:[\w.-]+:/.test(f.sessionKeyPrefix))
    fail('approvals.files.sessionKeyPrefix must start with agent:<agentId>:');
  const gc = cfg.integrations.google.command;
  if (!Array.isArray(gc) || !gc.length || gc.some((x) => typeof x !== 'string'))
    fail('integrations.google.command must be a non-empty list of strings');
}

/** The agent id inside a session key: agent:<id>:… */
export const agentOf = (sessionKey: string): string | null =>
  /^agent:([^:]+):/.exec(sessionKey)?.[1] ?? null;
