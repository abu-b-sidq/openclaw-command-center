// The live snapshot behind GET /api/state, and approval decisions (POST /api/approvals/resolve).
import { createHash, randomUUID } from 'node:crypto';
import type {
  ApprovalItem,
  ApprovalKind,
  Decision,
  ResolveRequest,
  ResolveResponse,
  StateSnapshot,
} from '../../shared/api.ts';
import { ActionStore, LIVE, toPublic, type StoredAction } from './actions.ts';
import { FILE_ID_RE, FileApprovals } from './approvals/files.ts';
import { listNative, resolveNative } from './approvals/native.ts';
import type { Config } from './config.ts';
import { waitForRun, type Connection, type Gateway } from './gateway.ts';
import { hostStats } from './host.ts';
import { calendar, mail } from './integrations/google.ts';
import {
  extractReplies,
  trimChannels,
  trimCost,
  trimCron,
  trimHealth,
  trimLimits,
  trimNodes,
  trimSessions,
  trimStatus,
} from './trim.ts';
import { clip, fail, isError, isLoading, log, obj, stamp, SwrCache, textOf, tsOf } from './util.ts';

const MAX_INFLIGHT = 3;
const NATIVE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const VERDICT: Record<Decision, string> = {
  'allow-once': 'Allowed once',
  'allow-always': 'Always allowed',
  approve: 'Approved',
  deny: 'Denied',
};

export class StateService {
  private readonly cache = new SwrCache();
  private readonly actions: ActionStore;
  private readonly files: FileApprovals | null;
  private readonly tracked = new Map<string, { conn: Connection; off: () => void }>();
  private channelLabels: Record<string, string> = {};
  private readonly cfg: Config;
  private readonly gw: Gateway;
  private readonly assistantName: () => string;

  constructor(cfg: Config, gw: Gateway, assistantName: () => string) {
    this.cfg = cfg;
    this.gw = gw;
    this.assistantName = assistantName;
    this.actions = new ActionStore(cfg.server.dataDir, cfg.server.dryRun);
    this.files = cfg.approvals.files.enabled ? new FileApprovals(cfg.approvals.files) : null;
  }

  private req<T = any>(method: string, params: unknown = {}, timeout = 20000): Promise<T> {
    return this.gw.request<T>(method, params, timeout);
  }

  private sources() {
    const c = this.cache,
      cfg = this.cfg,
      g = cfg.integrations.google;
    const talkKey = cfg.assistant.sessionKey;
    const src: Record<string, () => Promise<unknown>> = {
      health: () =>
        c.get('health', 60e3, async () => {
          const h = trimHealth(await this.req('health'));
          this.channelLabels = Object.fromEntries(h.channels.map((x) => [x.id, x.label]));
          return h;
        }),
      status: () => c.get('status', 60e3, async () => trimStatus(await this.req('status'))),
      limits: () =>
        c.get('limits', 3 * 60e3, async () => trimLimits(await this.req('usage.status'))),
      tokens: () =>
        c.get('tokens', 5 * 60e3, async () => trimCost(await this.req('usage.cost', {}, 30000))),
      sessions: () =>
        c.get('sessions', 10e3, async () =>
          trimSessions(
            await this.req('sessions.list', {
              activeMinutes: 240,
              limit: 60,
              includeDerivedTitles: true,
              includeLastMessage: true,
            }),
            {
              talkSessionKey: talkKey,
              assistantName: this.assistantName(),
              approvalPrefix: this.files ? cfg.approvals.files.sessionKeyPrefix : null,
              channelLabels: this.channelLabels,
            },
          ),
        ),
      cron: () =>
        c.get('cron', 60e3, async () =>
          trimCron(await this.req('cron.list', { includeDisabled: true, limit: 200 })),
        ),
      channels: () =>
        c.get('channels', 15e3, async () => trimChannels(await this.req('channels.status'))),
      nodes: () => c.get('nodes', 30e3, async () => trimNodes(await this.req('node.list'))),
      replies: () =>
        c.get('replies', 4e3, async () =>
          extractReplies(
            obj(await this.req('chat.history', { sessionKey: talkKey, limit: 60 }))['messages'],
          ),
        ),
    };
    if (cfg.approvals.native.enabled)
      src['native'] = () => c.get('native', 5e3, () => listNative(this.gw));
    if (g.enabled && g.calendar)
      src['calendar'] = () => c.get('calendar', 5 * 60e3, () => calendar(g, cfg.ui.timeZone), 8000);
    if (g.enabled && g.mail) src['mail'] = () => c.get('mail', 5 * 60e3, () => mail(g), 8000);
    if (cfg.host.enabled) src['host'] = () => c.get('host', 15e3, hostStats);
    return src;
  }

  async snapshot(approvalsSig: string | null): Promise<StateSnapshot> {
    this.sweep().catch(() => {});
    const src = this.sources();
    const keys = Object.keys(src);
    const vals = await Promise.all(
      keys.map((k) => src[k]!().catch((e: Error) => ({ error: e.message }))),
    );
    const v: Record<string, any> = Object.fromEntries(keys.map((k, i) => [k, vals[i]]));
    const errors: Record<string, string> = {};
    for (const k of keys) {
      if (isError(v[k])) errors[k] = v[k].error;
      else if (isLoading(v[k])) errors[k] = 'loading';
    }
    const ok = (x: unknown) => x !== undefined && !isError(x) && !isLoading(x);

    const native = ok(v['native'])
      ? (v['native'] as { pending: ApprovalItem[]; closed: ApprovalItem[] })
      : { pending: [], closed: [] };
    const fileItems = this.files ? this.files.list() : [];
    const items = [
      ...native.pending,
      ...fileItems.filter((a) => a.open),
      ...[...fileItems.filter((a) => !a.open), ...native.closed].sort(
        (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
      ),
    ];
    const sig = createHash('sha1')
      .update(items.map((a) => `${a.kind}:${a.id}:${a.updatedAt}:${a.status}`).join('|'))
      .digest('hex')
      .slice(0, 16);
    const open = items.filter((a) => a.open);

    return {
      ok: true,
      now: Date.now(),
      dryRun: this.cfg.server.dryRun,
      gateway: {
        connected: this.gw.status.connected,
        error: this.gw.status.error,
        pairingRequestId: this.gw.status.pairingRequestId,
      },
      approvals: {
        sig,
        items: approvalsSig === sig ? undefined : items,
        counts: {
          open: open.length,
          gated: open.filter((a) => a.gated).length,
          recent: items.length - open.length,
        },
      },
      actions: this.actions.publicList(),
      sessions: ok(v['sessions']) ? v['sessions'] : [],
      automations: ok(v['cron']) ? v['cron'] : null,
      system: {
        health: ok(v['health']) ? v['health'] : null,
        status: ok(v['status']) ? v['status'] : null,
        channels: ok(v['channels']) ? v['channels'] : null,
        nodes: ok(v['nodes']) ? v['nodes'] : [],
      },
      usage: {
        limits: ok(v['limits']) ? v['limits'] : [],
        tokens: ok(v['tokens']) ? v['tokens'] : null,
      },
      calendar: ok(v['calendar']) ? v['calendar'] : null,
      mail: ok(v['mail']) ? v['mail'] : null,
      host: ok(v['host']) ? v['host'] : null,
      replies: Array.isArray(v['replies']) ? v['replies'] : [],
      errors,
    };
  }

  // ---------------- decisions ----------------

  async resolve(b: Partial<ResolveRequest>): Promise<ResolveResponse> {
    const kind = b.kind as ApprovalKind,
      id = String(b.id ?? ''),
      decision = b.decision as Decision;
    if (!['exec', 'plugin', 'system-agent', 'file'].includes(kind))
      throw fail(400, 'unknown approval kind');
    if (!['allow-once', 'allow-always', 'approve', 'deny'].includes(decision))
      throw fail(400, 'unknown decision');
    const key = `${kind}:${id}`,
      prev = this.actions.get(key);
    if (prev && LIVE.has(prev.state)) throw fail(409, `${id} is already being handled`);
    return kind === 'file'
      ? this.resolveFile(id, decision, key, prev, !!b.force)
      : this.resolveNativeItem(kind, id, decision, key);
  }

  private async resolveNativeItem(
    kind: Exclude<ApprovalKind, 'file'>,
    id: string,
    decision: Decision,
    key: string,
  ): Promise<ResolveResponse> {
    if (!this.cfg.approvals.native.enabled) throw fail(404, 'Gateway approvals are turned off');
    if (!NATIVE_ID_RE.test(id)) throw fail(400, 'bad approval id');
    this.cache.drop('native');
    const list = await listNative(this.gw).catch((e: Error) => {
      throw fail(503, `Couldn't read approvals from the gateway: ${e.message}`);
    });
    const item = list.pending.find((x) => x.kind === kind && x.id === id);
    if (!item)
      throw fail(404, 'That approval isn’t pending any more (answered elsewhere, or expired)');
    if (!item.decisions.includes(decision))
      throw fail(400, `“${decision}” isn’t allowed for this approval`);
    const a = this.actions.set(key, {
      kind,
      id,
      decision,
      state: 'sending',
      at: Date.now(),
      doneAt: null,
      title: item.title,
      sessionKey: item.sessionKey,
      reply: null,
      error: null,
    });
    if (this.cfg.server.dryRun) {
      Object.assign(a, { state: 'dry-run', doneAt: Date.now() });
      this.actions.save();
      return { ok: true, dryRun: true, action: toPublic(a) };
    }
    try {
      await resolveNative(this.gw, kind, id, decision);
      Object.assign(a, { state: 'done', doneAt: Date.now(), reply: VERDICT[decision] });
      log('approval', kind, id, decision);
    } catch (e) {
      Object.assign(a, {
        state: 'error',
        doneAt: Date.now(),
        error: clip((e as Error).message, 300),
      });
    }
    this.cache.drop('native');
    this.actions.save();
    return { ok: a.state !== 'error', action: toPublic(a), ...(a.error ? { error: a.error } : {}) };
  }

  private async resolveFile(
    id: string,
    decision: Decision,
    key: string,
    prev: StoredAction | undefined,
    force: boolean,
  ): Promise<ResolveResponse> {
    const f = this.cfg.approvals.files;
    if (!this.files) throw fail(404, 'File approvals are turned off');
    if (!FILE_ID_RE.test(id)) throw fail(400, 'bad approval id');
    if (decision !== 'approve' && decision !== 'deny')
      throw fail(400, 'decision must be approve or deny');
    const item = this.files.read(id);
    if (!item) throw fail(404, `No approval ${id}`);
    if (!item.open) throw fail(409, `${id} is already ${item.statusLine || item.status}`);
    if (
      prev?.state === 'done' &&
      prev.decision === 'approve' &&
      Date.now() - (prev.doneAt || prev.at) < 10 * 60e3 &&
      !force
    )
      throw fail(
        409,
        `A run for ${id} finished under 10 minutes ago and the file still says ${item.status}. Read its reply first.`,
      );
    if (this.actions.inflight() >= MAX_INFLIGHT)
      throw fail(429, 'Three actions are already running. Give them a minute.');
    const vars: Record<string, string> = {
      id,
      decision,
      operator: this.cfg.operator.name,
      time: stamp(this.cfg.ui.timeZone),
      file: `approvals/${id}.md`,
      gateNote: item.gated ? f.gatedMessageNote : '',
    };
    const message = (decision === 'deny' ? f.denyMessage : f.approveMessage).replace(
      /\{(\w+)\}/g,
      (m, k: string) => vars[k] ?? m,
    );
    const a = this.actions.set(key, {
      kind: 'file',
      id,
      decision,
      state: 'sending',
      at: Date.now(),
      doneAt: null,
      title: item.title,
      sessionKey: `${f.sessionKeyPrefix}${id}`,
      reply: null,
      error: null,
      message,
    });
    log('approval', 'file', id, decision, this.cfg.server.dryRun ? '(dry run)' : '');
    return this.send(a);
  }

  private async send(a: StoredAction): Promise<ResolveResponse> {
    if (this.cfg.server.dryRun) {
      Object.assign(a, { state: 'dry-run', doneAt: Date.now() });
      this.actions.save();
      return { ok: true, dryRun: true, action: toPublic(a) };
    }
    this.actions.save();
    try {
      const conn = await this.gw.get();
      const r = obj(
        await conn.request(
          'chat.send',
          { sessionKey: a.sessionKey, message: a.message, idempotencyKey: randomUUID() },
          30000,
        ),
      );
      a.runId = typeof r['runId'] === 'string' ? r['runId'] : null;
      if (a.runId) {
        a.state = 'running';
        this.track(conn, a);
      } else
        Object.assign(a, {
          state: 'done',
          doneAt: Date.now(),
          reply: textOf(r['message']) || null,
        });
    } catch (e) {
      Object.assign(a, {
        state: 'error',
        doneAt: Date.now(),
        error: clip((e as Error).message, 300),
      });
    }
    this.actions.save();
    return { ok: a.state !== 'error', action: toPublic(a), ...(a.error ? { error: a.error } : {}) };
  }

  private finish(
    a: StoredAction,
    state: 'done' | 'error',
    reply: string | null,
    error?: string,
  ): void {
    if (!LIVE.has(a.state)) return;
    const t = a.runId ? this.tracked.get(a.runId) : undefined;
    if (t) {
      t.off();
      this.tracked.delete(a.runId!);
    }
    a.state = state;
    a.doneAt = Date.now();
    if (reply) a.reply = String(reply).slice(0, 4000);
    if (error) a.error = clip(error, 300);
    this.cache.drop('sessions');
    this.actions.save();
    log('action', a.kind, a.id, state);
  }

  private track(conn: Connection, a: StoredAction): void {
    if (!a.runId) return;
    this.tracked.get(a.runId)?.off();
    const off = conn.addListener((f) => {
      const p = f.payload;
      if (f.event !== 'chat' || !p || p['runId'] !== a.runId) return;
      if (p['state'] === 'final') {
        const text = textOf(p['message']);
        if (text) this.finish(a, 'done', text);
        else setTimeout(() => this.reconcile(a, true).catch(() => {}), 1500); // no text on the event: read it back
      } else if (p['state'] === 'aborted') this.finish(a, 'error', null, 'aborted');
      else if (p['state'] === 'error')
        this.finish(a, 'error', null, p['errorMessage'] || 'run failed');
    });
    this.tracked.set(a.runId, { conn, off });
  }

  /** Lost the live event (restart, reconnect, missed final)? Read the session back instead. */
  private async reconcile(a: StoredAction, afterFinal = false): Promise<void> {
    if (!LIVE.has(a.state) || (!afterFinal && Date.now() - (a.checkedAt || 0) < 8000)) return;
    a.checkedAt = Date.now();
    if (!afterFinal) {
      this.cache.drop('sessions');
      const list = await this.sources()['sessions']!();
      const s = Array.isArray(list)
        ? list.find((x: { key: string }) => x.key === a.sessionKey)
        : null;
      if (s?.running) {
        const conn = await this.gw.get();
        if (a.runId && this.tracked.get(a.runId)?.conn !== conn) this.track(conn, a);
        return;
      }
    }
    const h = await this.req('chat.history', { sessionKey: a.sessionKey, limit: 60 }, 15000).catch(
      () => null,
    );
    const msgs: any[] = Array.isArray(obj(h)['messages']) ? (obj(h)['messages'] as any[]) : [];
    let reply = '';
    for (let i = msgs.length - 1; i >= 0 && !reply; i--) {
      const m = msgs[i];
      if (m?.role !== 'assistant') continue;
      const rid = m.__openclaw?.runId || m.runId;
      if (rid ? rid === a.runId : tsOf(m.timestamp) >= a.at - 2000) reply = textOf(m);
    }
    if (reply) this.finish(a, 'done', reply);
    else if (afterFinal) this.finish(a, 'done', 'Finished with no text reply.');
    else if (Date.now() - a.at > 3 * 60e3)
      this.finish(a, 'error', null, 'No reply found; check the session in the Control UI.');
  }

  private async sweep(): Promise<void> {
    const live = Object.values(this.actions.actions).filter((a) => LIVE.has(a.state));
    if (!live.length) return;
    const conn = await this.gw.get().catch(() => null);
    for (const a of live) {
      const listening = !!a.runId && !!conn && this.tracked.get(a.runId)?.conn === conn;
      if (!listening || Date.now() - a.at > 45e3) this.reconcile(a).catch(() => {});
    }
  }
}
