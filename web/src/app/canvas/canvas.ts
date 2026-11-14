import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import type { CanvasItem } from '../../../../shared/api';
import { CanvasStore } from '../core/canvas';
import { Fmt } from '../core/fmt';
import { codeBlock, markdown } from '../core/markdown';
import { Icon } from '../shared/icon';

const KIND_LABEL: Record<string, string> = {
  image: 'Image',
  markdown: 'Note',
  text: 'Text',
  code: 'Code',
  file: 'File',
};

/**
 * The canvas: a right-hand panel the assistant pushes things to. It slides in when something arrives,
 * keeps the recent items in a strip you can step through, pins open, goes full screen (Esc comes back),
 * and closes. It renders images, markdown, plain text, code and read-only file contents — never raw HTML.
 */
@Component({
  selector: 'cc-canvas',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  host: { '(document:keydown)': 'key($event)', '(click)': 'copyCode($event)' },
  template: `
    <div class="cv-wrap" [class.open]="shown()" [class.full]="full()" [hidden]="!mounted()">
      <aside #panel class="cv-panel" role="complementary" aria-label="Canvas" tabindex="-1">
        <header class="cv-head">
          <span class="cv-kind">{{ label() }}</span>
          <h2>{{ title() }}</h2>
          <span class="cv-when">{{ when() }}</span>
          <button
            type="button"
            class="icon-button"
            [class.on]="store.pinned()"
            [attr.aria-pressed]="store.pinned()"
            [title]="store.pinned() ? 'Unpin: new items take over again' : 'Pin: stay on this item'"
            aria-label="Pin the canvas"
            (click)="store.pinned.set(!store.pinned())"
          >
            <cc-icon name="target" />
          </button>
          <button
            type="button"
            class="icon-button"
            [attr.aria-pressed]="full()"
            [title]="full() ? 'Leave full screen (Esc)' : 'Full screen'"
            aria-label="Full screen"
            (click)="toggleFull()"
          >
            <cc-icon [name]="full() ? 'shrink' : 'expand'" />
          </button>
          <button
            type="button"
            class="icon-button"
            aria-label="Close the canvas"
            title="Close (Esc)"
            (click)="close()"
          >
            <cc-icon name="close" />
          </button>
        </header>

        @if (items().length > 1) {
          <nav class="cv-strip" aria-label="Recent canvas items">
            <button
              type="button"
              class="icon-button"
              aria-label="Previous"
              [disabled]="index() <= 0"
              (click)="store.step(-1)"
            >
              <cc-icon name="back" />
            </button>
            <div class="cv-tabs">
              @for (it of items(); track it.id) {
                <button
                  type="button"
                  class="cv-tab"
                  [class.on]="it.id === current()?.id"
                  [title]="tabTitle(it)"
                  (click)="store.show(it.id)"
                >
                  {{ tabLabel(it) }}
                </button>
              }
            </div>
            <button
              type="button"
              class="icon-button cv-next"
              aria-label="Next"
              [disabled]="index() >= items().length - 1"
              (click)="store.step(1)"
            >
              <cc-icon name="back" />
            </button>
          </nav>
        }

        <div class="cv-body">
          @if (current(); as it) {
            @switch (it.kind) {
              @case ('image') {
                <figure class="cv-figure">
                  <img [src]="src(it)" [alt]="it.alt || it.title || 'Canvas image'" />
                </figure>
              }
              @case ('markdown') {
                <div class="lv-md cv-md" [innerHTML]="md(it.body)"></div>
              }
              @default {
                <div class="lv-md cv-md" [innerHTML]="code(it)"></div>
              }
            }
            @if (it.caption) {
              <p class="cv-caption">{{ it.caption }}</p>
            }
            <p class="cv-meta">
              @if (it.name) {
                <code>{{ it.name }}</code>
              }
              @if (it.bytes) {
                <span>{{ size(it.bytes) }}</span>
              }
              @if (it.truncated) {
                <em>shortened to fit</em>
              }
            </p>
          } @else {
            <p class="cv-empty">Nothing on the canvas yet.</p>
          }
        </div>

        <footer class="cv-foot">
          <span>{{ foot() }}</span>
          <button type="button" class="cv-clear" (click)="store.clear()">Clear</button>
        </footer>
      </aside>
    </div>
  `,
})
export class CanvasPanel {
  protected readonly store = inject(CanvasStore);
  private readonly fmt = inject(Fmt);
  private readonly panel = viewChild<ElementRef<HTMLElement>>('panel');

  protected readonly items = this.store.items;
  protected readonly current = this.store.current;
  protected readonly index = this.store.index;

  /** In the DOM, then slid in: two steps, so the slide animates both ways (like the drawer). */
  protected readonly mounted = signal(false);
  protected readonly shown = signal(false);
  protected readonly full = signal(false);

  protected readonly label = computed(() => KIND_LABEL[this.current()?.kind ?? ''] ?? 'Canvas');
  protected readonly title = computed(
    () => this.current()?.title || KIND_LABEL[this.current()?.kind ?? ''] || 'Canvas',
  );
  protected readonly when = computed(() => {
    const at = this.current()?.at;
    return at ? this.fmt.ago(at) : '';
  });
  protected readonly foot = computed(() => {
    const n = this.items().length;
    if (!n) return '';
    const pos = this.index() + 1;
    return `${pos} of ${n}${this.store.pinned() ? ' · pinned' : ''}`;
  });

  constructor() {
    let hideTimer = 0;
    effect(() => {
      const open = this.store.open() && !!this.current();
      untracked(() => {
        clearTimeout(hideTimer);
        if (open) {
          this.mounted.set(true);
          requestAnimationFrame(() => this.shown.set(true));
        } else {
          this.shown.set(false);
          if (this.full()) void document.exitFullscreen?.().catch(() => {});
          hideTimer = window.setTimeout(() => this.mounted.set(false), 230);
        }
        document.body.classList.toggle('canvas-open', open);
      });
    });
    // A different item starts at the top of the panel.
    effect(() => {
      this.current()?.id;
      untracked(() => {
        const body = this.panel()?.nativeElement.querySelector('.cv-body');
        if (body) body.scrollTop = 0;
      });
    });
    document.addEventListener('fullscreenchange', () =>
      this.full.set(
        !!document.fullscreenElement && document.fullscreenElement === this.panel()?.nativeElement,
      ),
    );
  }

  protected close(): void {
    this.store.open.set(false);
  }

  /**
   * Esc leaves full screen first, then closes the canvas. Browsers normally swallow Esc to exit full screen
   * themselves and the page never sees it; when the page does get it, this does the same thing.
   */
  protected key(e: KeyboardEvent): void {
    if (!this.store.open() || e.key !== 'Escape') return;
    if (this.full() || document.fullscreenElement) {
      void document.exitFullscreen?.().catch(() => {});
      return;
    }
    this.close();
  }

  protected toggleFull(): void {
    const el = this.panel()?.nativeElement;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void el.requestFullscreen?.().catch(() => {});
  }

  /** "media/<id>" is this server's own bytes; it resolves against <base href> like every other API call. */
  protected src(it: CanvasItem): string {
    const s = it.src ?? '';
    return s.startsWith('media/') ? new URL(`api/canvas/${s}`, document.baseURI).toString() : s;
  }

  protected md(body: string | null): string {
    return markdown(body ?? '');
  }

  protected code(it: CanvasItem): string {
    return codeBlock(it.language || (it.kind === 'file' ? 'file' : 'text'), it.body ?? '');
  }

  protected tabLabel(it: CanvasItem): string {
    const t = it.title || it.name || KIND_LABEL[it.kind] || 'Item';
    return t.length > 18 ? `${t.slice(0, 17)}…` : t;
  }

  protected tabTitle(it: CanvasItem): string {
    return `${KIND_LABEL[it.kind] ?? it.kind} · ${it.title || it.name || ''} · ${this.fmt.ago(it.at)}`;
  }

  protected size(bytes: number): string {
    return bytes < 1024
      ? `${bytes} B`
      : bytes < 1024 * 1024
        ? `${Math.round(bytes / 1024)} KB`
        : `${(bytes / 1048576).toFixed(1)} MB`;
  }

  /** Same Copy button behaviour as the drawer's code boxes. */
  protected copyCode(e: Event): void {
    const t = e.target as HTMLElement | null;
    if (!t?.classList?.contains('lv-code-copy')) return;
    const text = t.closest('pre')?.querySelector('code')?.textContent ?? '';
    void navigator.clipboard?.writeText(text).then(() => {
      t.textContent = 'Copied';
      setTimeout(() => (t.textContent = 'Copy'), 1500);
    });
  }
}
