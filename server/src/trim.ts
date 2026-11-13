// Gateway responses, trimmed to what the UI shows. Nothing leaves here with IPs, account emails, filesystem
// paths, tokens, env values, cron payloads or delivery targets.
import type {
  Automations,
  ChannelAccounts,
  ChannelHealth,
  Channels,
  CronJob,
  GatewayStatus,
  Health,
  LimitProvider,
  NodeRow,
  Reply,
  SessionRow,
  TokenUsage,
} from '../../shared/api.ts';
import { arr, brief, clip, num, obj, scrub, str, textOf, tsOf } from './util.ts';

type J = Record<string, any>;
const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function trimHealth(raw: unknown): Health {
  const h = obj(raw) as J;
  const labels = obj(h['channelLabels']) as J;
  const chans = obj(h['channels']) as J;
  const order: string[] = Array.isArray(h['channelOrder']) ? h['channelOrder'] : Object.keys(chans);
  const channels: ChannelHealth[] = [...new Set([...order, ...Object.keys(chans)])].map((id) => {
    const c = obj(chans[id]) as J;
    return {
      id,
      label: str(labels[id]) ?? titleCase(id),
      connected: !!c['connected'],
      lifecycle: str(c['lifecycle']),
      lastError: c['lastError'] ? brief(c['lastError']) : null,
      lastInboundAt: tsOf(c['lastInboundAt']) || null,
    };
  });
  const plugins = obj(h['plugins']) as J;
  return {
    ok: !!h['ok'],
    plugins: {
      loaded: arr(plugins['loaded']).length,
      errors: arr(plugins['errors'])
        .map((x) => brief(x))
        .slice(0, 8),
      unavailable: arr(plugins['unavailable'])
        .map((x) => brief(x))
        .slice(0, 8),
    },
    heartbeatSeconds: num(h['heartbeatSeconds']),
    channels,
    agents: arr(h['agents']).map((x) => {
      const a = obj(x) as J;
      const hb = obj(a['heartbeat']) as J;
      return {
        id: String(a['agentId'] ?? ''),
        isDefault: !!a['isDefault'],
        heartbeat: hb['enabled'] ? (hb['every'] ?? true) : null,
        sessions: num(obj(a['sessions'])['count']),
      };
    }),
  };
}

export function trimStatus(raw: unknown): GatewayStatus {
  const s = obj(raw) as J;
  const w = obj(s['sqliteWal']) as J;
  return {
    version: str(s['runtimeVersion']),
    wal: {
      state: str(w['state']),
      walBytes: num(w['walBytes']),
      dbBytes: num(w['databaseBytes']),
      warning: w['warning'] ? brief(w['warning']) : null,
      blocked: num(w['consecutiveBlocked']) ?? 0,
    },
    heartbeat: arr(obj(s['heartbeat'])['agents']).map((x) => {
      const a = obj(x) as J;
      return { id: String(a['agentId'] ?? ''), enabled: !!a['enabled'], every: str(a['every']) };
    }),
  };
}

export const trimLimits = (raw: unknown): LimitProvider[] =>
  arr(obj(raw)['providers']).map((x) => {
    const p = obj(x) as J;
    const err = p['error'];
    return {
      id: String(p['provider'] ?? ''),
      name: str(p['displayName']) ?? String(p['provider'] ?? 'Provider'),
      plan: typeof p['plan'] === 'string' ? clip(p['plan'], 40) : null,
      error: err ? brief(typeof err === 'string' ? err : (err.message ?? err), 120) : null,
      windows: arr(p['windows']).map((y) => {
        const w = obj(y) as J;
        return {
          label: String(w['label'] ?? ''),
          used: num(w['usedPercent']),
          resetAt: tsOf(w['resetAt']) || null,
        };
      }),
    };
  });

export const trimCost = (raw: unknown): TokenUsage => {
  const c = obj(raw) as J;
  return {
    updatedAt: tsOf(c['updatedAt']) || null,
    daily: arr(c['daily']).map((x) => {
      const d = obj(x) as J;
      return {
        date: String(d['date'] ?? ''),
        total: num(d['totalTokens']) ?? 0,
        input: num(d['input']) ?? 0,
        output: num(d['output']) ?? 0,
        cacheRead: num(d['cacheRead']) ?? 0,
        cacheWrite: num(d['cacheWrite']) ?? 0,
      };
    }),
  };
};

export function trimChannels(raw: unknown): Channels {
  const c = obj(raw) as J;
  const el = obj(c['eventLoop']) as J;
  const meta = new Map<string, J>(
    arr(c['channelMeta']).map((m) => [String(obj(m)['id']), obj(m) as J]),
  );
  const latest = (list: J[], k: string) => Math.max(0, ...list.map((a) => tsOf(a[k]))) || null;
  const channels: ChannelAccounts[] = Object.entries(obj(c['channelAccounts'])).map(
    ([id, accts]) => {
      const list = arr(accts).map((a) => obj(a) as J);
      return {
        id,
        label: str(meta.get(id)?.['label']) ?? titleCase(id),
        detail: str(meta.get(id)?.['detailLabel']),
        accounts: list.length,
        enabled: list.filter((a) => a['enabled'] !== false).length,
        connected: list.filter((a) => a['connected']).length,
        lastInboundAt: latest(list, 'lastInboundAt'),
        lastOutboundAt: latest(list, 'lastOutboundAt'),
        errors: list
          .map((a) => a['lastError'])
          .filter(Boolean)
          .map((e) => brief(e, 140))
          .slice(0, 3),
      };
    },
  );
  for (const [id, m] of meta)
    if (!channels.some((x) => x.id === id))
      channels.push({
        id,
        label: str(m['label']) ?? titleCase(id),
        detail: str(m['detailLabel']),
        accounts: 0,
        enabled: 0,
        connected: 0,
        lastInboundAt: null,
        lastOutboundAt: null,
        errors: [],
      });
  return {
    eventLoop: {
      degraded: !!el['degraded'],
      reasons: arr(el['reasons'])
        .map((x) => brief(x, 100))
        .slice(0, 4),
      p99: num(el['delayP99Ms']),
      utilization: num(el['utilization']),
      cpu: num(el['cpuCoreRatio']),
    },
    channels,
    issues: arr(c['statusIssues'])
      .map((x) => brief(x))
      .slice(0, 6),
  };
}

export const trimNodes = (raw: unknown): NodeRow[] =>
  arr(obj(raw)['nodes']).map((y) => {
    const x = obj(y) as J;
    const hs = obj(x['hostStats']) as J;
    return {
      name: str(x['displayName']) ?? str(x['modelIdentifier']) ?? 'Device',
      platform: str(x['platform']),
      version: str(x['version']),
      family: str(x['deviceFamily']),
      model: str(x['modelIdentifier']),
      connected: !!x['connected'],
      paired: !!x['paired'],
      lastSeenAt: num(x['lastSeenAtMs']),
      lastConnectedAt: num(x['lastConnectedAtMs']),
      memFree: num(hs['memoryFreeBytes']),
      memTotal: num(hs['memoryTotalBytes']),
      cpus: num(hs['cpuCount']),
      caps: Array.isArray(x['caps']) ? x['caps'].length : null,
    };
  });

// ---- sessions ----

export interface SessionContext {
  talkSessionKey: string;
  assistantName: string;
  approvalPrefix: string | null;
  channelLabels: Record<string, string>;
}

/** Where a session lives, from its key: agent:<agent>:<kind>[:<chat type>:…]. */
export function whereOf(key: string, ctx: SessionContext): string {
  if (key === ctx.talkSessionKey) return `${ctx.assistantName} voice`;
  if (ctx.approvalPrefix && key.startsWith(ctx.approvalPrefix)) return 'Approval';
  const p = key.split(':');
  const kind = p[2] ?? '';
  if (p.length === 3 && kind === 'main') return 'Main';
  if (kind === 'cron') return 'Automation';
  if (kind === 'subagent') return 'Subagent';
  if (kind === 'dashboard' || kind === 'webchat') return 'Webchat';
  const label = ctx.channelLabels[kind];
  if (label)
    return p[3] === 'direct'
      ? `${label} DM`
      : p[3]
        ? `${label} ${p[3] === 'channel' ? 'channel' : p[3]}`
        : label;
  return kind ? titleCase(kind.replace(/[-_]+/g, ' ')) : 'Session';
}

// Chat-platform raw labels ("slack:U0…", "<@U0…>", "<https://…|text>") read badly; prefer names and words.
function titleOf(s: J, ctx: SessionContext): string {
  const human = (x: unknown) =>
    typeof x === 'string' && x && !/^[a-z]+:[A-Z0-9-]+$/i.test(x) ? x : '';
  const who = human(obj(s['origin'])['label']);
  let derived = String(s['derivedTitle'] ?? '')
    .replace(/^Slack thread #?[A-Z0-9]+:\s*/, '')
    .replace(/<@[A-Z0-9]+>\s*/g, '')
    .replace(/<(https?:[^|>]+)(?:\|([^>]*))?>/g, (_m, _u: string, t?: string) => t || 'link')
    .trim();
  if (/^[a-z]+:[A-Z0-9-]+$/i.test(derived)) derived = '';
  if (typeof s['label'] === 'string' && s['label']) return clip(s['label'], 90);
  if (who && derived && who !== derived) return clip(`${who}: ${derived}`, 90);
  return clip(derived || who || human(s['subject']) || whereOf(String(s['key'] ?? ''), ctx), 90);
}

export function trimSessions(raw: unknown, ctx: SessionContext): SessionRow[] {
  const out: SessionRow[] = [];
  for (const x of arr(obj(raw)['sessions'])) {
    const s = obj(x) as J;
    const key = String(s['key'] ?? '');
    let preview =
      typeof s['lastMessagePreview'] === 'string'
        ? s['lastMessagePreview']
        : textOf(s['lastMessagePreview']) || '';
    if (/^\[OpenClaw heartbeat poll\]/.test(preview)) continue;
    if (/^\[OpenClaw (exec completion|heartbeat)/.test(preview)) preview = '';
    const running = !!s['hasActiveRun'] || s['status'] === 'running';
    out.push({
      key,
      title: titleOf(s, ctx),
      where: whereOf(key, ctx),
      status: running ? 'running' : str(s['status']),
      running,
      updatedAt: tsOf(s['updatedAt']) || null,
      preview: scrub(clip(preview, 220)),
      spawnedBy: str(s['spawnedBy']),
      agent: key.split(':')[1] ?? null,
      model: str(s['model']),
    });
  }
  return out;
}

// ---- automations ----

function schedText(s: J | undefined): string {
  if (!s) return '';
  const every = (ms: number) =>
    ms % 3600e3 === 0
      ? `${ms / 3600e3} h`
      : ms % 60e3 === 0
        ? `${ms / 60e3} min`
        : `${Math.round(ms / 1000)} s`;
  if (s['kind'] === 'every') return `every ${every(Number(s['everyMs']) || 0)}`;
  if (s['kind'] === 'cron') return `cron ${s['expr']}${s['tz'] ? ` · ${s['tz']}` : ''}`;
  if (s['kind'] === 'at') return 'one-shot';
  if (s['kind'] === 'stream' || s['kind'] === 'event') return 'on events';
  return String(s['kind'] ?? '');
}

export function trimCron(raw: unknown): Automations {
  const jobs: CronJob[] = arr(obj(raw)['jobs']).map((y) => {
    const j = obj(y) as J;
    const st = obj(j['state']) as J;
    const sched = obj(j['schedule']) as J;
    const lastError = j['lastRunError'] || st['lastError'];
    return {
      id: String(j['id'] ?? ''),
      name: clip(j['displayName'] || j['name'] || j['id'], 90),
      heartbeat: /^heartbeat:/.test(String(j['declarationKey'] ?? '')),
      enabled: j['enabled'] !== false,
      agent: str(j['effectiveAgentId']) ?? str(j['agentId']),
      schedule: schedText(sched),
      kind: str(sched['kind']),
      nextRunAt: num(j['nextRunAtMs']) ?? num(st['nextRunAtMs']),
      lastRunAt: num(j['lastRunAtMs']) ?? num(st['lastRunAtMs']),
      lastStatus: str(j['lastRunStatus']) ?? str(st['lastRunStatus']) ?? str(st['lastStatus']),
      errors: num(st['consecutiveErrors']) ?? 0,
      lastError: lastError ? brief(lastError) : null,
      lastDurationMs: num(st['lastDurationMs']),
    };
  });
  const real = jobs.filter((j) => !j.heartbeat);
  const failing = real
    .filter((j) => j.lastStatus === 'error' || j.errors > 0)
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || b.errors - a.errors);
  return {
    total: real.length,
    enabled: real.filter((j) => j.enabled).length,
    heartbeats: jobs.length - real.length,
    next: real
      .filter((j) => j.enabled && j.nextRunAt)
      .sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0))
      .slice(0, 8),
    failing: failing.slice(0, 12),
    failingCount: failing.length,
    failingEnabled: failing.filter((j) => j.enabled).length,
  };
}

/**
 * The talk session's recent final replies (the assistant's answers and its later reports when delegated work
 * finishes), oldest first. Only a run's final reply counts: text between tool calls carries no runId, and
 * relayed inter-session data and message-tool mirrors are not its reply. Silent tokens are dropped.
 */
export function extractReplies(messages: unknown): Reply[] {
  const out: Reply[] = [];
  for (const x of arr(messages)) {
    const m = obj(x) as J;
    const meta = obj(m['__openclaw']) as J;
    if (
      m['role'] !== 'assistant' ||
      !meta['runId'] ||
      m['model'] === 'delivery-mirror' ||
      obj(m['provenance'])['kind'] === 'inter_session'
    )
      continue;
    const text = String(textOf(m) || '').trim();
    if (!text || /^(NO_REPLY|HEARTBEAT_OK|Already covered\.?)$/i.test(text)) continue;
    out.push({
      id: String(meta['id'] ?? m['id'] ?? m['timestamp'] ?? out.length),
      ts: tsOf(m['timestamp']) || null,
      text: scrub(text).slice(0, 4000),
    });
  }
  return out.slice(-8);
}
