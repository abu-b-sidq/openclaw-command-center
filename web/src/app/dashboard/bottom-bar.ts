import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Fmt } from '../core/fmt';
import { Session } from '../core/session';
import { StateStore } from '../core/state-store';
import { Talk } from '../core/talk';
import { Icon } from '../shared/icon';
import { Wave } from '../shared/wave';

export const PROJECT_URL = 'https://github.com/abu-b-sidq/openclaw-command-center';

@Component({
  selector: 'footer[ccBottomBar]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, Wave],
  host: { class: 'cc-bottom' },
  template: `
    <span class="cc-bl">
      <span class="cc-os">
        <span class="cc-logo sm" aria-hidden="true"><i></i></span>
        <span
          ><b>OpenClaw</b><small>{{ version() }}</small></span
        >
      </span>
      <span
        class="cc-net"
        [class.bad]="net().level === 'bad'"
        [class.warn]="net().level === 'warn'"
      >
        <i class="status-dot"></i
        ><span
          ><small>Gateway</small><b>{{ net().text }}</b></span
        >
      </span>
    </span>
    <button
      type="button"
      class="mic-button cc-talkbar"
      [attr.aria-pressed]="talkOn() ? talk.active() : null"
      [attr.aria-label]="label()"
      (click)="press()"
    >
      <cc-wave class="cc-mini-wave l" [count]="22" />
      <cc-icon [name]="talkOn() ? 'mic' : 'chat'" />
      <b>{{ label() }}</b>
      <cc-wave class="cc-mini-wave r" [count]="22" />
    </button>
    <span class="cc-foot-r">
      <span>{{ tokens() }}</span>
      <a [href]="projectUrl" target="_blank" rel="noopener noreferrer"
        >Command Center v{{ session.boot()?.version }} ↗</a
      >
    </span>
  `,
})
export class BottomBar {
  protected readonly session = inject(Session);
  protected readonly talk = inject(Talk);
  private readonly store = inject(StateStore);
  private readonly fmt = inject(Fmt);
  protected readonly projectUrl = PROJECT_URL;

  protected readonly talkOn = computed(() => !!this.session.boot()?.features.talk);
  protected readonly label = computed(() =>
    !this.talkOn()
      ? `Type to ${this.session.assistant()}`
      : this.talk.active()
        ? 'End the call'
        : `Talk to ${this.session.assistant()}`,
  );

  protected readonly version = computed(() => {
    const s = this.store.state(),
      v = s?.system.status?.version;
    return v ? `v${v}${s?.dryRun ? ' · dry run' : ''}` : '';
  });

  protected readonly net = computed(() => {
    const s = this.store.state();
    if (!s) return { text: '…', level: '' };
    if (!s.gateway.connected) return { text: 'unreachable', level: 'bad' };
    const el = s.system.channels?.eventLoop;
    const chans = s.system.channels?.channels ?? [];
    const up = chans.filter(
      (c) => (c.connected || 0) >= (c.enabled || 1) && !c.errors.length,
    ).length;
    const parts = [`${Math.round(el?.p99 || 0)} ms`];
    if (chans.length) parts.push(`${up}/${chans.length} channels up`);
    return {
      text: parts.join(' · '),
      level: el?.degraded ? 'bad' : (el?.p99 ?? 0) > 250 || up < chans.length ? 'warn' : '',
    };
  });

  protected readonly tokens = computed(() => {
    const t = this.store.state()?.usage.tokens?.daily.at(-1);
    return t ? `${this.fmt.num(t.total)} tokens today` : '';
  });

  protected press(): void {
    if (this.talkOn()) this.talk.toggle();
    else document.getElementById('cc-message')?.focus();
  }
}
