import { inject, Injectable, signal } from '@angular/core';
import { clip } from './fmt';
import { Session } from './session';
import { type QueueEntry } from './state-store';
import { Drawer, Toast } from './ui';

/**
 * "Something new needs you": a toast, a ping on the card, the count in the tab title and, when the operator
 * opted in and the tab is in the background, a desktop notification.
 */
@Injectable({ providedIn: 'root' })
export class Alerts {
  private readonly toast = inject(Toast);
  private readonly drawer = inject(Drawer);
  private readonly session = inject(Session);

  readonly supported = 'Notification' in window;
  readonly enabled = signal(this.readEnabled());
  /** Bumped on every new arrival; the Needs-you card replays its ping animation. */
  readonly ping = signal(0);
  private known: Set<string> | null = null;

  private readEnabled(): boolean {
    try {
      return (
        this.supported &&
        Notification.permission === 'granted' &&
        localStorage.getItem('occ-alerts') !== 'off'
      );
    } catch {
      return false;
    }
  }

  async toggle(): Promise<void> {
    if (!this.supported) return;
    if (Notification.permission === 'denied') {
      this.toast.show('Alerts are blocked for this site in your browser settings.');
      return;
    }
    try {
      if (Notification.permission !== 'granted') {
        if ((await Notification.requestPermission()) === 'granted')
          localStorage.setItem('occ-alerts', 'on');
      } else
        localStorage.setItem(
          'occ-alerts',
          localStorage.getItem('occ-alerts') === 'off' ? 'on' : 'off',
        );
    } catch {
      /* storage blocked */
    }
    this.enabled.set(this.readEnabled());
  }

  /** Called with the current waiting list after every state update. */
  update(waiting: QueueEntry[]): void {
    const base = `${this.session.assistant()} · Command Center`;
    document.title = (waiting.length ? `(${waiting.length}) ` : '') + base;
    const keys = new Set(waiting.map((x) => x.key));
    const fresh = this.known ? waiting.filter((x) => !x.action && !this.known!.has(x.key)) : [];
    this.known = keys;
    if (!fresh.length) return;
    const x = fresh[0]!;
    const who = x.item.requester.name ? ` from ${x.item.requester.name.split(/\s+/)[0]}` : '';
    const msg = `New approval${who}: ${clip(x.item.title, 80)}${fresh.length > 1 ? ` (+${fresh.length - 1} more)` : ''}`;
    this.toast.show(msg);
    this.ping.update((n) => n + 1);
    if (document.hidden && this.enabled()) {
      try {
        const n = new Notification(`${this.session.assistant()} · needs you`, {
          body: msg,
          tag: `occ-${x.key}`,
        });
        n.onclick = () => {
          window.focus();
          this.drawer.open(x.key);
          n.close();
        };
      } catch {
        /* notifications unavailable */
      }
    }
  }
}
