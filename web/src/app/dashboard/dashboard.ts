import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { CorePanel } from '../center/core-panel';
import { VoicePanel } from '../center/voice-panel';
import { Session } from '../core/session';
import { StateStore } from '../core/state-store';
import { ActivePanel } from '../panels/active-panel';
import { AlertsPanel } from '../panels/alerts-panel';
import { ConnectedPanel } from '../panels/connected-panel';
import { ControlPanel } from '../panels/control-panel';
import { ModelsPanel } from '../panels/models-panel';
import { NowPanel } from '../panels/now-panel';
import { OpsPanel } from '../panels/ops-panel';
import { QueueCard } from '../panels/queue-card';
import { QuickPanel } from '../panels/quick-panel';
import { SayPanel } from '../panels/say-panel';
import { SchedulePanel } from '../panels/schedule-panel';
import { SystemPanel } from '../panels/system-panel';
import { BottomBar } from './bottom-bar';
import { TopBar } from './top-bar';

/** The four-column command center: system, the assistant (orb + voice), work, controls. */
@Component({
  selector: 'cc-dashboard',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    TopBar,
    BottomBar,
    SystemPanel,
    ConnectedPanel,
    SchedulePanel,
    AlertsPanel,
    CorePanel,
    VoicePanel,
    ActivePanel,
    OpsPanel,
    QueueCard,
    NowPanel,
    QuickPanel,
    ModelsPanel,
    SayPanel,
    ControlPanel,
  ],
  template: `
    <div class="cc-app">
      <header ccTopBar></header>
      <main class="cc-grid">
        <section class="cc-col cc-left" aria-label="System">
          <article ccSystemPanel></article>
          <article ccConnectedPanel></article>
          @if (features()?.calendar) {
            <article ccSchedulePanel></article>
          }
          <article ccAlertsPanel></article>
        </section>
        <section class="cc-center" [attr.aria-label]="session.assistant()">
          <article ccCorePanel></article>
          <article ccVoicePanel></article>
        </section>
        <section class="cc-col cc-mid" aria-label="Work">
          <article ccActivePanel></article>
          <article ccOpsPanel></article>
          <aside ccQueueCard></aside>
          <article ccNowPanel></article>
        </section>
        <section class="cc-col cc-right" aria-label="Controls">
          <article ccQuickPanel></article>
          <article ccModelsPanel></article>
          @if (session.boot()?.ui?.suggestions?.length) {
            <article ccSayPanel></article>
          }
          @if (features()?.talk) {
            <article ccControlPanel></article>
          }
        </section>
      </main>
      <footer ccBottomBar></footer>
    </div>
    @if (banner(); as b) {
      <p class="cc-banner" [class.bad]="b.bad" role="status">
        {{ b.text }}
        @if (b.code) {
          <code>{{ b.code }}</code>
        }
      </p>
    }
  `,
})
export class Dashboard {
  protected readonly session = inject(Session);
  private readonly store = inject(StateStore);
  protected readonly features = computed(() => this.session.boot()?.features);

  /** One line at the bottom when the gateway needs a hand, or when nothing is really being sent. */
  protected readonly banner = computed<{ text: string; code?: string; bad: boolean } | null>(() => {
    const s = this.store.state();
    if (!s) return null;
    const g = s.gateway;
    if (g.pairingRequestId)
      return {
        text: 'This command center is waiting to be paired with the gateway. On the gateway host, run',
        code: `openclaw devices approve ${g.pairingRequestId}`,
        bad: true,
      };
    if (!g.connected)
      return {
        text: `Can’t reach the OpenClaw gateway${g.error ? `: ${g.error}` : ''}. Retrying…`,
        bad: true,
      };
    if (s.dryRun)
      return {
        text: 'Dry run: decisions and messages are recorded here, but nothing is sent to the gateway.',
        bad: false,
      };
    return null;
  });
}
