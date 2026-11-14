import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  inject,
  untracked,
} from '@angular/core';
import { CanvasPanel } from './canvas/canvas';
import { Alerts } from './core/alerts';
import { CanvasStore } from './core/canvas';
import { Session } from './core/session';
import { StateStore } from './core/state-store';
import { Talk } from './core/talk';
import { Toast, View } from './core/ui';
import { Dashboard } from './dashboard/dashboard';
import { DrawerPanel } from './drawer/drawer';
import { Login } from './login/login';

/** The shell: splash while the bootstrap loads, then sign-in or the command center. */
@Component({
  selector: 'cc-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Dashboard, DrawerPanel, CanvasPanel, Login],
  template: `
    @if (!session.boot()) {
      <main class="cc-gate cc-splash">
        <section class="cc-gate-card" aria-live="polite">
          <span class="cc-brand"
            ><span class="cc-logo" aria-hidden="true"><i></i></span
          ></span>
          @if (session.loadError(); as err) {
            <p class="cc-gate-err">Can’t reach the command center server: {{ err }}</p>
            <button type="button" (click)="session.load()">Try again</button>
          } @else {
            <p>Connecting…</p>
          }
        </section>
      </main>
    } @else if (!session.signedIn()) {
      <cc-login />
    } @else {
      <cc-dashboard />
      <cc-drawer />
      @if (session.boot()?.features?.canvas) {
        <cc-canvas />
      }
    }
    <div class="toast" [class.show]="toast.visible()" role="status" aria-live="polite">
      {{ toast.text() }}
    </div>
  `,
})
export class App {
  protected readonly session = inject(Session);
  protected readonly toast = inject(Toast);
  private readonly store = inject(StateStore);
  private readonly talk = inject(Talk);
  private readonly alerts = inject(Alerts);
  private readonly view = inject(View);
  private readonly canvas = inject(CanvasStore);

  constructor() {
    void this.session.load();
    inject(DestroyRef).onDestroy(this.talk.attachKeys());

    // Poll live state only while signed in; signing out also hangs up.
    effect(() => {
      const on = this.session.signedIn();
      untracked(() => {
        if (on) {
          this.talk.greet();
          this.store.start();
          if (this.session.boot()?.features.canvas) this.canvas.start();
        } else {
          this.store.stop();
          this.canvas.stop();
          this.talk.end();
        }
      });
    });

    effect(() => {
      const waiting = this.store.waiting();
      if (this.store.state()) untracked(() => this.alerts.update(waiting));
    });

    // Replies that land after the page loaded are reports on delegated work: announce them.
    let seen: string | null | undefined;
    effect(() => {
      const replies = this.store.state()?.replies;
      if (!replies) return;
      const newest = replies.at(-1)?.id ?? null;
      if (seen === undefined || newest === seen) {
        seen = newest;
        return;
      }
      const i = replies.findIndex((r) => r.id === seen);
      seen = newest;
      untracked(() => {
        for (const r of i < 0 ? replies.slice(-1) : replies.slice(i + 1)) this.talk.report(r);
      });
    });

    effect(() => document.body.classList.toggle('cc-focus-voice', this.view.focusVoice()));
  }
}
