import { computed, inject, Injectable, signal } from '@angular/core';
import type { CanvasItem, CanvasState } from '../../../../shared/api';
import { Api, ApiError } from './api';

/** How recent the newest item must be to open the panel on a fresh page load. */
const FRESH_MS = 10 * 60e3;

/**
 * What the assistant put on screen. The server holds a short list of items; this long-polls GET /api/canvas,
 * so a new item shows up as soon as it is pushed. A new item opens the panel and becomes the current one,
 * unless the panel is pinned — then it only joins the strip and waits.
 */
@Injectable({ providedIn: 'root' })
export class CanvasStore {
  private readonly api = inject(Api);

  readonly items = signal<CanvasItem[]>([]);
  readonly open = signal(false);
  readonly pinned = signal(false);
  readonly error = signal<string | null>(null);
  /** Id of the item on screen; null means "the newest". */
  readonly currentId = signal<string | null>(null);

  readonly current = computed<CanvasItem | null>(() => {
    const list = this.items();
    if (!list.length) return null;
    const id = this.currentId();
    return (id && list.find((i) => i.id === id)) || list[list.length - 1]!;
  });
  readonly index = computed(() => {
    const c = this.current();
    return c ? this.items().findIndex((i) => i.id === c.id) : -1;
  });
  readonly unseen = computed(() => Math.max(0, this.items().length - 1 - this.index()));

  private rev = -1;
  private started = false;
  private stopped = false;

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.started = false;
    this.items.set([]);
    this.open.set(false);
    this.rev = -1;
  }

  show(id: string): void {
    this.currentId.set(id);
    this.open.set(true);
  }

  step(delta: number): void {
    const list = this.items();
    if (!list.length) return;
    const next = Math.min(list.length - 1, Math.max(0, this.index() + delta));
    this.currentId.set(list[next]!.id);
  }

  /** The last item goes back to following the newest, so a fresh push lands on screen again. */
  private apply(s: CanvasState): void {
    const before = this.items();
    const first = this.rev < 0;
    this.rev = s.rev;
    this.items.set(s.items);
    if (!s.items.length) {
      this.currentId.set(null);
      this.open.set(false);
      return;
    }
    // On the first load the panel opens only for something recent, so a reload hours later doesn't cover
    // the dashboard with yesterday's items; after that, any new push opens it unless the panel is pinned.
    if (first) {
      if (Date.now() - (s.items[s.items.length - 1]?.at ?? 0) < FRESH_MS) this.open.set(true);
      return;
    }
    if (!s.items.some((i) => !before.some((b) => b.id === i.id))) return;
    if (!this.pinned()) {
      this.currentId.set(null);
      this.open.set(true);
    }
  }

  async clear(): Promise<void> {
    try {
      this.apply(await this.api.post<CanvasState>('canvas/clear'));
    } catch {
      /* the next poll will catch up */
    }
  }

  private async loop(): Promise<void> {
    let backoff = 1000;
    while (!this.stopped) {
      try {
        const s = await this.api.get<CanvasState>('canvas', {
          rev: this.rev < 0 ? null : String(this.rev),
        });
        if (this.stopped) return;
        this.apply(s);
        this.error.set(null);
        backoff = 1000;
      } catch (e) {
        if (this.stopped) return;
        if (e instanceof ApiError && (e.status === 401 || e.status === 404)) return this.stop();
        this.error.set((e as Error).message);
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30000);
      }
    }
  }
}
