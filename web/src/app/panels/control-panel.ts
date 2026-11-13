import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Talk } from '../core/talk';
import { Icon } from '../shared/icon';

@Component({
  selector: 'article[ccControlPanel]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  host: { class: 'cc-panel cc-control', 'data-panel': 'control' },
  template: `
    <header class="cc-ph">
      <h2><cc-icon name="power" /> Control</h2>
    </header>
    <button
      type="button"
      class="cc-stop"
      [disabled]="!talk.active()"
      (click)="talk.end('Talk off')"
    >
      <cc-icon name="power" /><span>End voice call</span>
    </button>
    <p class="cc-note">Approvals always take two taps. Nothing here runs without you.</p>
  `,
})
export class ControlPanel {
  protected readonly talk = inject(Talk);
}
