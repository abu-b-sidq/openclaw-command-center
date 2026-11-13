// Optional: approval requests kept as markdown files (<dir>/<YYYYMMDD>-<n>.md) that an agent writes when a
// colleague asks it for something it may only do with the operator's OK. A decision is sent to the agent as a
// chat message ("approve <id>" / "deny <id>") in its own session; the agent's own rules decide what happens.
// The parser accepts loosely hand-written files: "- **Field:** value" bullets and/or "## Section" blocks.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ApprovalItem, ApprovalStatus } from '../../../shared/api.ts';
import type { FileApprovalsConfig } from '../config.ts';
import { clip } from '../util.ts';

export const FILE_ID_RE = /^\d{8}-\d{1,3}$/;
const FIELD_RE = /^[-*]\s+(?:\*\*)?([A-Za-z][A-Za-z0-9 /()&'.-]{0,40}?)(?::\*\*|\*\*:|:)\s*(.*)$/;
const KEY_ALIASES: Record<string, string> = {
  'their words': 'theirWords',
  'their exact words': 'theirWords',
  'exact words': 'theirWords',
  words: 'theirWords',
  session: 'session',
  'session key': 'session',
  sessions: 'session',
  'requester session': 'session',
  requester: 'requester',
  'requested by': 'requester',
  logged: 'logged',
  'logged at': 'logged',
  action: 'action',
  'exact action': 'action',
  risk: 'risk',
  risks: 'risk',
  'risk / rollback': 'risk',
  'risk/rollback': 'risk',
  'risk and rollback': 'risk',
  rollback: 'rollback',
  status: 'status',
  'depends on': 'dependsOn',
  id: 'id',
};

export function statusClass(s: string): ApprovalStatus {
  const w = String(s || '')
    .replace(/^[\s*_`>]+/, '')
    .toLowerCase();
  if (/^pending/.test(w)) return 'pending';
  if (/^(partly|partially|partial)/.test(w)) return 'partial';
  if (/^(done|approved|completed?|merged|executed)/.test(w)) return 'done';
  if (/^withdrawn/.test(w)) return 'withdrawn';
  if (/^(denied|rejected|declined)/.test(w)) return 'denied';
  return 'other';
}

const plain = (s: string) =>
  String(s || '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[\s>#*-]+/gm, '')
    .replace(/^\d+[.)]\s+/gm, '')
    .trim();
const firstSentence = (s: string) =>
  clip(
    (
      plain(s)
        .split('\n')
        .find((l) => l.trim()) || ''
    )
      .replace(/^["“]+|["”]+$/g, '')
      .split(/(?<=[.!?])\s/)[0],
    110,
  );
// An action written as numbered steps opens with step 1, which makes a poor title; the request reads better.
const isStepList = (s: string | null) => /^\s*(?:\*\*)?1[.)]\s/.test(String(s || ''));

export function parseApproval(
  id: string,
  raw: string,
  mtime: number,
  cfg: Pick<FileApprovalsConfig, 'gatedPattern' | 'gatedLabel' | 'approveNote' | 'gatedNote'>,
): ApprovalItem {
  const lines = raw.replace(/\r/g, '').split('\n');
  let h1 = '';
  let cur: { title: string; body: string[] } | null = null;
  let prevBlank = false;
  const fields: { label: string; value: string }[] = [];
  const sections: { title: string; body: string[] }[] = [];
  const intro: string[] = [];
  for (const line of lines) {
    const h = /^(#{1,2})\s+(.*?)\s*$/.exec(line);
    if (h && h[1] === '#' && !h1 && !cur) {
      h1 = h[2]!;
      prevBlank = false;
      continue;
    }
    if (h && h[1] === '##') {
      cur = { title: h[2]!.replace(/\*\*/g, '').trim(), body: [] };
      sections.push(cur);
      continue;
    }
    if (cur) {
      cur.body.push(line);
      continue;
    }
    const blank = !line.trim();
    const f = FIELD_RE.exec(line);
    if (f) fields.push({ label: f[1]!.trim(), value: f[2]! });
    else if (!blank && fields.length && (/^\s/.test(line) || /^[-*]\s/.test(line) || !prevBlank))
      fields[fields.length - 1]!.value += `\n${line}`;
    else if (!blank) intro.push(line);
    prevBlank = blank;
  }
  const known: Record<string, string> = {};
  const extras: { label: string; value: string }[] = [];
  for (const { label, value } of fields) {
    const k = KEY_ALIASES[label.toLowerCase().replace(/\s+/g, ' ')];
    if (k && !(k in known)) known[k] = value.trim();
    else extras.push({ label, value: value.trim() });
  }
  const used = new Set<object>();
  const fromSection = (re: RegExp) => {
    const s = sections.find((x) => !used.has(x) && re.test(x.title));
    if (!s) return null;
    used.add(s);
    return s.body.join('\n').trim();
  };
  const action = known['action'] || fromSection(/^(exact )?action\b/i) || null;
  const theirWords = known['theirWords'] || fromSection(/their (exact )?words/i);
  const risk = known['risk'] || fromSection(/risk|cost/i);
  const rollback = known['rollback'] || fromSection(/^rollback/i);
  const status = (known['status'] || fromSection(/^status\b/i) || '').replace(/\*\*/g, '').trim();
  const statusLine = clip(status.split('\n')[0], 200);
  const cls = statusClass(status);
  const requesterText = (known['requester'] || '').replace(/\*\*/g, '');
  const session = ((known['session'] || '').replace(/[`*]/g, '').match(/agent:[\w:.-]+/) ||
    requesterText.match(/agent:[\w:.-]+/) || [known['session'] || null])[0];
  let title = plain(h1.replace(/^approval\s+/i, '').replace(id, ''))
    .replace(/^[\s—–:|·-]+/, '')
    .trim();
  if (!title)
    title =
      firstSentence(
        isStepList(action) ? theirWords || action || '' : action || theirWords || intro.join(' '),
      ) || `Approval ${id}`;
  title = title.replace(/\s*:$/, '');
  title = title.charAt(0).toUpperCase() + title.slice(1);
  const open = cls === 'pending' || cls === 'partial';
  const gated = open && !!cfg.gatedPattern && new RegExp(cfg.gatedPattern, 'i').test(status);
  const fill = (t: string) => t.replaceAll('{id}', id);
  return {
    kind: 'file',
    id,
    title: clip(title, 140),
    open,
    status: cls,
    statusLine,
    gated,
    gatedLabel: gated ? cfg.gatedLabel : null,
    createdAt: null,
    updatedAt: mtime,
    expiresAt: null,
    requester: {
      name: clip(plain(requesterText.split(/[(,<]/)[0] ?? ''), 60) || null,
      detail: requesterText || null,
    },
    agentId: session ? (session.split(':')[1] ?? null) : null,
    sessionKey: session,
    decisions: open ? ['approve', 'deny'] : [],
    urlPath: null,
    note: open ? fill(gated ? cfg.gatedNote : cfg.approveNote) : null,
    fileName: `${id}.md`,
    theirWords: theirWords || null,
    action,
    risk: risk || null,
    rollback: rollback || null,
    dependsOn: known['dependsOn'] || null,
    logged: known['logged'] ? plain(known['logged']) : null,
    extras: extras.map((e) => ({ label: e.label, value: e.value.slice(0, 3000) })),
    intro: intro.join('\n').slice(0, 3000) || null,
    sections: sections
      .filter((s) => !used.has(s))
      .map((s) => ({ title: s.title, body: s.body.join('\n').trim().slice(0, 8000) })),
    raw: open ? raw.slice(0, 20000) : null, // the "show the file" fallback, open items only
  };
}

const idOrder = (a: ApprovalItem, b: ApprovalItem) => {
  const [ad = '', an = '0'] = a.id.split('-'),
    [bd = '', bn = '0'] = b.id.split('-');
  return bd.localeCompare(ad) || Number(bn) - Number(an);
};

export class FileApprovals {
  private readonly parsed = new Map<string, { mtime: number; item: ApprovalItem }>();
  private readonly cfg: FileApprovalsConfig;

  constructor(cfg: FileApprovalsConfig) {
    this.cfg = cfg;
  }

  read(id: string): ApprovalItem | null {
    if (!FILE_ID_RE.test(id)) return null;
    try {
      const p = join(this.cfg.dir, `${id}.md`);
      const st = statSync(p);
      return parseApproval(id, readFileSync(p, 'utf8').slice(0, 40000), st.mtimeMs, this.cfg);
    } catch {
      return null;
    }
  }

  /** Open requests first (newest id first), then up to 12 closed in the last 14 days. */
  list(): ApprovalItem[] {
    let files: string[] = [];
    try {
      files = readdirSync(this.cfg.dir).filter(
        (f) => FILE_ID_RE.test(f.slice(0, -3)) && f.endsWith('.md'),
      );
    } catch {
      return [];
    }
    const items: ApprovalItem[] = [];
    for (const f of files) {
      try {
        const st = statSync(join(this.cfg.dir, f));
        let c = this.parsed.get(f);
        if (!c || c.mtime !== st.mtimeMs) {
          c = {
            mtime: st.mtimeMs,
            item: parseApproval(
              f.slice(0, -3),
              readFileSync(join(this.cfg.dir, f), 'utf8').slice(0, 40000),
              st.mtimeMs,
              this.cfg,
            ),
          };
          this.parsed.set(f, c);
        }
        items.push(c.item);
      } catch {
        /* unreadable or mid-write: skip this round */
      }
    }
    const open = items.filter((a) => a.open).sort(idOrder);
    const recent = items
      .filter((a) => !a.open && Date.now() - (a.updatedAt ?? 0) < 14 * 86400e3)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, 12);
    return [...open, ...recent];
  }
}
