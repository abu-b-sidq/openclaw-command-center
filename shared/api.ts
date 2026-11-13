// Wire types shared by the server (server/src) and the Angular app (web/src).
// Types only: Node strips these imports at runtime and Angular erases them at build time.

export type Level = 'ok' | 'warn' | 'bad';
export type AuthMode = 'password' | 'proxy' | 'none';

/** GET /api/bootstrap: everything the app needs before it can render. */
export interface Bootstrap {
  version: string;
  authMode: AuthMode;
  authenticated: boolean;
  assistant: { name: string; tagline: string; agentId: string | null; emoji: string | null };
  operator: { name: string; initials: string };
  ui: {
    timeZone: string | null;
    timeZoneLabel: string | null;
    suggestions: string[];
    controlUiUrl: string | null;
    calendarUrl: string | null;
  };
  features: {
    talk: boolean;
    nativeApprovals: boolean;
    fileApprovals: boolean;
    calendar: boolean;
    mail: boolean;
    host: boolean;
  };
  talk: { sessionKey: string };
  dryRun: boolean;
}

// ---------- approvals ----------

/** exec/plugin/system-agent come from the gateway's own approval registry; file is the optional approvals/*.md flow. */
export type ApprovalKind = 'exec' | 'plugin' | 'system-agent' | 'file';
export type Decision = 'allow-once' | 'allow-always' | 'approve' | 'deny';
export type ApprovalStatus =
  'pending' | 'partial' | 'done' | 'withdrawn' | 'denied' | 'expired' | 'other';

export interface ApprovalItem {
  kind: ApprovalKind;
  id: string;
  title: string;
  open: boolean;
  status: ApprovalStatus;
  statusLine: string | null;
  gated: boolean;
  gatedLabel: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  expiresAt: number | null;
  requester: { name: string | null; detail: string | null };
  agentId: string | null;
  sessionKey: string | null;
  decisions: Decision[];
  /** Control UI path for this approval (native kinds), relative to the Control UI origin. */
  urlPath: string | null;
  /** One line under the drawer buttons: what a decision does. */
  note: string | null;
  // native exec / plugin / system-agent details
  command?: string | null;
  cwd?: string | null;
  host?: string | null;
  security?: string | null;
  ask?: string | null;
  description?: string | null;
  detail?: string | null;
  severity?: string | null;
  pluginId?: string | null;
  decision?: Decision | null;
  // file approval details (markdown sections, rendered by the app's safe markdown)
  fileName?: string | null;
  theirWords?: string | null;
  action?: string | null;
  risk?: string | null;
  rollback?: string | null;
  dependsOn?: string | null;
  logged?: string | null;
  intro?: string | null;
  extras?: { label: string; value: string }[];
  sections?: { title: string; body: string }[];
  raw?: string | null;
}

export type ActionState = 'sending' | 'running' | 'done' | 'error' | 'dry-run';

/** What the server did with a decision. File approvals run in an agent session, so they stay "running" until it replies. */
export interface ActionRecord {
  kind: ApprovalKind;
  id: string;
  decision: Decision;
  state: ActionState;
  at: number;
  doneAt: number | null;
  title: string | null;
  sessionKey: string | null;
  reply: string | null;
  error: string | null;
}

export interface ResolveRequest {
  kind: ApprovalKind;
  id: string;
  decision: Decision;
  force?: boolean;
}

export interface ResolveResponse {
  ok: boolean;
  dryRun?: boolean;
  action: ActionRecord;
  error?: string;
}

// ---------- live state ----------

export interface ChannelHealth {
  id: string;
  label: string;
  connected: boolean;
  lifecycle: string | null;
  lastError: string | null;
  lastInboundAt: number | null;
}

export interface Health {
  ok: boolean;
  plugins: { loaded: number; errors: string[]; unavailable: string[] };
  heartbeatSeconds: number | null;
  channels: ChannelHealth[];
  agents: {
    id: string;
    isDefault: boolean;
    heartbeat: string | boolean | null;
    sessions: number | null;
  }[];
}

export interface GatewayStatus {
  version: string | null;
  wal: {
    state: string | null;
    walBytes: number | null;
    dbBytes: number | null;
    warning: string | null;
    blocked: number;
  };
  heartbeat: { id: string; enabled: boolean; every: string | null }[];
}

export interface ChannelAccounts {
  id: string;
  label: string;
  detail: string | null;
  accounts: number;
  enabled: number;
  connected: number;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
  errors: string[];
}

export interface Channels {
  eventLoop: {
    degraded: boolean;
    reasons: string[];
    p99: number | null;
    utilization: number | null;
    cpu: number | null;
  };
  channels: ChannelAccounts[];
  issues: string[];
}

export interface NodeRow {
  name: string;
  platform: string | null;
  version: string | null;
  family: string | null;
  model: string | null;
  connected: boolean;
  paired: boolean;
  lastSeenAt: number | null;
  lastConnectedAt: number | null;
  memFree: number | null;
  memTotal: number | null;
  cpus: number | null;
  caps: number | null;
}

export interface SessionRow {
  key: string;
  title: string;
  where: string;
  status: string | null;
  running: boolean;
  updatedAt: number | null;
  preview: string;
  spawnedBy: string | null;
  agent: string | null;
  model: string | null;
}

export interface CronJob {
  id: string;
  name: string;
  heartbeat: boolean;
  enabled: boolean;
  agent: string | null;
  schedule: string;
  kind: string | null;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastStatus: string | null;
  errors: number;
  lastError: string | null;
  lastDurationMs: number | null;
}

export interface Automations {
  total: number;
  enabled: number;
  heartbeats: number;
  next: CronJob[];
  failing: CronJob[];
  failingCount: number;
  failingEnabled: number;
}

export interface LimitProvider {
  id: string;
  name: string;
  plan: string | null;
  error: string | null;
  windows: { label: string; used: number | null; resetAt: number | null }[];
}

export interface TokenDay {
  date: string;
  total: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface TokenUsage {
  updatedAt: number | null;
  daily: TokenDay[];
}

export interface CalendarEvent {
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  link: string | null;
  meet: string | null;
  location: string | null;
  attendees: number;
  response: string | null;
}

export interface MailThread {
  id: string;
  from: string;
  subject: string;
  date: number | null;
  count: number;
  link: string;
}

export interface HostStats {
  mem: { total: number; available: number } | null;
  disk: { total: number; free: number } | null;
  load: number[];
  cpus: number;
  uptime: number;
  gatewayRss: number | null;
}

export interface Reply {
  id: string;
  ts: number | null;
  text: string;
}

export interface GatewayLink {
  connected: boolean;
  error: string | null;
  /** Set while a device-identity connection waits for `openclaw devices approve <requestId>`. */
  pairingRequestId: string | null;
}

/** GET /api/state?sig=…: one trimmed, read-only snapshot. `approvals.items` is omitted when `sig` still matches. */
export interface StateSnapshot {
  ok: true;
  now: number;
  dryRun: boolean;
  gateway: GatewayLink;
  approvals: {
    sig: string;
    items?: ApprovalItem[];
    counts: { open: number; gated: number; recent: number };
  };
  actions: Record<string, ActionRecord>;
  sessions: SessionRow[];
  automations: Automations | null;
  system: {
    health: Health | null;
    status: GatewayStatus | null;
    channels: Channels | null;
    nodes: NodeRow[];
  };
  usage: { limits: LimitProvider[]; tokens: TokenUsage | null };
  calendar: CalendarEvent[] | null;
  mail: MailThread[] | null;
  host: HostStats | null;
  replies: Reply[];
  errors: Record<string, string>;
}

// ---------- chat + talk ----------

export interface ChatResponse {
  answer?: string;
  error?: string;
}

export interface TalkSession {
  provider: string | null;
  transport: string;
  voiceSessionId: string;
  clientSecret: string;
  offerUrl: string | null;
  offerHeaders: Record<string, string> | null;
  model: string | null;
  voice: string | null;
  expiresAt: number | string | null;
}

/** A gateway talk.event, relayed as-is. Shapes vary by provider: {type, turnId?, final?, payload?}. */
export interface TalkEvent {
  type?: string;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface TalkEventsResponse {
  closed: boolean;
  events: { seq: number; ev: TalkEvent }[];
}
