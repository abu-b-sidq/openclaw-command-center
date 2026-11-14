import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { Session } from '../core/session';
import { Talk } from '../core/talk';
import { Icon, type IconName } from '../shared/icon';
import { Wave } from '../shared/wave';

type VoiceState = 'listening' | 'thinking' | 'checking' | 'speaking';

/** The voice deck: mic, live waveform, the last thing said, a composer for typed turns and the state ladder. */
@Component({
  selector: 'article[ccVoicePanel]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, Wave],
  host: {
    class: 'cc-panel cc-voice',
    'data-panel': 'voice',
    '[class.is-full]': 'full()',
    '[attr.data-mood]': 'current() ?? \'idle\'',
    '(document:fullscreenchange)': 'sync()',
  },
  template: `
    <button
      type="button"
      class="mic-button cc-voice-btn"
      [attr.aria-pressed]="talk.active()"
      [attr.aria-label]="talk.active() ? 'End the call' : 'Start talking to ' + name()"
      [disabled]="!talkOn()"
      [title]="talkOn() ? '' : 'Voice is turned off for this command center'"
      (click)="talk.toggle()"
    >
      <span class="vo-ring vo-ring-a"></span><span class="vo-ring vo-ring-b"></span
      ><span class="vo-core"><cc-icon name="mic" /></span>
    </button>
    <div class="cc-voice-main">
      <h2>
        <span>{{ name() }} · voice</span
        ><small class="vo-state">{{ talkOn() ? talk.stateLabel() : 'Typed only' }}</small>
        @if (canFull) {
          <button
            type="button"
            class="vo-full"
            [attr.aria-label]="full() ? 'Exit full screen' : 'Full screen'"
            [title]="full() ? 'Exit full screen (Esc)' : 'Full screen'"
            (click)="toggleFull()"
          >
            <cc-icon [name]="full() ? 'shrink' : 'expand'" />
          </button>
        }
      </h2>
      <cc-wave class="cc-wave" [count]="72" [shaped]="true" />
      <p class="cc-said" aria-live="polite">
        <span class="cc-who">{{ talk.speaker() }}</span> <span>{{ talk.line() }}</span>
      </p>
      <p class="cc-resp">{{ talk.resp() }}</p>
      <form class="composer" (submit)="send($event)">
        <label class="sr-only" for="cc-message">Message {{ name() }}</label>
        <input
          #msg
          id="cc-message"
          name="message"
          [placeholder]="placeholder()"
          autocomplete="off"
          maxlength="2000"
          required
        />
        <button class="send-button" type="submit" aria-label="Send message">
          <cc-icon name="send" />
        </button>
      </form>
      <p class="cc-hint">
        {{ talkOn() ? talk.hint() : 'Voice is off here · type a message and press Enter' }}
      </p>
    </div>
    <ol class="cc-states" aria-label="Voice state">
      @for (s of states; track s.id) {
        <li [class.on]="current() === s.id">
          <cc-icon [name]="s.icon" /><span>{{ s.label }}</span>
        </li>
      }
    </ol>
  `,
})
export class VoicePanel {
  protected readonly talk = inject(Talk);
  private readonly session = inject(Session);
  private readonly input = viewChild.required<ElementRef<HTMLInputElement>>('msg');

  protected readonly name = this.session.assistant;
  protected readonly talkOn = computed(() => !!this.session.boot()?.features.talk);
  protected readonly placeholder = computed(
    () => `Type to ${this.name()}${this.talkOn() ? ', or tap the mic' : ''}`,
  );

  protected readonly states: { id: VoiceState; icon: IconName; label: string }[] = [
    { id: 'listening', icon: 'ear', label: 'Listening' },
    { id: 'thinking', icon: 'spark', label: 'Thinking' },
    { id: 'checking', icon: 'layers', label: 'Checking OpenClaw' },
    { id: 'speaking', icon: 'wave', label: 'Speaking' },
  ];

  protected readonly current = computed<VoiceState | null>(() => {
    if (this.talk.checking()) return 'checking';
    const m = this.talk.mood();
    return m === 'idle' ? null : m;
  });

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly full = signal(false);
  protected readonly canFull = typeof document !== 'undefined' && !!document.fullscreenEnabled;

  protected sync(): void {
    this.full.set(document.fullscreenElement === this.host.nativeElement);
  }

  protected toggleFull(): void {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void this.host.nativeElement.requestFullscreen().catch(() => undefined);
  }

  protected send(e: Event): void {
    e.preventDefault();
    const el = this.input().nativeElement;
    const text = el.value.trim();
    if (!text) return;
    el.value = '';
    void this.talk.say(text);
  }
}
