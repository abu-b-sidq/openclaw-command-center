import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { CanvasStore } from '../core/canvas';
import { Fmt } from '../core/fmt';
import { Session } from '../core/session';
import { StateStore } from '../core/state-store';
import { Talk } from '../core/talk';
import { Drawer, ThemeService, Toast, View, type Theme } from '../core/ui';

@Component({
  selector: 'header[ccTopBar]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'cc-top' },
  template: `
    <a class="cc-brand" href="./" [attr.aria-label]="name() + ' command center'">
      <span class="cc-logo" aria-hidden="true"><i></i></span>
      <span class="cc-brand-txt"
        ><b>{{ name() }}</b
        ><small>{{ tagline() }}</small></span
      >
    </a>
    <div class="cc-clock">
      <b>{{ clock() }}</b><small>{{ date() }}</small>
    </div>
    <nav class="cc-tabs" aria-label="Views">
      <button
        type="button"
        [class.on]="!view.focusVoice()"
        [attr.aria-pressed]="!view.focusVoice()"
        (click)="view.focusVoice.set(false)"
      >
        Command center
      </button>
      <button
        type="button"
        [class.on]="view.focusVoice()"
        [attr.aria-pressed]="view.focusVoice()"
        (click)="view.focusVoice.set(true)"
      >
        Voice
      </button>
      <button type="button" (click)="drawer.open('queue')">
        Needs you <b>{{ store.waiting().length || '' }}</b>
      </button>
      <button type="button" (click)="drawer.open('reports')">Reports</button>
      @if (canvas.items().length) {
        <button
          type="button"
          [class.on]="canvas.open()"
          [attr.aria-pressed]="canvas.open()"
          (click)="canvas.open.set(!canvas.open())"
        >
          Canvas <b>{{ canvas.items().length }}</b>
        </button>
      }
    </nav>
    <div class="cc-top-r">
      <span
        class="cc-sys"
        [class.warn]="level() === 'warn'"
        [class.bad]="level() === 'bad'"
        [title]="sysTitle()"
      >
        <i class="status-dot"></i
        ><span
          ><small>System status</small><b>{{ sysText() }}</b></span
        >
      </span>
      <span class="live-pill" [class.bad]="!!store.error()" [title]="liveTitle()"
        ><i></i><span>{{ liveText() }}</span></span
      >
      @if (session.boot()?.features?.talk) {
        <span
          class="gateway-status"
          [class.off]="talk.status().kind === 'off'"
          [class.live]="talk.status().kind === 'live'"
        >
          <span class="status-dot"></span><span>{{ talk.status().text }}</span>
          @if (talk.status().meta) {
            <span class="muted mono talk-meta">/ {{ talk.status().meta }}</span>
          }
        </span>
      }
      <div class="theme-toggle" role="group" aria-label="Theme">
        @for (t of themes; track t.id) {
          <button
            type="button"
            [attr.aria-pressed]="theme.theme() === t.id"
            (click)="theme.set(t.id)"
          >
            {{ t.label }}
          </button>
        }
      </div>
      <button type="button" class="operator-avatar" [title]="avatarTitle()" (click)="avatar()">
        {{ session.boot()?.operator?.initials }}
      </button>
    </div>
  `,
})
export class TopBar {
  protected readonly session = inject(Session);
  protected readonly store = inject(StateStore);
  protected readonly talk = inject(Talk);
  protected readonly drawer = inject(Drawer);
  protected readonly canvas = inject(CanvasStore);
  protected readonly theme = inject(ThemeService);
  protected readonly view = inject(View);
  private readonly fmt = inject(Fmt);
  private readonly toast = inject(Toast);

  protected readonly themes: { id: Theme; label: string }[] = [
    { id: 'system', label: 'System' },
    { id: 'light', label: 'Light' },
    { id: 'dark', label: 'Dark' },
  ];
  private readonly now = signal(Date.now());
  protected readonly clock = computed(() => this.fmt.clock(this.now()));
  protected readonly date = computed(
    () => `${this.fmt.longDate(this.now())}${this.fmt.zone ? ` · ${this.fmt.zone}` : ''}`,
  );
  protected readonly name = computed(() => this.session.assistant());
  protected readonly tagline = computed(
    () => this.session.boot()?.assistant.tagline || 'Command Center',
  );
  protected readonly level = computed(() =>
    this.store.error() && !this.store.state() ? 'bad' : (this.store.health()?.level ?? 'ok'),
  );

  protected readonly sysText = computed(() => {
    const h = this.store.health(),
      s = this.store.state();
    if (!s) return this.store.error() ? 'Offline' : 'Checking…';
    if (!s.gateway.connected) return 'Gateway unreachable';
    if (!h || h.level === 'ok') return 'All systems operational';
    return `${h.failing.length} need${h.failing.length > 1 ? '' : 's'} attention`;
  });
  protected readonly sysTitle = computed(() => {
    const f = this.store.health()?.failing ?? [];
    return f.length
      ? `Needs attention: ${f.map((c) => c.name).join(', ')}`
      : 'All gateway checks pass';
  });
  protected readonly liveText = computed(() => {
    const e = this.store.error(),
      s = this.store.state();
    if (e) return 'Offline · retrying';
    if (!s) return 'Connecting…';
    return `${s.dryRun ? 'Dry run · ' : 'Live · '}${this.fmt.time(this.store.lastOk())}${this.fmt.zone ? ` ${this.fmt.zone}` : ''}`;
  });
  protected readonly liveTitle = computed(() =>
    this.store.error()
      ? `${this.store.errorText()} (${this.store.error()?.message})`
      : 'Live state from the gateway, refreshed every few seconds',
  );
  protected readonly avatarTitle = computed(() => {
    const b = this.session.boot();
    return `${b?.operator.name || 'Operator'}${b?.authMode === 'password' ? ' · tap twice to sign out' : ''}`;
  });

  private armedOut = 0;

  constructor() {
    const t = window.setInterval(() => this.now.set(Date.now()), 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(t));
  }

  protected avatar(): void {
    if (this.session.boot()?.authMode !== 'password') return;
    if (Date.now() < this.armedOut) {
      this.talk.end();
      void this.session.logout();
      return;
    }
    this.armedOut = Date.now() + 4000;
    this.toast.show('Tap again to sign out.');
  }
}
