import { afterNextRender, DestroyRef, Directive, ElementRef, inject } from '@angular/core';

/**
 * Scrollable lists: fade only an edge that has more rows behind it, by setting data-fade="top|bottom|both".
 * Re-checks on scroll, resize and whenever the rows change.
 */
@Directive({ selector: '[ccFade]' })
export class Fade {
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  constructor() {
    const update = () => {
      const el = this.el;
      const top = el.scrollTop > 2,
        bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 2;
      const v = top && bottom ? 'both' : top ? 'top' : bottom ? 'bottom' : '';
      if ((el.dataset['fade'] || '') !== v) {
        if (v) el.dataset['fade'] = v;
        else delete el.dataset['fade'];
      }
    };
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    afterNextRender(() => {
      this.el.addEventListener('scroll', update, { passive: true });
      const ro = new ResizeObserver(schedule);
      ro.observe(this.el);
      const mo = new MutationObserver(schedule);
      mo.observe(this.el, { childList: true, subtree: true, characterData: true });
      update();
      this.destroy = () => {
        ro.disconnect();
        mo.disconnect();
        cancelAnimationFrame(frame);
        this.el.removeEventListener('scroll', update);
      };
    });
    inject(DestroyRef).onDestroy(() => this.destroy());
  }

  private destroy: () => void = () => {};
}
