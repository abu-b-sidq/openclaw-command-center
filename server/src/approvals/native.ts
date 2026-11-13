// The gateway's own approval registry: exec approvals, plugin approvals and system-agent proposals.
// Pending items come from *.approval.list, closed ones from approval.history. A decision is applied with the
// matching resolve method and is first-answer-wins, exactly like the Control UI. Needs scope operator.approvals.
import type { ApprovalItem, ApprovalKind, ApprovalStatus, Decision } from '../../../shared/api.ts';
import type { Gateway } from '../gateway.ts';
import { arr, clip, num, obj, str } from '../util.ts';

type NativeKind = Exclude<ApprovalKind, 'file'>;
const ALL: Decision[] = ['allow-once', 'allow-always', 'deny'];
const LIST: [NativeKind, string][] = [
  ['exec', 'exec.approval.list'],
  ['plugin', 'plugin.approval.list'],
  ['system-agent', 'openclaw.approval.list'],
];

function decisionsOf(v: unknown, kind: NativeKind): Decision[] {
  const d = arr(v).filter((x): x is Decision => ALL.includes(x as Decision));
  if (kind === 'system-agent') return ['allow-once', 'deny'];
  return d.length ? d : ['allow-once', 'deny'];
}

const NOTES: Record<NativeKind, string> = {
  exec: 'Allow once runs this command one time. Always allow also adds it to the exec allowlist. The first answer from any operator wins.',
  plugin:
    'Your answer goes back to the plugin that asked. The first answer from any operator wins.',
  'system-agent':
    'Allow applies this system-agent proposal once. The first answer from any operator wins.',
};

export function mapPending(kind: NativeKind, raw: unknown, now = Date.now()): ApprovalItem | null {
  const a = obj(raw),
    r = obj(a['request']);
  const id = str(a['id']);
  const expiresAt = num(a['expiresAtMs']);
  if (!id || (expiresAt && expiresAt <= now)) return null;
  const createdAt = num(a['createdAtMs']);
  const agentId = str(r['agentId']),
    sessionKey = str(r['sessionKey']);
  const base: ApprovalItem = {
    kind,
    id,
    title: '',
    open: true,
    status: 'pending',
    statusLine: 'Waiting for a decision',
    gated: false,
    gatedLabel: null,
    createdAt,
    updatedAt: createdAt,
    expiresAt,
    requester: { name: agentId, detail: sessionKey },
    agentId,
    sessionKey,
    decisions: decisionsOf(r['allowedDecisions'], kind),
    urlPath: str(a['urlPath']),
    note: NOTES[kind],
  };
  if (kind === 'exec') {
    const command = str(r['command']);
    if (!command) return null;
    return {
      ...base,
      title: clip(command, 140),
      command,
      cwd: str(r['cwd']),
      host: str(r['host']),
      security: str(r['security']),
      ask: str(r['ask']),
    };
  }
  const title = str(r['title']);
  if (!title) return null;
  return {
    ...base,
    title: clip(title, 140),
    description: str(r['description']),
    detail: str(r['detail']),
    severity: str(r['severity']),
    pluginId: str(r['pluginId']),
    command: str(r['command']),
  };
}

const STATUS: Record<string, ApprovalStatus> = {
  allowed: 'done',
  denied: 'denied',
  expired: 'expired',
  cancelled: 'withdrawn',
  canceled: 'withdrawn',
};

export function mapHistory(raw: unknown): ApprovalItem | null {
  const a = obj(raw),
    p = obj(a['presentation']),
    src = obj(a['source']);
  const id = str(a['id']);
  if (!id || a['status'] === 'pending') return null;
  const kind = (
    ['exec', 'plugin', 'system-agent'].includes(String(p['kind'])) ? p['kind'] : 'exec'
  ) as NativeKind;
  const decision = ALL.includes(a['decision'] as Decision) ? (a['decision'] as Decision) : null;
  const status = STATUS[String(a['status'])] ?? 'other';
  const command = str(p['commandText']) ?? str(p['commandPreview']);
  const title = command ?? str(p['title']) ?? `Approval ${id.slice(0, 8)}`;
  const resolvedAt = num(a['resolvedAtMs']);
  const verdict =
    decision === 'allow-always'
      ? 'Always allowed'
      : decision === 'allow-once'
        ? 'Allowed once'
        : decision === 'deny'
          ? 'Denied'
          : String(a['status'] ?? 'closed');
  return {
    kind,
    id,
    title: clip(title, 140),
    open: false,
    status,
    statusLine: [verdict, str(a['reason'])].filter(Boolean).join(' · '),
    gated: false,
    gatedLabel: null,
    createdAt: num(a['createdAtMs']),
    updatedAt: resolvedAt ?? num(a['createdAtMs']),
    expiresAt: num(a['expiresAtMs']),
    requester: { name: str(src['agentId']) ?? str(p['agentId']), detail: str(src['sessionKey']) },
    agentId: str(src['agentId']) ?? str(p['agentId']),
    sessionKey: str(src['sessionKey']),
    decisions: [],
    urlPath: str(a['urlPath']),
    note: null,
    command,
    description: str(p['description']),
    detail: str(p['detail']) ?? str(p['warningText']),
    severity: str(p['severity']),
    pluginId: str(p['pluginId']),
    host: str(p['host']),
    decision,
  };
}

export async function listNative(
  gw: Gateway,
): Promise<{ pending: ApprovalItem[]; closed: ApprovalItem[] }> {
  const conn = await gw.get();
  const [lists, history] = await Promise.all([
    Promise.allSettled(LIST.map(([, method]) => conn.request(method, {}, 15000))),
    conn.request('approval.history', { limit: 12 }, 15000).catch(() => null),
  ]);
  const pending: ApprovalItem[] = [];
  let failures = 0;
  lists.forEach((r, i) => {
    if (r.status === 'rejected') return void failures++;
    for (const x of arr(r.value)) {
      const item = mapPending(LIST[i]![0], x);
      if (item) pending.push(item);
    }
  });
  if (failures === LIST.length) throw (lists[0] as PromiseRejectedResult).reason;
  const cutoff = Date.now() - 14 * 86400e3;
  const closed = arr(obj(history)['items'])
    .map(mapHistory)
    .filter((x): x is ApprovalItem => !!x && (x.updatedAt ?? 0) > cutoff);
  pending.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return { pending, closed };
}

export async function resolveNative(
  gw: Gateway,
  kind: NativeKind,
  id: string,
  decision: Decision,
): Promise<unknown> {
  if (!ALL.includes(decision)) throw new Error(`"${decision}" isn't a gateway approval decision`);
  const conn = await gw.get();
  if (kind === 'system-agent')
    return conn.request('approval.resolve', { id, kind: 'system-agent', decision }, 20000);
  return conn.request(
    kind === 'plugin' ? 'plugin.approval.resolve' : 'exec.approval.resolve',
    { id, decision },
    20000,
  );
}
