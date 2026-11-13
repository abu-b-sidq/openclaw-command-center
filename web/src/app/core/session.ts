import { computed, inject, Injectable, signal } from '@angular/core';
import type { Bootstrap } from '../../../../shared/api';
import { Api, ApiError } from './api';
import { Fmt } from './fmt';

/** The bootstrap payload (who the assistant is, which features are on) and the sign-in state. */
@Injectable({ providedIn: 'root' })
export class Session {
  private readonly api = inject(Api);
  private readonly fmt = inject(Fmt);

  readonly boot = signal<Bootstrap | null>(null);
  readonly loadError = signal<string | null>(null);
  readonly signedIn = computed(() => !!this.boot()?.authenticated);
  readonly assistant = computed(() => this.boot()?.assistant.name || 'Assistant');

  constructor() {
    this.api.onUnauthorized = () => {
      const b = this.boot();
      if (b?.authenticated) this.boot.set({ ...b, authenticated: false });
    };
  }

  async load(): Promise<void> {
    try {
      const b = await this.api.get<Bootstrap>('bootstrap');
      // Before boot is set, so the first render already shows times in the operator's zone.
      this.fmt.configure(b.ui.timeZone, b.ui.timeZoneLabel);
      this.boot.set(b);
      this.loadError.set(null);
      if (b.assistant.name) document.title = `${b.assistant.name} · Command Center`;
    } catch (e) {
      this.loadError.set((e as Error).message);
    }
  }

  /** Returns an error message, or null when signed in. */
  async login(password: string): Promise<string | null> {
    try {
      await this.api.post('auth/login', { password });
      await this.load();
      return null;
    } catch (e) {
      return e instanceof ApiError ? e.message : 'Sign-in failed. Is the server up?';
    }
  }

  async logout(): Promise<void> {
    await this.api.post('auth/logout').catch(() => {});
    await this.load();
  }
}
