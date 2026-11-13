import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { sessionUrl } from '../core/links';
import { Session } from '../core/session';
import { StateStore } from '../core/state-store';
import { Talk } from '../core/talk';
import { Drawer, Toast } from '../core/ui';
import { Icon } from '../shared/icon';

@Component({
  selector: 'article[ccQuickPanel]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  host: { class: 'cc-panel', 'data-panel': 'quick' },
  template: `
    <header class="cc-ph">
      <h2><cc-icon name="grid" /> Quick actions</h2>
    </header>
    <div class="cc-qa">
      @if (talkOn()) {
        <button
          type="button"
          class="mic-button cc-qa-btn"
          [attr.aria-pressed]="talk.active()"
          (click)="talk.toggle()"
        >
          <cc-icon name="mic" /><span>{{
            talk.active() ? 'End voice call' : 'Voice command'
          }}</span>
        </button>
      }
      <button type="button" class="cc-qa-btn" (click)="drawer.open('queue')">
        <cc-icon name="shield" /><span>Open the queue</span>
      </button>
      <button type="button" class="cc-qa-btn" (click)="refresh()">
        <cc-icon name="refresh" /><span>Refresh live state</span>
      </button>
      @if (controlUi()) {
        <a class="cc-qa-btn" [href]="controlUi()" target="_blank" rel="noopener noreferrer"
          ><cc-icon name="chat" /><span>Open Control UI</span></a
        >
      } @else {
        <button type="button" class="cc-qa-btn" (click)="drawer.open('reports')">
          <cc-icon name="chat" /><span>{{ session.assistant() }}’s reports</span>
        </button>
      }
    </div>
  `,
})
export class QuickPanel {
  protected readonly session = inject(Session);
  protected readonly talk = inject(Talk);
  protected readonly drawer = inject(Drawer);
  private readonly store = inject(StateStore);
  private readonly toast = inject(Toast);

  protected readonly talkOn = computed(() => !!this.session.boot()?.features.talk);
  /** The Control UI, opened on the assistant's own session. */
  protected readonly controlUi = computed(() => {
    const b = this.session.boot();
    return sessionUrl(b?.ui.controlUiUrl, b?.talk.sessionKey) || b?.ui.controlUiUrl || '';
  });

  protected refresh(): void {
    this.toast.show('Refreshing live state…');
    void this.store.refresh();
  }
}
