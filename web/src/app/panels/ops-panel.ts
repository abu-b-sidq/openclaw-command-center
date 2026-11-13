import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { clip, Fmt } from '../core/fmt';
import { StateStore } from '../core/state-store';
import { Fade } from '../shared/fade';
import { Icon } from '../shared/icon';

/** The next scheduled automations and heartbeats, with their last result. */
@Component({
  selector: 'article[ccOpsPanel]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, Fade],
  host: { class: 'cc-panel', 'data-panel': 'ops' },
  template: `
    <header class="cc-ph">
      <h2><cc-icon name="bolt" /> Automations</h2>
      <span class="cc-ph-r">{{ sub() }}</span>
    </header>
    <ul class="cc-list cc-ops" ccFade>
      @if (!loaded()) {
        <li class="cc-skel"></li>
        <li class="cc-skel"></li>
      } @else {
        @for (a of rows(); track a.id) {
          <li class="cc-row" [title]="a.tip">
            <span class="ic" [style.--c]="'var(--' + a.color + ')'"
              ><cc-icon [name]="a.heartbeat ? 'pulse' : 'bolt'"
            /></span>
            <span class="tx"
              ><b>{{ a.name }}</b
              ><small>{{ a.sub }}</small></span
            >
            <span class="rt" [class]="a.cls">{{ a.right }}</span>
          </li>
        } @empty {
          <li class="cc-empty">{{ error() || 'No automations scheduled.' }}</li>
        }
      }
    </ul>
  `,
})
export class OpsPanel {
  private readonly store = inject(StateStore);
  private readonly fmt = inject(Fmt);
  protected readonly loaded = computed(() => !!this.store.state());
  protected readonly error = computed(() => {
    const e = this.store.state()?.errors['cron'];
    return e && e !== 'loading' ? `Automations unavailable: ${clip(e, 80)}` : '';
  });

  protected readonly rows = computed(() => {
    const now = Date.now(),
      f = this.fmt;
    return (this.store.state()?.automations?.next ?? []).map((a) => {
      const bad = a.lastStatus === 'error';
      return {
        id: a.id,
        heartbeat: a.heartbeat,
        name: clip(a.name, 70),
        color: bad ? 'red' : a.heartbeat ? 'purple' : 'green',
        sub: [
          a.schedule,
          a.agent && a.agent !== 'main' ? a.agent : '',
          a.nextRunAt
            ? `next ${a.nextRunAt - now < 36e5 ? f.until(a.nextRunAt) : f.when(a.nextRunAt)}`
            : '',
        ]
          .filter(Boolean)
          .join(' · '),
        right: bad ? 'failing' : a.lastStatus || '',
        cls: bad ? 'bad' : a.lastStatus === 'ok' ? 'ok' : '',
        tip: bad && a.lastError ? clip(a.lastError, 300) : '',
      };
    });
  });

  protected readonly sub = computed(() => {
    const a = this.store.state()?.automations;
    return a ? `${a.enabled} on${a.failingEnabled ? ` · ${a.failingEnabled} failing` : ''}` : '';
  });
}
