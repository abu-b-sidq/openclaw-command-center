import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** Waveform bars. Heights follow the --level CSS variable that the Talk client sets from live audio. */
@Component({
  selector: 'cc-wave',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { 'aria-hidden': 'true' },
  template: `@for (b of bars(); track $index) {
    <i [style.--k]="b.k" [style.--d]="b.d"></i>
  }`,
})
export class Wave {
  readonly count = input(22);
  /** Taper the ends like a voice envelope. */
  readonly shaped = input(false);

  readonly bars = computed(() => {
    const n = this.count(),
      shaped = this.shaped();
    return Array.from({ length: n }, (_, i) => {
      const env = shaped ? 0.35 + 0.65 * Math.sin((Math.PI * (i + 0.5)) / n) : 1;
      return {
        k: (env * (0.45 + Math.random() * 0.55)).toFixed(2),
        d: (Math.random() * 2.8).toFixed(2),
      };
    });
  });
}
