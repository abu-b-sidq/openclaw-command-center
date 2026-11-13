import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
} from '@angular/core';
import { Alerts } from '../core/alerts';
import { StateStore } from '../core/state-store';
import { Drawer } from '../core/ui';
import { ApprovalRow } from '../shared/approval-row';
import { Fade } from '../shared/fade';
import { Icon } from '../shared/icon';

/** "Needs you": every open approval with two-tap buttons, plus what was decided in the last 15 minutes. */
@Component({
  selector: 'aside[ccQueueCard]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ApprovalRow, Fade, Icon],
  host: {
    class: 'cc-panel live-queue',
    'aria-label': 'Waiting on you',
    '[class.calm]': 'loaded() && !waiting()',
  },
  template: `
    <div class="lq-head">
      <span class="eyebrow"><cc-icon name="shield" /> Needs you</span>
      <span class="lq-head-r">
        @if (alerts.supported) {
          <button
            type="button"
            class="lq-bell"
            [attr.aria-pressed]="alerts.enabled()"
            [title]="bellTitle()"
            (click)="alerts.toggle()"
          >
            {{ alerts.enabled() ? 'Alerts on' : 'Alerts off' }}
          </button>
        }
        <b>{{ loaded() ? waiting() : '…' }}</b>
      </span>
    </div>
    <div class="lq-list" ccFade>
      @if (!loaded()) {
        <p class="lq-empty">{{ store.error() ? store.errorText() : 'Loading live state…' }}</p>
      } @else {
        @for (e of store.queue(); track e.key) {
          <cc-approval-row [entry]="e" />
        } @empty {
          <p class="lq-empty">Nothing is waiting on you. Enjoy it. 🎉</p>
        }
      }
    </div>
    <button type="button" class="lq-all" (click)="drawer.open('queue')">Open the queue</button>
  `,
})
export class QueueCard {
  protected readonly store = inject(StateStore);
  protected readonly alerts = inject(Alerts);
  protected readonly drawer = inject(Drawer);
  protected readonly loaded = computed(() => !!this.store.state());
  protected readonly waiting = computed(() => this.store.waiting().length);
  protected readonly bellTitle = computed(() =>
    this.alerts.enabled()
      ? 'Desktop alert when something new needs you and this tab is in the background'
      : 'Get a desktop alert when something new needs you',
  );

  constructor() {
    const el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    let first = true;
    // Replay the ping animation on every new arrival.
    effect(() => {
      this.alerts.ping();
      if (first) {
        first = false;
        return;
      }
      el.classList.remove('ping');
      void el.offsetWidth;
      el.classList.add('ping');
    });
  }
}
