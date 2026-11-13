import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { Session } from '../core/session';

/** Password sign-in. Shown only in auth mode "password"; proxy and none modes are signed in by the server. */
@Component({
  selector: 'cc-login',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="cc-gate">
      <section class="cc-gate-card">
        <span class="cc-brand">
          <span class="cc-logo" aria-hidden="true"><i></i></span>
          <span class="cc-brand-txt"
            ><b>{{ session.assistant() }}</b
            ><small>{{ session.boot()?.assistant?.tagline || 'Command Center' }}</small></span
          >
        </span>
        <p>Sign in to your OpenClaw command center.</p>
        <form (submit)="submit($event)">
          <label for="cc-password">Password</label>
          <input
            #pw
            id="cc-password"
            type="password"
            autocomplete="current-password"
            required
            (input)="password.set(pw.value)"
          />
          <button type="submit" [disabled]="busy() || !password()">
            {{ busy() ? 'Signing in…' : 'Sign in' }}
          </button>
        </form>
        @if (error()) {
          <p class="cc-gate-err" role="alert">{{ error() }}</p>
        }
      </section>
    </main>
  `,
})
export class Login {
  protected readonly session = inject(Session);
  protected readonly password = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  private readonly input = viewChild.required<ElementRef<HTMLInputElement>>('pw');

  constructor() {
    afterNextRender(() => this.input().nativeElement.focus());
  }

  protected async submit(e: Event): Promise<void> {
    e.preventDefault();
    if (this.busy() || !this.password()) return;
    this.busy.set(true);
    this.error.set('');
    const err = await this.session.login(this.password());
    this.busy.set(false);
    if (err) {
      this.error.set(err);
      const el = this.input().nativeElement;
      el.value = '';
      this.password.set('');
      queueMicrotask(() => el.focus());
    }
  }
}
