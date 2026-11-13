import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { clip, Fmt, safeUrl } from '../core/fmt';
import { StateStore } from '../core/state-store';
import { Fade } from '../shared/fade';
import { Icon, type IconName } from '../shared/icon';

interface Alert {
  icon: IconName;
  color: string;
  title: string;
  sub: string;
  right: string;
  cls: string;
  link: string;
}

@Component({
  selector: 'article[ccAlertsPanel]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, Fade],
  host: { class: 'cc-panel', 'data-panel': 'alerts' },
  template: `
    <header class="cc-ph">
      <h2><cc-icon name="alert" /> Important alerts</h2>
      <span class="cc-ph-r">{{ active() ? active() + ' active' : 'all calm' }}</span>
    </header>
    <ul class="cc-list cc-alerts" ccFade>
      @if (!loaded()) {
        <li class="cc-skel"></li>
        <li class="cc-skel"></li>
      } @else {
        @for (a of alerts(); track $index) {
          <li class="cc-row">
            <span class="ic" [style.--c]="'var(--' + a.color + ')'"
              ><cc-icon [name]="a.icon"
            /></span>
            <span class="tx"
              ><b>{{ a.title }}</b
              ><small>{{ a.sub }}</small></span
            >
            @if (a.link) {
              <a [href]="a.link" target="_blank" rel="noopener noreferrer">Open</a>
            } @else if (a.right) {
              <span class="rt" [class]="a.cls">{{ a.right }}</span>
            }
          </li>
        } @empty {
          <li class="cc-empty">No alerts. 🎉</li>
        }
      }
    </ul>
  `,
})
export class AlertsPanel {
  private readonly store = inject(StateStore);
  private readonly fmt = inject(Fmt);
  protected readonly loaded = computed(() => !!this.store.state());

  protected readonly alerts = computed<Alert[]>(() => {
    const s = this.store.state();
    if (!s) return [];
    const out: Alert[] = [];
    if (!s.gateway.connected)
      out.push({
        icon: 'alert',
        color: 'red',
        title: 'Gateway unreachable',
        sub: clip(s.gateway.error || 'Reconnecting…', 120),
        right: '',
        cls: 'bad',
        link: '',
      });
    for (const a of (s.automations?.failing ?? []).filter((x) => x.enabled))
      out.push({
        icon: 'bolt',
        color: 'red',
        title: clip(`Automation failing: ${a.name}`, 90),
        sub: clip(a.lastError || a.lastStatus, 90),
        right: `${a.errors || 0}×`,
        cls: 'bad',
        link: '',
      });
    for (const i of s.system.channels?.issues ?? [])
      out.push({
        icon: 'alert',
        color: 'amber',
        title: clip(i, 90),
        sub: '',
        right: '',
        cls: 'warn',
        link: '',
      });
    for (const r of s.system.channels?.eventLoop.reasons ?? [])
      if (s.system.channels?.eventLoop.degraded)
        out.push({
          icon: 'pulse',
          color: 'amber',
          title: clip(`Event loop: ${r}`, 90),
          sub: '',
          right: '',
          cls: 'warn',
          link: '',
        });
    for (const l of s.usage.limits)
      for (const w of l.windows)
        if ((w.used ?? 0) >= 80)
          out.push({
            icon: 'layers',
            color: 'amber',
            title: `${l.name} ${w.label} usage at ${w.used}%`,
            sub: w.resetAt ? `resets ${this.fmt.when(w.resetAt)} ${this.fmt.zone}` : '',
            right: '',
            cls: 'warn',
            link: '',
          });
    for (const m of s.mail ?? [])
      out.push({
        icon: 'mail',
        color: 'cyan',
        title: clip(`${m.from}: ${m.subject}`, 90),
        sub: [this.fmt.ago(m.date), m.count > 1 ? `${m.count} messages` : '']
          .filter(Boolean)
          .join(' · '),
        right: '',
        cls: '',
        link: safeUrl(m.link),
      });
    return out;
  });

  protected readonly active = computed(() => this.alerts().filter((a) => a.cls).length);
}
