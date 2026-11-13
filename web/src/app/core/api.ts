import { Injectable } from '@angular/core';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Thin fetch wrapper. Paths resolve against <base href>, so the app works at "/" or under a sub-path. */
@Injectable({ providedIn: 'root' })
export class Api {
  /** Called on any 401, so the shell can show the sign-in screen. */
  onUnauthorized: () => void = () => {};

  private url(path: string, query?: Record<string, string | null | undefined>): string {
    const u = new URL(`api/${path}`, document.baseURI);
    for (const [k, v] of Object.entries(query ?? {})) if (v != null) u.searchParams.set(k, v);
    return u.toString();
  }

  private async parse<T>(r: Response, path: string): Promise<T> {
    let body: Record<string, unknown> = {};
    try {
      body = (await r.json()) as Record<string, unknown>;
    } catch {
      /* empty or non-JSON body */
    }
    if (!r.ok) {
      if (r.status === 401) this.onUnauthorized();
      throw new ApiError(
        typeof body['error'] === 'string' ? body['error'] : `${path}: HTTP ${r.status}`,
        r.status,
      );
    }
    return body as T;
  }

  async get<T>(path: string, query?: Record<string, string | null | undefined>): Promise<T> {
    const r = await fetch(this.url(path, query), { credentials: 'same-origin', cache: 'no-store' });
    return this.parse<T>(r, path);
  }

  async post<T>(path: string, body: unknown = {}): Promise<T> {
    const r = await fetch(this.url(path), {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return this.parse<T>(r, path);
  }
}
