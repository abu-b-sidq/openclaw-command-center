// Decisions taken from the UI, persisted so a restart doesn't lose a file approval that's still running.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ActionRecord } from '../../shared/api.ts';

export const LIVE = new Set(['sending', 'running']);

export interface StoredAction extends ActionRecord {
  /** Message sent to the agent session (file approvals). */
  message?: string;
  runId?: string | null;
  checkedAt?: number;
}

export class ActionStore {
  private readonly file: string;
  actions: Record<string, StoredAction> = {};

  constructor(dataDir: string, dryRun: boolean) {
    this.file = join(dataDir, dryRun ? 'actions.dry.json' : 'actions.json');
    try {
      this.actions = JSON.parse(readFileSync(this.file, 'utf8')) || {};
    } catch {
      /* first run */
    }
  }

  get(key: string): StoredAction | undefined {
    return this.actions[key];
  }

  set(key: string, a: StoredAction): StoredAction {
    this.actions[key] = a;
    return a;
  }

  inflight(): number {
    return Object.values(this.actions).filter((a) => LIVE.has(a.state)).length;
  }

  /** Keep a week of history (and anything still running), newest first, at most 100. */
  save(): void {
    const cutoff = Date.now() - 7 * 86400e3;
    this.actions = Object.fromEntries(
      Object.entries(this.actions)
        .filter(([, a]) => a.at > cutoff || LIVE.has(a.state))
        .sort((x, y) => y[1].at - x[1].at)
        .slice(0, 100),
    );
    mkdirSync(join(this.file, '..'), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.actions, null, 1), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /** The wire shape: no message bodies or run ids. */
  publicList(limit = 40): Record<string, ActionRecord> {
    return Object.fromEntries(
      Object.entries(this.actions)
        .slice(0, limit)
        .map(([k, a]) => [k, toPublic(a)]),
    );
  }
}

export const toPublic = (a: StoredAction): ActionRecord => ({
  kind: a.kind,
  id: a.id,
  decision: a.decision,
  state: a.state,
  at: a.at,
  doneAt: a.doneAt ?? null,
  title: a.title ?? null,
  sessionKey: a.sessionKey ?? null,
  reply: a.reply ?? null,
  error: a.error ?? null,
});
