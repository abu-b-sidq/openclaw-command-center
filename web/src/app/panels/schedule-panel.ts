import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { clip, Fmt, safeUrl } from '../core/fmt';
import { Session } from '../core/session';
import { StateStore } from '../core/state-store';
import { Fade } from '../shared/fade';
import { Icon } from '../shared/icon';

@Component({
  selector: 'article[ccSchedulePanel]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, Fade],
  host: { class: 'cc-panel', 'data-panel': 'schedule' },
  template: `
    <header class="cc-ph">
      <h2><cc-icon name="calendar" /> Upcoming schedule</h2>
      @if (calendarUrl()) {
        <a class="cc-ph-r cc-link" [href]="calendarUrl()" target="_blank" rel="noopener noreferrer"
          >View calendar</a
        >
      }
    </header>
    <ul class="cc-list cc-sched" ccFade>
      @if (!loaded()) {
        <li class="cc-skel"></li>
        <li class="cc-skel"></li>
      } @else {
        @for (e of events(); track e.start + e.title) {
          <li class="cc-row" [class.soon]="e.soon">
            <span class="when"
              >{{ e.time }}
              @if (e.day !== 'Today') {
                <small>{{ e.day }}</small>
              }
            </span>
            <span class="tx"
              ><b>{{ e.title }}</b
              ><small>{{ e.sub }}</small></span
            >
            @if (e.link) {
              <a [href]="e.link" target="_blank" rel="noopener noreferrer">{{
                e.meet && e.soon ? 'Join' : 'Open'
              }}</a>
            }
          </li>
        } @empty {
          <li class="cc-empty">{{ error() || 'Nothing on the calendar for the next day.' }}</li>
        }
      }
    </ul>
  `,
})
export class SchedulePanel {
  private readonly store = inject(StateStore);
  private readonly session = inject(Session);
  private readonly fmt = inject(Fmt);

  protected readonly calendarUrl = computed(() => this.session.boot()?.ui.calendarUrl || '');
  protected readonly loaded = computed(() => !!this.store.state());
  protected readonly error = computed(() => {
    const e = this.store.state()?.errors['calendar'];
    return e === 'loading'
      ? 'Loading the calendar…'
      : e
        ? `Calendar unavailable: ${clip(e, 80)}`
        : '';
  });

  protected readonly events = computed(() => {
    const now = Date.now();
    return (this.store.state()?.calendar ?? [])
      .filter((e) => (e.end || e.start) > now)
      .sort((a, b) => a.start - b.start)
      .map((e) => {
        const soon = e.start - now < 60 * 60e3 && e.start > now - 5 * 60e3;
        return {
          ...e,
          title: clip(e.title, 70),
          soon,
          time: e.allDay ? 'All day' : this.fmt.time(e.start),
          day: this.fmt.day(e.start),
          link: safeUrl(e.meet) || safeUrl(e.link),
          sub: [
            e.start > now ? this.fmt.until(e.start) : 'now',
            e.attendees > 1 ? `${e.attendees} people` : '',
            e.meet ? 'Meet' : '',
          ]
            .filter(Boolean)
            .join(' · '),
        };
      });
  });
}
