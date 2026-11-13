import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { clip, Fmt, plain, safeUrl } from '../core/fmt';
import { Session } from '../core/session';
import { StateStore } from '../core/state-store';
import { Drawer } from '../core/ui';
import { Icon, type IconName } from '../shared/icon';

interface NowRow {
  cls: '' | 'info' | 'ok';
  icon: IconName;
  title: string;
  sub: string;
  open?: string;
  link?: { href: string; label: string };
}

/** "Right now": the few things worth doing next, in order. */
@Component({
  selector: 'article[ccNowPanel]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  host: { class: 'cc-panel', 'data-panel': 'now' },
  template: `
    <header class="cc-ph">
      <h2><cc-icon name="target" /> Right now</h2>
    </header>
    <ul class="cc-list cc-now">
      @if (!loaded()) {
        <li class="cc-skel"></li>
      } @else {
        @for (r of rows(); track $index) {
          <li class="cc-row" [class]="r.cls">
            <span class="ic"><cc-icon [name]="r.icon" /></span>
            <span class="tx"
              ><b>{{ r.title }}</b
              ><small>{{ r.sub }}</small></span
            >
            @if (r.open) {
              <button type="button" class="cc-mini" (click)="drawer.open(r.open)">
                {{ r.open === 'reports' ? 'Read' : 'Open' }}
              </button>
            } @else if (r.link) {
              <a [href]="r.link.href" target="_blank" rel="noopener noreferrer">{{
                r.link.label
              }}</a>
            }
          </li>
        }
      }
    </ul>
  `,
})
export class NowPanel {
  protected readonly drawer = inject(Drawer);
  private readonly store = inject(StateStore);
  private readonly session = inject(Session);
  private readonly fmt = inject(Fmt);
  protected readonly loaded = computed(() => !!this.store.state());

  protected readonly rows = computed<NowRow[]>(() => {
    const s = this.store.state();
    if (!s) return [];
    const f = this.fmt,
      now = Date.now(),
      zone = f.zone ? ` ${f.zone}` : '';
    const out: NowRow[] = [];
    const waiting = this.store.waiting();
    if (waiting.length)
      out.push({
        cls: '',
        icon: 'shield',
        title: `Clear ${waiting.length} waiting on you`,
        sub: clip(waiting[0]!.item.title, 70),
        open: 'queue',
      });
    const next = (s.calendar ?? [])
      .filter((e) => e.start > now - 5 * 60e3 && !e.allDay)
      .sort((a, b) => a.start - b.start)[0];
    if (next && next.start - now < 4 * 36e5) {
      const href = safeUrl(next.meet) || safeUrl(next.link);
      out.push({
        cls: 'info',
        icon: 'calendar',
        title: `${clip(next.title, 48)} ${next.start > now ? f.until(next.start) : 'now'}`,
        sub: `${f.time(next.start)}${zone}${next.meet ? ' · video call' : ''}`,
        link: href ? { href, label: next.meet ? 'Join' : 'Open' } : undefined,
      });
    }
    const failing = (s.automations?.failing ?? []).find((a) => a.enabled);
    if (failing)
      out.push({
        cls: '',
        icon: 'bolt',
        title: `Fix: ${clip(failing.name, 50)}`,
        sub: `failed ${failing.errors || 0}× · last ${f.ago(failing.lastRunAt)}`.trim(),
      });
    const running = s.sessions.filter((x) => x.running);
    if (running.length)
      out.push({
        cls: 'info',
        icon: 'spark',
        title: `${running.length} thread${running.length > 1 ? 's' : ''} running`,
        sub: clip(running[0]!.title, 70),
      });
    const last = s.replies.at(-1);
    if (last?.ts && now - last.ts < 3 * 36e5)
      out.unshift({
        cls: 'info',
        icon: 'chat',
        title: `${this.session.assistant()} · ${f.ago(last.ts)}`,
        sub: clip(plain(last.text), 90),
        open: 'reports',
      });
    if (!out.length)
      out.push({
        cls: 'ok',
        icon: 'check',
        title: 'All clear',
        sub: 'Nothing needs you right now.',
      });
    return out.slice(0, 4);
  });
}
