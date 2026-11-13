import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { clip, Fmt } from '../core/fmt';
import { Session } from '../core/session';
import { StateStore } from '../core/state-store';
import { Fade } from '../shared/fade';
import { Icon, type IconName } from '../shared/icon';

interface Conn {
  icon: IconName;
  color: string;
  name: string;
  sub: string;
  status: string;
  cls: string;
}

@Component({
  selector: 'article[ccConnectedPanel]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, Fade],
  host: { class: 'cc-panel', 'data-panel': 'connected' },
  template: `
    <header class="cc-ph">
      <h2><cc-icon name="plug" /> Connected</h2>
      <span class="cc-ph-r">{{ online() }} online</span>
    </header>
    <ul class="cc-list cc-conn" ccFade>
      @for (c of rows(); track c.name) {
        <li class="cc-row">
          <span class="ic" [style.--c]="'var(--' + c.color + ')'"><cc-icon [name]="c.icon" /></span>
          <span class="tx"
            ><b>{{ c.name }}</b
            ><small>{{ c.sub }}</small></span
          >
          <span class="rt" [class]="c.cls">{{ c.status }}</span>
        </li>
      } @empty {
        <li class="cc-skel"></li>
        <li class="cc-skel"></li>
        <li class="cc-skel"></li>
      }
    </ul>
  `,
})
export class ConnectedPanel {
  private readonly store = inject(StateStore);
  private readonly session = inject(Session);
  private readonly fmt = inject(Fmt);

  protected readonly rows = computed<Conn[]>(() => {
    const s = this.store.state();
    if (!s) return [];
    const f = this.fmt,
      feats = this.session.boot()?.features,
      errs = s.errors;
    const out: Conn[] = [];
    const health = new Map((s.system.health?.channels ?? []).map((c) => [c.id, c]));
    for (const c of s.system.channels?.channels ?? []) {
      const on = (c.connected || 0) >= (c.enabled || 1) && !c.errors.length;
      const last = health.get(c.id)?.lastInboundAt ?? c.lastInboundAt;
      out.push({
        icon: 'chat',
        color: on ? 'green' : 'red',
        name: c.label,
        sub: [c.detail, last ? `last in ${f.ago(last)}` : ''].filter(Boolean).join(' · '),
        status: on ? 'Online' : 'Down',
        cls: on ? 'ok' : 'bad',
      });
    }
    if (feats?.calendar) {
      const e = errs['calendar'] && errs['calendar'] !== 'loading' ? errs['calendar'] : null;
      out.push({
        icon: 'calendar',
        color: e ? 'red' : 'cyan',
        name: 'Google Calendar',
        sub: e ? clip(e, 60) : `${(s.calendar ?? []).length} upcoming`,
        status: e ? 'Error' : 'Online',
        cls: e ? 'bad' : 'ok',
      });
    }
    if (feats?.mail) {
      const e = errs['mail'] && errs['mail'] !== 'loading' ? errs['mail'] : null;
      out.push({
        icon: 'mail',
        color: e ? 'red' : 'amber',
        name: 'Gmail',
        sub: e ? clip(e, 60) : `${(s.mail ?? []).length} need a look`,
        status: e ? 'Error' : 'Online',
        cls: e ? 'bad' : 'ok',
      });
    }
    for (const n of s.system.nodes) {
      out.push({
        icon: 'phone',
        color: n.connected ? 'green' : 'purple',
        name: n.name || n.family || 'Device',
        sub: [n.platform, n.connected ? '' : `seen ${f.ago(n.lastSeenAt)}`]
          .filter(Boolean)
          .join(' · '),
        status: n.connected ? 'Online' : 'Idle',
        cls: n.connected ? 'ok' : '',
      });
    }
    const agents = s.system.health?.agents ?? [];
    if (agents.length)
      out.push({
        icon: 'layers',
        color: 'purple',
        name: 'Agents',
        sub:
          agents
            .map((a) => a.id)
            .slice(0, 5)
            .join(', ') + (agents.length > 5 ? '…' : ''),
        status: String(agents.length),
        cls: '',
      });
    return out;
  });

  protected readonly online = computed(() => this.rows().filter((x) => x.cls === 'ok').length);
}
