import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type IconName =
  | 'cpu'
  | 'plug'
  | 'calendar'
  | 'alert'
  | 'mic'
  | 'send'
  | 'ear'
  | 'spark'
  | 'layers'
  | 'wave'
  | 'list'
  | 'bolt'
  | 'shield'
  | 'target'
  | 'grid'
  | 'refresh'
  | 'chat'
  | 'power'
  | 'pulse'
  | 'chip'
  | 'disk'
  | 'db'
  | 'server'
  | 'clock'
  | 'check'
  | 'mail'
  | 'phone'
  | 'close'
  | 'back'
  | 'external';

/** Line icons drawn on a 24×24 grid with a 1.5 stroke. Purely decorative: always aria-hidden. */
@Component({
  selector: 'cc-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      class="icon"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      @switch (name()) {
        @case ('cpu') {
          <svg:rect x="7" y="7" width="10" height="10" rx="2" />
          <svg:path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" />
        }
        @case ('plug') {
          <svg:path d="M9 7V3M15 7V3M7 7h10v4a5 5 0 0 1-10 0V7ZM12 16v5" />
        }
        @case ('calendar') {
          <svg:rect x="3.5" y="5" width="17" height="15" rx="2.5" />
          <svg:path d="M8 3v4M16 3v4M3.5 10h17" />
        }
        @case ('alert') {
          <svg:path d="M12 4 2.8 19.5h18.4L12 4Z" />
          <svg:path d="M12 10v4.5M12 17.2v.3" />
        }
        @case ('mic') {
          <svg:rect x="9" y="3" width="6" height="11" rx="3" />
          <svg:path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7" />
        }
        @case ('send') {
          <svg:path d="M5 12h13M13 6l6 6-6 6" />
        }
        @case ('ear') {
          <svg:path d="M7 9a5 5 0 0 1 10 0c0 3-3 4-3 7a3 3 0 0 1-5.5 1.6" />
          <svg:path d="M10 9.5a2 2 0 0 1 4 0" />
        }
        @case ('spark') {
          <svg:path
            d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"
          />
        }
        @case ('layers') {
          <svg:path d="m12 3 9 5-9 5-9-5 9-5Z" />
          <svg:path d="m3 13 9 5 9-5" />
        }
        @case ('wave') {
          <svg:path d="M3 12h2M7 8v8M11 5v14M15 9v6M19 11v2" />
        }
        @case ('list') {
          <svg:path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />
        }
        @case ('bolt') {
          <svg:path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />
        }
        @case ('shield') {
          <svg:path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" />
          <svg:path d="m8 12 3 3 5-6" />
        }
        @case ('target') {
          <svg:circle cx="12" cy="12" r="8.5" />
          <svg:circle cx="12" cy="12" r="4.5" />
          <svg:circle cx="12" cy="12" r=".8" />
        }
        @case ('grid') {
          <svg:rect x="4" y="4" width="6.5" height="6.5" rx="1.5" />
          <svg:rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" />
          <svg:rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" />
          <svg:rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" />
        }
        @case ('refresh') {
          <svg:path
            d="M20 11a8 8 0 0 0-14.6-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5L20 16M20 20v-4h-4"
          />
        }
        @case ('chat') {
          <svg:path d="M20 15a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9Z" />
        }
        @case ('power') {
          <svg:path d="M12 3v8M7.5 6.5a7 7 0 1 0 9 0" />
        }
        @case ('pulse') {
          <svg:path d="M3 12h4l2.5-6 4 12 2.5-6H21" />
        }
        @case ('chip') {
          <svg:rect x="4" y="7" width="16" height="10" rx="2" />
          <svg:path d="M8 11v2M12 11v2M16 11v2M7 17v3M17 17v3" />
        }
        @case ('disk') {
          <svg:rect x="3" y="13" width="18" height="7" rx="2" />
          <svg:path d="M5 13 7.5 5h9L19 13M7 16.5h.01" />
        }
        @case ('db') {
          <svg:ellipse cx="12" cy="6" rx="8" ry="3" />
          <svg:path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
        }
        @case ('server') {
          <svg:rect x="4" y="4" width="16" height="6.5" rx="1.5" />
          <svg:rect x="4" y="13.5" width="16" height="6.5" rx="1.5" />
          <svg:path d="M8 7.2h.01M8 16.8h.01" />
        }
        @case ('clock') {
          <svg:circle cx="12" cy="12" r="8.5" />
          <svg:path d="M12 7.5V12l3 2" />
        }
        @case ('check') {
          <svg:circle cx="12" cy="12" r="8.5" />
          <svg:path d="m8.5 12 2.5 2.5 4.5-5" />
        }
        @case ('mail') {
          <svg:rect x="3.5" y="5.5" width="17" height="13" rx="2" />
          <svg:path d="m4 7 8 6 8-6" />
        }
        @case ('phone') {
          <svg:rect x="7" y="2.5" width="10" height="19" rx="2.5" />
          <svg:path d="M11 18.5h2" />
        }
        @case ('close') {
          <svg:path d="m6 6 12 12M18 6 6 18" />
        }
        @case ('back') {
          <svg:path d="m14 6-6 6 6 6" />
        }
        @case ('external') {
          <svg:path
            d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"
          />
        }
      }
    </svg>
  `,
})
export class Icon {
  readonly name = input.required<IconName>();
}
