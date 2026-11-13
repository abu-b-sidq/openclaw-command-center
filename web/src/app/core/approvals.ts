import { inject, Injectable, signal } from '@angular/core';
import type { ActionRecord, ApprovalItem, Decision, ResolveResponse } from '../../../../shared/api';
import { Api } from './api';
import { clip, Fmt, plain } from './fmt';
import { LIVE, StateStore, type QueueEntry } from './state-store';
import { Toast } from './ui';

const ARM_MS = 4000;
export const DECISION_LABEL: Record<Decision, string> = {
  'allow-once': 'Allow once',
  'allow-always': 'Always allow',
  approve: 'Approve',
  deny: 'Deny',
};
const ARMED_LABEL: Record<Decision, string> = {
  'allow-once': 'Tap again to allow',
  'allow-always': 'Tap again: always',
  approve: 'Tap again to approve',
  deny: 'Tap again to deny',
};
export const KIND_LABEL: Record<string, string> = {
  exec: 'Exec',
  plugin: 'Plugin',
  'system-agent': 'System',
  file: 'Request',
};

/**
 * Approve / deny. Every decision takes two taps (arm, then confirm within 4 s), so a stray tap on a phone
 * can't approve anything.
 */
@Injectable({ providedIn: 'root' })
export class Approvals {
  private readonly api = inject(Api);
  private readonly store = inject(StateStore);
  private readonly toast = inject(Toast);
  private readonly fmt = inject(Fmt);

  /** "<kind>:<id>:<decision>" → armed until (ms). One armed button at a time. */
  readonly armed = signal<Record<string, number>>({});
  private armTimer = 0;

  isArmed(e: QueueEntry, d: Decision): boolean {
    return (this.armed()[`${e.key}:${d}`] ?? 0) > Date.now();
  }

  label(e: QueueEntry, d: Decision): string {
    return this.isArmed(e, d) ? ARMED_LABEL[d] : DECISION_LABEL[d];
  }

  /** Decisions offered on a compact card: the everyday ones. The drawer offers all of them. */
  compact(item: ApprovalItem): Decision[] {
    return item.decisions.filter((d) => d !== 'allow-always');
  }

  showButtons(e: QueueEntry): boolean {
    if (!e.item.open || !e.item.decisions.length) return false;
    const a = e.action;
    return !(a && e.item.kind !== 'file' && (a.state === 'done' || a.state === 'dry-run'));
  }

  busy(e: QueueEntry): boolean {
    return !!e.action && LIVE.has(e.action.state);
  }

  statusText(e: QueueEntry): { cls: string; text: string } | null {
    const a = e.action;
    if (!a) return null;
    const who = e.item.kind === 'file' ? 'the agent' : 'the gateway';
    const what = DECISION_LABEL[a.decision] ?? a.decision;
    switch (a.state) {
      case 'sending':
        return { cls: 'busy', text: `Sending to ${who}` };
      case 'running':
        return {
          cls: 'busy',
          text: `${what} · the agent is on it since ${this.fmt.time(a.at)} ${this.fmt.zone}`,
        };
      case 'done':
        return { cls: 'ok', text: `${what} · ${a.reply ? clip(plain(a.reply), 180) : 'done'}` };
      case 'dry-run':
        return { cls: 'dry', text: `${what} · dry run, nothing was sent` };
      case 'error':
        return { cls: 'bad', text: `Didn't go through: ${clip(a.error || 'unknown error', 170)}` };
    }
    return null;
  }

  async act(e: QueueEntry, decision: Decision): Promise<void> {
    const k = `${e.key}:${decision}`;
    clearTimeout(this.armTimer);
    if (!((this.armed()[k] ?? 0) > Date.now())) {
      this.armed.set({ [k]: Date.now() + ARM_MS });
      this.armTimer = window.setTimeout(() => this.armed.set({}), ARM_MS + 50);
      return;
    }
    this.armed.set({});
    const now = Date.now();
    const optimistic: ActionRecord = {
      kind: e.item.kind,
      id: e.item.id,
      decision,
      state: 'sending',
      at: now,
      doneAt: null,
      title: e.item.title,
      sessionKey: e.item.sessionKey,
      reply: null,
      error: null,
    };
    this.store.setPending(e.key, optimistic);
    try {
      const r = await this.api.post<ResolveResponse>('approvals/resolve', {
        kind: e.item.kind,
        id: e.item.id,
        decision,
      });
      this.store.setPending(e.key, null);
      this.store.applyAction(e.key, r.action);
      const verb = DECISION_LABEL[decision];
      this.toast.show(
        r.dryRun
          ? `Dry run: “${verb}” was recorded, nothing was sent.`
          : r.ok === false
            ? `Didn't go through: ${r.error || 'unknown error'}`
            : e.item.kind === 'file'
              ? `${verb} sent for ${e.item.id}. The agent is on it.`
              : `${verb}: done.`,
      );
    } catch (err) {
      this.store.setPending(e.key, {
        ...optimistic,
        state: 'error',
        error: (err as Error).message,
        doneAt: Date.now(),
      });
      this.toast.show((err as Error).message);
      window.setTimeout(() => {
        if (this.store.pending()[e.key]?.state === 'error') this.store.setPending(e.key, null);
      }, 10e3);
    }
    void this.store.refresh();
  }
}
