// Small shared helpers: logging, text trimming, scrubbing and a stale-while-revalidate cache.

export const log = (...a: unknown[]): void => console.log(new Date().toISOString(), ...a);

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export const fail = (status: number, message: string): HttpError => new HttpError(status, message);

/** Epoch ms from a number or an ISO string; 0 when unknown. */
export const tsOf = (t: unknown): number =>
  typeof t === 'number' ? t : typeof t === 'string' ? Date.parse(t) || 0 : 0;

/** Collapse whitespace and cut to n characters with an ellipsis. */
export function clip(s: unknown, n: number): string {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** Belt and braces for free-text error strings: no home paths, IPv4 addresses or email addresses. */
export const scrub = (s: unknown): string =>
  String(s ?? '')
    .replace(/\/(?:home|Users)\/[\w.-]+/g, '~')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, 'x.x.x.x')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]');

/** A short, scrubbed one-liner for an error-ish value (string or {id, error|message|reason}). */
export function brief(x: unknown, n = 160): string {
  if (typeof x === 'string') return scrub(clip(x, n));
  const o = (x ?? {}) as Record<string, unknown>;
  const parts = [
    o['id'] ?? o['pluginId'] ?? o['name'],
    o['error'] ?? o['message'] ?? o['reason'],
  ].filter(Boolean);
  return scrub(clip(parts.length ? parts.join(': ') : JSON.stringify(x), n));
}

export const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null;
export const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
export const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Text of a gateway chat message: a string, {text}, or content parts [{type:"text", text}]. */
export function textOf(message: unknown): string {
  if (!message) return '';
  if (typeof message === 'string') return message;
  const m = obj(message);
  if (typeof m['text'] === 'string') return m['text'];
  const c = m['content'];
  if (typeof c === 'string') return c;
  if (Array.isArray(c))
    return c
      .map(obj)
      .filter((p) => p['type'] === 'text' && typeof p['text'] === 'string' && p['text'])
      .map((p) => p['text'] as string)
      .join('\n');
  return '';
}

// ---- stale-while-revalidate cache; a first load waits up to waitMs, then reports {loading} ----

type Entry = {
  value: unknown;
  at: number;
  error: string | null;
  errAt: number;
  pending: Promise<void> | null;
};
export type Cached<T> = T | { error: string } | { loading: true };

export class SwrCache {
  private readonly entries = new Map<string, Entry>();

  get<T>(key: string, ttlMs: number, fn: () => Promise<T>, waitMs = 6000): Promise<Cached<T>> {
    let c = this.entries.get(key);
    if (!c)
      this.entries.set(
        key,
        (c = { value: undefined, at: 0, error: null, errAt: 0, pending: null }),
      );
    const e = c;
    const now = Date.now();
    if (
      (e.value === undefined || now - e.at >= ttlMs) &&
      !e.pending &&
      !(e.error && now - e.errAt < 15000)
    ) {
      e.pending = (async () => fn())()
        .then(
          (v) => {
            e.value = v;
            e.at = Date.now();
            e.error = null;
          },
          (err: unknown) => {
            e.error = brief((err as Error)?.message ?? err, 200);
            e.errAt = Date.now();
          },
        )
        .finally(() => {
          e.pending = null;
        });
    }
    if (e.value !== undefined) return Promise.resolve(e.value as T);
    if (!e.pending) return Promise.resolve({ error: e.error || 'unavailable' });
    const p = e.pending;
    return Promise.race([
      p.then(() => (e.value !== undefined ? (e.value as T) : { error: e.error || 'unavailable' })),
      new Promise<{ loading: true }>((r) => setTimeout(() => r({ loading: true }), waitMs)),
    ]);
  }

  drop(...keys: string[]): void {
    for (const k of keys) this.entries.delete(k);
  }
}

export const isLoading = (v: unknown): v is { loading: true } =>
  !!v && typeof v === 'object' && (v as { loading?: unknown }).loading === true;
export const isError = (v: unknown): v is { error: string } =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  typeof (v as { error?: unknown }).error === 'string' &&
  Object.keys(v as object).length === 1;

/** Format a timestamp for a message an agent reads, in the operator's time zone. */
export function stamp(timeZone: string | null, at = Date.now()): string {
  const f = new Intl.DateTimeFormat('en-GB', {
    ...(timeZone ? { timeZone } : {}),
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  });
  return f.format(at);
}
