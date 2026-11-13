import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { clip, Fmt } from '../core/fmt';
import { sessionUrl } from '../core/links';
import { Session } from '../core/session';
import { StateStore } from '../core/state-store';
import { Fade } from '../shared/fade';
import { Icon } from '../shared/icon';

/** Sessions active in the last four hours: running first, then failing, then most recent. */
@Component({
  selector: 'article[ccActivePanel]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, Fade],
  host: { class: 'cc-panel', 'data-panel': 'active' },
  template: `
    <header class="cc-ph">
      <h2><cc-icon name="list" /> Active threads</h2>
      <span class="cc-ph-r">{{ sub() }}</span>
    </header>
    <ul class="cc-list cc-tasks" ccFade>
      @if (!loaded()) {
        <li class="cc-skel"></li>
        <li class="cc-skel"></li>
        <li class="cc-skel"></li>
      } @else {
        @for (t of rows(); track t.key) {
          <li class="cc-row" [title]="t.preview">
            <span class="ic" [style.--c]="'var(--' + t.color + ')'"
              ><cc-icon [name]="t.running ? 'spark' : t.bad ? 'alert' : 'check'"
            /></span>
            <span class="tx">
              <b>{{ t.title }}</b><small>{{ t.sub }}</small>
              <span
                class="cc-bar"
                [class.indet]="t.running"
                [style.--c]="'var(--' + t.color + ')'"
                [style.--w]="t.running ? '38%' : '100%'"
                ><i></i
              ></span>
            </span>
            @if (t.href) {
              <a
                [href]="t.href"
                target="_blank"
                rel="noopener noreferrer"
                title="Open in the Control UI"
                >{{ t.running ? 'Live' : 'Open' }}</a
              >
            }
          </li>
        } @empty {
          <li class="cc-empty">No threads in the last 4 hours.</li>
        }
      }
    </ul>
  `,
})
export class ActivePanel {
  private readonly store = inject(StateStore);
  private readonly session = inject(Session);
  private readonly fmt = inject(Fmt);
  protected readonly loaded = computed(() => !!this.store.state());

  protected readonly rows = computed(() => {
    const sessions = this.store.state()?.sessions ?? [];
    const ui = this.session.boot()?.ui.controlUiUrl;
    const bad = (status: string | null) => /fail|error/i.test(status || '');
    const order = (x: { running: boolean; status: string | null }) =>
      x.running ? 0 : bad(x.status) ? 1 : 2;
    return [...sessions]
      .sort((a, b) => order(a) - order(b) || (b.updatedAt || 0) - (a.updatedAt || 0))
      .map((x) => {
        const isBad = bad(x.status);
        return {
          key: x.key,
          running: x.running,
          bad: isBad,
          color: x.running ? 'cyan' : isBad ? 'red' : 'green',
          title: clip(x.title || x.key, 80),
          sub: [x.where, x.agent && x.agent !== 'main' ? x.agent : '', this.fmt.ago(x.updatedAt)]
            .filter(Boolean)
            .join(' · '),
          preview: x.preview,
          href: sessionUrl(ui, x.key),
        };
      });
  });

  protected readonly sub = computed(() => {
    const s = this.store.state();
    if (!s) return '';
    return `${s.sessions.filter((x) => x.running).length} running · ${s.sessions.length} in 4 h`;
  });
}
