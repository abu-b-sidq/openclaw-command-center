import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Fmt } from '../core/fmt';
import { StateStore } from '../core/state-store';
import { Fade } from '../shared/fade';
import { Icon } from '../shared/icon';

const PROVIDER_COLOR: Record<string, string> = { anthropic: 'amber', openai: 'green' };

/** Provider usage windows (from the gateway's usage.status) and today's token count. */
@Component({
  selector: 'article[ccModelsPanel]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, Fade],
  host: { class: 'cc-panel', 'data-panel': 'models' },
  template: `
    <header class="cc-ph">
      <h2><cc-icon name="layers" /> Models &amp; limits</h2>
      <span class="cc-ph-r">{{ sub() }}</span>
    </header>
    <ul class="cc-list cc-models" ccFade>
      @if (!loaded()) {
        <li class="cc-skel"></li>
        <li class="cc-skel"></li>
      } @else {
        @for (l of limits(); track l.id) {
          <li class="cc-row">
            <span class="ic" [style.--c]="l.color ? 'var(--' + l.color + ')' : null"
              ><cc-icon name="layers"
            /></span>
            <span class="tx">
              <b
                >{{ l.name }}
                @if (l.plan) {
                  <small> · {{ l.plan }}</small>
                }
              </b>
              @for (w of l.windows; track w.label) {
                <span class="win">
                  {{ w.label }}
                  <span
                    class="cc-bar"
                    [style.--w]="w.width + '%'"
                    [style.--c]="'var(--' + w.color + ')'"
                    ><i></i
                  ></span>
                  <em>{{ w.used }}</em>
                </span>
              } @empty {
                <small>{{ l.error ? 'usage not reported' : 'no limits' }}</small>
              }
            </span>
            <span class="rt" [class.ok]="!l.error">{{ l.error ? '–' : 'OK' }}</span>
          </li>
        }
        @if (tokens(); as t) {
          <li class="cc-row">
            <span class="ic" style="--c: var(--cyan)"><cc-icon name="spark" /></span>
            <span class="tx"
              ><b>Tokens today · {{ t.total }}</b
              ><small>{{ t.sub }}</small></span
            >
          </li>
        }
        @if (!limits().length && !tokens()) {
          <li class="cc-empty">No usage data.</li>
        }
      }
    </ul>
  `,
})
export class ModelsPanel {
  private readonly store = inject(StateStore);
  private readonly fmt = inject(Fmt);
  protected readonly loaded = computed(() => !!this.store.state());

  protected readonly limits = computed(() =>
    (this.store.state()?.usage.limits ?? []).map((l) => ({
      id: l.id,
      name: l.name,
      plan: l.plan,
      error: l.error,
      color: l.error ? '' : (PROVIDER_COLOR[l.id] ?? 'purple'),
      windows: l.windows.map((w) => {
        const used = w.used ?? 0;
        return {
          label: w.label,
          width: Math.min(100, used),
          color: used >= 80 ? 'red' : used >= 50 ? 'amber' : 'green',
          used: w.used == null ? '–' : `${w.used}%`,
        };
      }),
    })),
  );

  protected readonly tokens = computed(() => {
    const t = this.store.state()?.usage.tokens?.daily.at(-1);
    if (!t) return null;
    return {
      total: this.fmt.num(t.total),
      sub: `${this.fmt.num(t.output)} out · ${this.fmt.pct(t.cacheRead / (t.total || 1))}% cache reads`,
    };
  });

  protected readonly sub = computed(() => {
    const l = this.store.state()?.usage.limits;
    return l ? `${l.filter((x) => !x.error).length} reporting` : '';
  });
}
