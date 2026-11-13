// Serves the built Angular app. Hashed bundles are cached for a year; index.html is never cached and gets the
// configured <base href>, so the same build works at "/" or under a sub-path behind a proxy.
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};
const HASHED = /-[A-Z0-9]{8}\.(?:js|css|woff2)$/;

export class StaticFiles {
  private index: { mtime: number; html: string } | null = null;
  private readonly dir: string;
  private readonly basePath: string;

  constructor(dir: string, basePath: string) {
    this.dir = dir;
    this.basePath = basePath;
  }

  get available(): boolean {
    return existsSync(join(this.dir, 'index.html'));
  }

  private indexHtml(): string | null {
    const file = join(this.dir, 'index.html');
    let mtime = 0;
    try {
      mtime = statSync(file).mtimeMs;
    } catch {
      return null;
    }
    if (!this.index || this.index.mtime !== mtime) {
      // The Angular build writes a self-closing <base href="/"/>.
      const html = readFileSync(file, 'utf8').replace(
        /<base href="[^"]*"\s*\/?>/,
        `<base href="${this.basePath}">`,
      );
      this.index = { mtime, html };
    }
    return this.index.html;
  }

  /** `path` is relative to the app root, without a leading slash. */
  serve(path: string, res: ServerResponse, head = false): void {
    let rel: string;
    try {
      rel = normalize(decodeURIComponent(path || 'index.html'));
    } catch {
      rel = 'index.html';
    }
    const file = join(this.dir, rel);
    if (
      rel !== 'index.html' &&
      (file === this.dir || file.startsWith(this.dir + sep)) &&
      !rel.startsWith('..')
    ) {
      let st: ReturnType<typeof statSync> | null = null;
      try {
        st = statSync(file);
      } catch {
        /* fall through to the app shell or 404 */
      }
      if (st?.isFile()) {
        res.writeHead(200, {
          'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
          'content-length': st.size,
          'cache-control': HASHED.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache',
        });
        if (head) return void res.end();
        createReadStream(file).pipe(res);
        return;
      }
      // A missing asset is a 404; anything that looks like an app route gets the shell.
      if (extname(rel)) {
        res.writeHead(404, {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
        });
        return void res.end('Not found');
      }
    }
    const html = this.indexHtml();
    if (!html) {
      res.writeHead(503, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      });
      return void res.end('The web app is not built yet. Run "npm run build", then reload.');
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(head ? undefined : html);
  }
}
