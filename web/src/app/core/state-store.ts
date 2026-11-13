import { computed, inject, Injectable, signal } from '@angular/core';
import type { ActionRecord, ApprovalItem, Level, StateSnapshot } from '../../../../shared/api';
import { Api, ApiError } from './api';

export const LIVE = new Set(['sending', 'running']);
const RECENT_MS = 15 * 60e3;

export interface QueueEntry {
  key: string;
  item: ApprovalItem;
  action: ActionRecord | null;
  ts: number;
}

export interface HealthCheck {
  name: string;
  ok: boolean;
}

export interface HealthModel {
  checks: HealthCheck[];
  passing: number;
  failing: HealthCheck[];
  level: Level;
}

/** Waiting on the operator: open, and not already being handled (or settled by a gateway decision). */
export function waitingOnYou(e: QueueEntry): boolean {
  if (!e.item.open) return false;
  const a = e.action;
  if (!a) return true;
  if (LIVE.has(a.state)) return false;
  // A gateway approval is settled by the decision; a file approval stays open until the agent updates the file.
  return a.state === 'error' || (e.item.kind === 'file' && a.state === 'done');
}

/**
 * Live state from GET /api/state. Polls every 12 s, every 3 s while something is in flight (a decision or a
 * voice call), and every 60 s in a background tab. Approval items are re-sent only when their signature changes.
 */
@Injectable({ providedIn: 'root' })
export class StateStore {
  private readonly api = inject(Api);

  readonly state = signal<StateSnapshot | null>(null);
  readonly approvals = signal<ApprovalItem[]>([]);
  readonly error = signal<ApiError | Error | null>(null);
  readonly lastOk = signal(0);
  /** Client-side decisions not yet confirmed by the server, keyed "<kind>:<id>". */
  readonly pending = signal<Record<string, ActionRecord>>({});
  /** Set by the Talk client: poll faster while a call is live. */
  readonly talkLive = signal(false);

  private sig: string | null = null;
  private timer = 0;
  private busy = false;
  private started = false;
  private listening = false;

  readonly health = computed<HealthModel | null>(() => {
    const s = this.state();
    if (!s) return null;
    const h = s.system.health,
      st = s.system.status,
      ch = s.system.channels;
    const el = ch?.eventLoop,
      pl = h?.plugins,
      wal = st?.wal;
    const checks: HealthCheck[] = [
      { name: 'Gateway', ok: s.gateway.connected && h?.ok !== false },
      { name: 'Event loop', ok: !el?.degraded && !((el?.p99 ?? 0) > 250) },
      {
        name: 'Channels',
        ok:
          !(ch?.issues ?? []).length &&
          (ch?.channels ?? []).every((c) => (c.connected || 0) >= (c.enabled || 0)),
      },
      { name: 'Plugins', ok: !(pl?.errors ?? []).length && !(pl?.unavailable ?? []).length },
      { name: 'Database', ok: !wal?.warning && !wal?.blocked },
      { name: 'Automations', ok: !((s.automations?.failingEnabled ?? 0) > 0) },
    ];
    const failing = checks.filter((c) => !c.ok);
    const level: Level =
      !checks[0]!.ok || failing.length > 2 ? 'bad' : failing.length ? 'warn' : 'ok';
    return { checks, passing: checks.length - failing.length, failing, level };
  });

  readonly actionFor = (kind: string, id: string): ActionRecord | null =>
    this.pending()[`${kind}:${id}`] ?? this.state()?.actions[`${kind}:${id}`] ?? null;

  /** Everything that wants the operator, plus what was handled in the last 15 minutes. */
  readonly queue = computed<QueueEntry[]>(() => {
    const s = this.state();
    if (!s) return [];
    const now = Date.now();
    const out: QueueEntry[] = [];
    const seen = new Set<string>();
    for (const it of this.approvals()) {
      const key = `${it.kind}:${it.id}`;
      const a = this.actionFor(it.kind, it.id);
      if (!it.open && !(a && now - (a.doneAt || a.at) < RECENT_MS)) continue;
      seen.add(key);
      out.push({ key, item: it, action: a, ts: it.updatedAt ?? it.createdAt ?? 0 });
    }
    // A gateway approval leaves the pending list once decided; keep showing it briefly from the action record.
    const actions = { ...s.actions, ...this.pending() };
    for (const [key, a] of Object.entries(actions)) {
      if (seen.has(key) || a.kind === 'file' || now - (a.doneAt || a.at) > RECENT_MS) continue;
      const item: ApprovalItem = {
        kind: a.kind,
        id: a.id,
        title: a.title || `Approval ${a.id.slice(0, 8)}`,
        open: false,
        status: a.decision === 'deny' ? 'denied' : 'done',
        statusLine: a.reply,
        gated: false,
        gatedLabel: null,
        createdAt: a.at,
        updatedAt: a.doneAt ?? a.at,
        expiresAt: null,
        requester: { name: null, detail: a.sessionKey },
        agentId: null,
        sessionKey: a.sessionKey,
        decisions: [],
        urlPath: null,
        note: null,
      };
      out.push({ key, item, action: a, ts: a.at });
    }
    const rank = (e: QueueEntry) =>
      e.action && LIVE.has(e.action.state) ? 0 : waitingOnYou(e) ? 1 : 3;
    return out.sort((x, y) => rank(x) - rank(y) || y.ts - x.ts);
  });

  readonly waiting = computed(() => this.queue().filter(waitingOnYou));

  private inFlight(): boolean {
    if (this.talkLive()) return true;
    const live = (a: ActionRecord) => LIVE.has(a.state);
    return (
      Object.values(this.pending()).some(live) ||
      Object.values(this.state()?.actions ?? {}).some(live)
    );
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    if (!this.listening) {
      this.listening = true;
      document.addEventListener('visibilitychange', () => {
        if (this.started && !document.hidden && Date.now() - this.lastOk() > 8e3)
          void this.refresh();
      });
    }
    void this.poll();
  }

  stop(): void {
    this.started = false;
    clearTimeout(this.timer);
  }

  refresh(): Promise<void> {
    clearTimeout(this.timer);
    return this.poll();
  }

  private async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    clearTimeout(this.timer);
    try {
      const s = await this.api.get<StateSnapshot>('state', { sig: this.sig });
      if (Array.isArray(s.approvals.items)) {
        this.approvals.set(s.approvals.items);
        this.sig = s.approvals.sig;
      }
      this.state.set(s);
      this.error.set(null);
      this.lastOk.set(Date.now());
    } catch (e) {
      this.error.set(e as Error);
    }
    this.busy = false;
    if (!this.started) return;
    if (this.error() instanceof ApiError && (this.error() as ApiError).status === 401)
      return this.stop(); // signed out
    this.timer = window.setTimeout(
      () => void this.poll(),
      document.hidden ? 60e3 : this.inFlight() ? 3e3 : 12e3,
    );
  }

  /** Record an optimistic decision before the server answers. */
  setPending(key: string, a: ActionRecord | null): void {
    const next = { ...this.pending() };
    if (a) next[key] = a;
    else delete next[key];
    this.pending.set(next);
  }

  /** Merge the server's answer for one decision into the current snapshot. */
  applyAction(key: string, a: ActionRecord): void {
    const s = this.state();
    if (s) this.state.set({ ...s, actions: { ...s.actions, [key]: a } });
  }

  errorText(): string {
    const e = this.error();
    if (!e) return '';
    const status = e instanceof ApiError ? e.status : 0;
    return status === 401
      ? 'Sign in again to load live state.'
      : status === 403
        ? 'The server refused this page.'
        : 'Live state is offline. Retrying…';
  }
}
