import { Injectable, signal } from '@angular/core';

export type Theme = 'system' | 'light' | 'dark';

/** System / light / dark, remembered per browser. public/theme-init.js applies it before first paint. */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly theme = signal<Theme>(this.read());
  private readonly mq = window.matchMedia('(prefers-color-scheme: dark)');

  constructor() {
    this.mq.addEventListener('change', () => this.paint());
    this.paint();
  }

  private read(): Theme {
    const t = document.documentElement.dataset['theme'];
    return t === 'light' || t === 'dark' ? t : 'system';
  }

  set(t: Theme): void {
    this.theme.set(t);
    try {
      localStorage.setItem('occ-theme', t);
    } catch {
      /* storage blocked */
    }
    this.paint();
  }

  private paint(): void {
    const t = this.theme();
    document.documentElement.dataset['theme'] = t;
    const dark = t === 'dark' || (t === 'system' && this.mq.matches);
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', dark ? '#0d1012' : '#f5f3ef');
  }
}

/** Layout mode: the full command center, or the voice deck with the work column only. */
@Injectable({ providedIn: 'root' })
export class View {
  readonly focusVoice = signal(false);
}

/** One toast at a time, bottom centre. */
@Injectable({ providedIn: 'root' })
export class Toast {
  readonly text = signal('');
  readonly visible = signal(false);
  private timer = 0;

  show(t: string): void {
    this.text.set(String(t || ''));
    this.visible.set(true);
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.visible.set(false), 3800);
  }
}

/** The side drawer: "queue", "reports", or "<kind>:<id>" for one request. */
@Injectable({ providedIn: 'root' })
export class Drawer {
  readonly view = signal<string | null>(null);
  private lastFocus: Element | null = null;

  open(v: string): void {
    if (!this.view()) this.lastFocus = document.activeElement;
    this.view.set(v);
  }

  close(): void {
    if (!this.view()) return;
    this.view.set(null);
    const f = this.lastFocus as HTMLElement | null;
    if (f && document.contains(f)) f.focus({ preventScroll: true });
  }
}
