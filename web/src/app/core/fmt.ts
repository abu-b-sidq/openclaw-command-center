import { Injectable } from '@angular/core';

/**
 * Dates and numbers, always in the operator's configured time zone (or the browser's when none is set),
 * so the clock, schedule and "since" labels agree with each other wherever the server runs.
 */
@Injectable({ providedIn: 'root' })
export class Fmt {
  private tz: string | undefined;
  /** Short zone label shown next to times, e.g. "IST". */
  zone = '';
  private fTime!: Intl.DateTimeFormat;
  private fClock!: Intl.DateTimeFormat;
  private fDay!: Intl.DateTimeFormat;
  private fYmd!: Intl.DateTimeFormat;
  private fLong!: Intl.DateTimeFormat;

  constructor() {
    this.configure(null, null);
  }

  configure(timeZone: string | null, label: string | null): void {
    this.tz = timeZone || undefined;
    const f = (o: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat('en-GB', { timeZone: this.tz, ...o });
    this.fTime = f({ hour: '2-digit', minute: '2-digit', hour12: false });
    this.fClock = f({ hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    this.fDay = f({ weekday: 'short', day: 'numeric', month: 'short' });
    this.fYmd = f({ year: 'numeric', month: '2-digit', day: '2-digit' });
    this.fLong = f({ weekday: 'long', day: 'numeric', month: 'long' });
    this.zone =
      label ||
      new Intl.DateTimeFormat('en-US', { timeZone: this.tz, timeZoneName: 'short' })
        .formatToParts(new Date())
        .find((p) => p.type === 'timeZoneName')?.value ||
      '';
  }

  time = (ts: number | null | undefined): string => (ts ? this.fTime.format(ts) : '');
  clock = (ts: number): string => this.fClock.format(ts);
  longDate = (ts: number): string => this.fLong.format(ts);

  day = (ts: number | null | undefined): string => {
    if (!ts) return '';
    const d = this.fYmd.format(ts);
    return d === this.fYmd.format(Date.now())
      ? 'Today'
      : d === this.fYmd.format(Date.now() + 864e5)
        ? 'Tomorrow'
        : this.fDay.format(ts);
  };

  when = (ts: number | null | undefined): string => (ts ? `${this.day(ts)} ${this.time(ts)}` : '');

  ago = (ts: number | null | undefined): string => {
    if (!ts) return '';
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 45) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 36) return `${h} h ago`;
    return `${Math.round(h / 24)} d ago`;
  };

  until = (ts: number): string => {
    const m = Math.round((ts - Date.now()) / 60e3);
    if (m <= 0) return 'now';
    if (m < 60) return `in ${m} min`;
    const h = Math.round(m / 6) / 10;
    return h < 24 ? `in ${h} h` : `in ${Math.round(h / 24)} d`;
  };

  num = (n: number | null | undefined): string => {
    const v = Number(n) || 0;
    return v >= 1e9
      ? `${(v / 1e9).toFixed(1)}B`
      : v >= 1e6
        ? `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M`
        : v >= 1e3
          ? `${Math.round(v / 1e3)}K`
          : String(v);
  };

  bytes = (b: number | null | undefined): string => {
    const v = Number(b) || 0;
    return v >= 1e9 ? `${(v / 1e9).toFixed(1)} GB` : `${Math.round(v / 1e6)} MB`;
  };

  uptime = (sec: number): string => {
    const s = Number(sec) || 0;
    const d = Math.floor(s / 86400),
      h = Math.floor((s % 86400) / 3600);
    return d ? `${d}d ${h}h` : `${h}h ${Math.floor((s % 3600) / 60)}m`;
  };

  pct = (x: number | null | undefined): number =>
    Math.round(Math.max(0, Math.min(1, Number(x) || 0)) * 100);
}

export const clip = (v: unknown, n: number): string => {
  const s = String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
};

/** Only plain https links make it into an href. */
export const safeUrl = (u: unknown): string =>
  /^https:\/\/[^\s"'<>]+$/.test(String(u || '')) ? String(u) : '';

/** One line from a markdown reply: no ** or backticks, bullets joined with " · ". */
export const plain = (t: unknown): string =>
  String(t || '')
    .replace(/\*\*|`/g, '')
    .replace(/\s*\n+\s*(?:[-*]|\d+[.)])\s+/g, ' · ')
    .replace(/\s+/g, ' ')
    .trim();
