import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Fmt } from '../core/fmt';
import { Session } from '../core/session';
import { StateStore } from '../core/state-store';
import { Talk } from '../core/talk';
import { Icon, type IconName } from '../shared/icon';

interface Diag {
  icon: IconName;
  color: string;
  label: string;
  value: string;
  sub: string;
}

/** The orb (tap to talk) with eight live diagnostics around it. */
@Component({
  selector: 'article[ccCorePanel]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  host: { class: 'cc-panel cc-core', 'data-panel': 'core' },
  template: `
    <header class="cc-core-head">
      <h1>{{ name() }} core</h1>
      <small>System diagnostics</small>
    </header>
    <ul class="cc-diag cc-diag-l">
      @for (d of left(); track d.label) {
        <li [style.--c]="'var(--' + d.color + ')'">
          <span class="ic"><cc-icon [name]="d.icon" /></span>
          <span class="tx"
            ><small>{{ d.label }}</small
            ><b>{{ d.value }}</b
            ><em>{{ d.sub }}</em></span
          >
        </li>
      }
    </ul>
    <div class="cc-orb-wrap">
      <div
        class="cc-orb"
        role="button"
        tabindex="0"
        [attr.aria-label]="orbLabel()"
        [attr.aria-pressed]="talkOn() ? talk.active() : null"
        (click)="orb()"
        (keydown.enter)="orb()"
      >
        <span class="cc-ring-a"></span><span class="cc-ring-b"></span
        ><span class="cc-ring-c"></span>
        <span class="cc-sats" aria-hidden="true">
          <i style="--n: 0; --c: var(--purple)"></i><i style="--n: 1; --c: var(--cyan)"></i
          ><i style="--n: 2; --c: var(--amber)"></i><i style="--n: 3; --c: var(--green)"></i>
        </span>
        <span class="orb-shell"></span>
        <span class="cc-orb-label"
          ><b>{{ name() }}</b
          ><small>AI core</small><em>{{ version() }}</em></span
        >
      </div>
    </div>
    <ul class="cc-diag cc-diag-r">
      @for (d of right(); track d.label) {
        <li [style.--c]="'var(--' + d.color + ')'">
          <span class="ic"><cc-icon [name]="d.icon" /></span>
          <span class="tx"
            ><small>{{ d.label }}</small
            ><b>{{ d.value }}</b
            ><em>{{ d.sub }}</em></span
          >
        </li>
      }
    </ul>
    <footer class="cc-core-foot">
      <span
        >Status <b [class]="status().cls">{{ status().text }}</b></span
      >
      <span>{{ note() }}</span>
    </footer>
  `,
})
export class CorePanel {
  protected readonly talk = inject(Talk);
  private readonly session = inject(Session);
  private readonly store = inject(StateStore);
  private readonly fmt = inject(Fmt);

  protected readonly name = this.session.assistant;
  protected readonly talkOn = computed(() => !!this.session.boot()?.features.talk);
  protected readonly orbLabel = computed(() =>
    !this.talkOn()
      ? `Message ${this.name()}`
      : this.talk.active()
        ? 'End the call'
        : `Tap to talk to ${this.name()}`,
  );
  protected readonly version = computed(() => {
    const v = this.store.state()?.system.status?.version;
    return v ? `v${v}` : '';
  });

  protected readonly left = computed<Diag[]>(() => {
    const s = this.store.state();
    if (!s) return [];
    const agents = s.system.health?.agents ?? [],
      auto = s.automations,
      running = s.sessions.filter((x) => x.running).length;
    const c = s.approvals.counts,
      waiting = this.store.waiting().length;
    return [
      {
        icon: 'layers',
        color: 'purple',
        label: 'Agents',
        value: String(agents.length),
        sub: `${agents.filter((a) => a.heartbeat).length} on heartbeat`,
      },
      {
        icon: 'list',
        color: 'cyan',
        label: 'Threads · 4 h',
        value: String(s.sessions.length),
        sub: running ? `${running} running now` : 'none running',
      },
      {
        icon: 'shield',
        color: 'amber',
        label: 'Needs you',
        value: String(waiting),
        sub: [c.gated ? `${c.gated} gated` : '', `${c.open} open`].filter(Boolean).join(' · '),
      },
      {
        icon: 'bolt',
        color: 'green',
        label: 'Automations',
        value: auto ? `${auto.enabled}/${auto.total}` : '–',
        sub: auto?.failingEnabled ? `${auto.failingEnabled} failing` : 'all healthy',
      },
    ];
  });

  protected readonly right = computed<Diag[]>(() => {
    const s = this.store.state();
    if (!s) return [];
    const f = this.fmt,
      el = s.system.channels?.eventLoop,
      tok = s.usage.tokens?.daily.at(-1);
    const chans = s.system.channels?.channels ?? [];
    const up = chans.filter(
      (c) => (c.connected || 0) >= (c.enabled || 1) && !c.errors.length,
    ).length;
    const lastIn = Math.max(
      0,
      ...chans.map((c) => c.lastInboundAt ?? 0),
      ...(s.system.health?.channels ?? []).map((c) => c.lastInboundAt ?? 0),
    );
    const st = this.talk.status();
    const voice: Diag = this.talkOn()
      ? {
          icon: 'mic',
          color: 'purple',
          label: 'Voice',
          value: this.talk.live() ? 'Live' : this.talk.connecting() ? 'Connecting' : 'Ready',
          sub: this.talk.live() ? st.meta || 'realtime Talk' : 'tap the orb or hold Space',
        }
      : { icon: 'mic', color: 'purple', label: 'Voice', value: 'Off', sub: 'typed messages only' };
    return [
      voice,
      {
        icon: 'chat',
        color: 'cyan',
        label: 'Channels',
        value: chans.length ? `${up}/${chans.length} up` : 'None',
        sub: lastIn ? `last message ${f.ago(lastIn)}` : '',
      },
      {
        icon: 'spark',
        color: 'amber',
        label: 'Tokens today',
        value: tok ? f.num(tok.total) : '–',
        sub: tok?.total ? `${f.pct(tok.cacheRead / tok.total)}% from cache` : '',
      },
      {
        icon: 'pulse',
        color: 'green',
        label: 'Event loop',
        value: `${Math.round(el?.p99 || 0)} ms`,
        sub: `p99 · ${f.pct(el?.utilization)}% busy`,
      },
    ];
  });

  protected readonly status = computed(() => {
    const s = this.store.state();
    if (!s)
      return this.store.error() ? { text: 'Offline', cls: 'bad' } : { text: 'Starting', cls: '' };
    if (!s.gateway.connected) return { text: 'Offline', cls: 'bad' };
    const level = this.store.health()?.level ?? 'ok';
    return { text: level === 'bad' ? 'Degraded' : 'Online', cls: level === 'ok' ? '' : level };
  });

  protected readonly note = computed(() => {
    const s = this.store.state();
    if (!s) return this.talkOn() ? 'Tap the orb to talk' : '';
    const at = `${this.fmt.time(this.store.lastOk())}${this.fmt.zone ? ` ${this.fmt.zone}` : ''}`;
    return `${s.dryRun ? 'Dry run · nothing is sent · ' : ''}updated ${at}`;
  });

  protected orb(): void {
    if (this.talkOn()) this.talk.toggle();
    else document.getElementById('cc-message')?.focus();
  }
}
