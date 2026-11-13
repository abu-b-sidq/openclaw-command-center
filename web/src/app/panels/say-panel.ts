import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Session } from '../core/session';
import { Talk } from '../core/talk';
import { Fade } from '../shared/fade';
import { Icon } from '../shared/icon';

/** Suggested prompts (ui.suggestions in the config). A tap sends it as a typed turn. */
@Component({
  selector: 'article[ccSayPanel]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, Fade],
  host: { class: 'cc-panel', 'data-panel': 'say' },
  template: `
    <header class="cc-ph">
      <h2><cc-icon name="ear" /> Try saying</h2>
      <span class="cc-ph-r">tap to send</span>
    </header>
    <ul class="cc-list cc-say" ccFade>
      @for (t of suggestions(); track t) {
        <li>
          <button type="button" (click)="talk.say(t)">{{ t }}</button>
        </li>
      }
    </ul>
  `,
})
export class SayPanel {
  protected readonly talk = inject(Talk);
  private readonly session = inject(Session);
  protected readonly suggestions = computed(() => this.session.boot()?.ui.suggestions ?? []);
}
