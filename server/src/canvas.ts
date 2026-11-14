// The Canvas: a small, bounded list of things the assistant wants shown on screen — an image, a note, a
// snippet of code, the contents of a file. The agent pushes items with POST api/canvas/push (bearer token);
// the browser long-polls GET api/canvas and slides the panel in.
//
// Everything here is deliberately narrow: no HTML is accepted, image sources are either data: images, https:
// URLs or bytes this server read itself, and a file can only be read from an allow-listed directory (with
// symlinks resolved, dot-paths and secret-looking names refused).
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { basename, extname, join, relative, sep } from 'node:path';
import type { CanvasItem, CanvasKind, CanvasState } from '../../shared/api.ts';
import { expandHome, type Config } from './config.ts';
import { clip, fail, log, str } from './util.ts';

const KINDS: CanvasKind[] = ['image', 'markdown', 'text', 'code', 'file'];

/** Extension → the label shown in the code header. Unknown extensions fall back to the extension itself. */
const LANGUAGES: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'jsx',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.json': 'json',
  '.jsonc': 'json',
  '.py': 'python',
  '.rb': 'ruby',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.swift': 'swift',
  '.c': 'c',
  '.h': 'c',
  '.cc': 'c++',
  '.cpp': 'c++',
  '.hpp': 'c++',
  '.cs': 'c#',
  '.php': 'php',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'zsh',
  '.fish': 'fish',
  '.sql': 'sql',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.toml': 'toml',
  '.ini': 'ini',
  '.conf': 'conf',
  '.env': 'env',
  '.html': 'html',
  '.xml': 'xml',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.txt': 'text',
  '.log': 'log',
  '.csv': 'csv',
  '.tsv': 'tsv',
  '.diff': 'diff',
  '.patch': 'diff',
  '.tf': 'terraform',
  '.hcl': 'hcl',
  '.dockerfile': 'dockerfile',
  '.gradle': 'gradle',
  '.properties': 'properties',
  '.lua': 'lua',
  '.pl': 'perl',
  '.r': 'r',
  '.vim': 'vim',
};

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
};

/** data: images the browser may render. SVG is left out on purpose: it is a document, not a picture. */
const DATA_IMAGE = /^data:image\/(?:png|jpeg|jpg|gif|webp|avif|bmp);base64,[A-Za-z0-9+/=\s]+$/;

/** Names that never get read, however the allow-list is configured. */
const SECRET_NAME =
  /(^\.env)|(^id_(?:rsa|dsa|ecdsa|ed25519))|secret|credential|password|passwd|token|apikey|\.(?:pem|key|p12|pfx|crt|kdbx|keystore|jks)$/i;

export interface PushInput {
  kind?: unknown;
  title?: unknown;
  caption?: unknown;
  body?: unknown;
  src?: unknown;
  path?: unknown;
  language?: unknown;
  alt?: unknown;
  /** Drop everything already on the canvas first. */
  replace?: unknown;
}

const langOf = (file: string): string => {
  const ext = extname(file).toLowerCase();
  if (LANGUAGES[ext]) return LANGUAGES[ext]!;
  if (/^(?:dockerfile|makefile|justfile|procfile)$/i.test(basename(file)))
    return basename(file).toLowerCase();
  return ext ? ext.slice(1) : 'text';
};

/** Rough binary sniff: NUL bytes, or a lot of control characters in the first few KB. */
function looksBinary(buf: Buffer): boolean {
  const head = buf.subarray(0, 4096);
  let odd = 0;
  for (const b of head) {
    if (b === 0) return true;
    if (b < 9 || (b > 13 && b < 32)) odd++;
  }
  return head.length > 0 && odd / head.length > 0.1;
}

export class CanvasService {
  private readonly cfg: Config;
  private readonly items: CanvasItem[] = [];
  /** Image bytes this server read itself, served back at api/canvas/media/<id>. */
  private readonly media = new Map<string, { type: string; data: Buffer }>();
  private waiters: ((s: CanvasState) => void)[] = [];
  private seq = 0;
  rev = 0;
  /** The bearer token agents push with; null when the canvas is off. */
  readonly token: string | null = null;

  constructor(cfg: Config) {
    this.cfg = cfg;
    if (!cfg.canvas.enabled) return;
    if (cfg.canvas.token) {
      this.token = cfg.canvas.token;
      return;
    }
    // Otherwise keep one in the data directory, mode 0600: the agent reads it, nothing is printed.
    const file = join(cfg.server.dataDir, 'canvas-token');
    if (!existsSync(file)) {
      mkdirSync(cfg.server.dataDir, { recursive: true, mode: 0o700 });
      writeFileSync(file, randomBytes(24).toString('base64url'), { mode: 0o600 });
    }
    this.token = readFileSync(file, 'utf8').trim() || null;
    this.tokenFile = file;
  }

  /** Where the generated token lives, for the startup log (the value itself is never logged). */
  tokenFile: string | null = null;

  get enabled(): boolean {
    return this.cfg.canvas.enabled;
  }

  /** Constant-time check of the Authorization: Bearer / X-Canvas-Token header. */
  tokenOk(req: IncomingMessage): boolean {
    if (!this.token) return false;
    const header =
      str(req.headers['authorization'])?.replace(/^Bearer\s+/i, '') ??
      str(req.headers['x-canvas-token']) ??
      '';
    const want = Buffer.from(this.token);
    const got = Buffer.from(header);
    return got.length === want.length && timingSafeEqual(got, want);
  }

  state(): CanvasState {
    return { rev: this.rev, items: [...this.items] };
  }

  /** Long-poll: resolve as soon as the canvas changes, or after ms with the current state. */
  wait(since: number, ms: number): Promise<CanvasState> {
    if (!Number.isFinite(since) || since !== this.rev) return Promise.resolve(this.state());
    return new Promise((resolve) => {
      const done = (s: CanvasState) => {
        clearTimeout(timer);
        this.waiters = this.waiters.filter((w) => w !== done);
        resolve(s);
      };
      const timer = setTimeout(() => done(this.state()), ms);
      timer.unref?.();
      this.waiters.push(done);
    });
  }

  private changed(): CanvasState {
    this.rev++;
    const s = this.state();
    const waiting = this.waiters;
    this.waiters = [];
    for (const w of waiting) w(s);
    return s;
  }

  clear(): CanvasState {
    this.items.length = 0;
    this.media.clear();
    return this.changed();
  }

  remove(id: string): CanvasState {
    const i = this.items.findIndex((x) => x.id === id);
    if (i < 0) return this.state();
    this.items.splice(i, 1);
    this.media.delete(id);
    return this.changed();
  }

  mediaOf(id: string): { type: string; data: Buffer } | null {
    return this.media.get(id) ?? null;
  }

  // ---- reading an allow-listed file ----

  /** Resolve a pushed path inside canvas.fileRoots, or throw. Symlinks are resolved before the check. */
  private resolveFile(path: string): string {
    const roots = this.cfg.canvas.fileRoots;
    if (!roots.length) throw fail(400, 'file reads are off: canvas.fileRoots is empty');
    let real: string;
    try {
      real = realpathSync(expandHome(path));
    } catch {
      throw fail(404, 'no such file');
    }
    const root = roots.find((r) => real === r || real.startsWith(r + sep));
    if (!root) throw fail(403, 'that path is outside the canvas file roots');
    const rel = relative(root, real);
    if (rel.split(sep).some((s) => s.startsWith('.')))
      throw fail(403, 'hidden paths are not readable');
    if (SECRET_NAME.test(basename(real))) throw fail(403, 'that file name looks like a secret');
    const st = statSync(real);
    if (!st.isFile()) throw fail(400, 'not a regular file');
    if (st.size > this.cfg.canvas.maxFileBytes)
      throw fail(413, `file is larger than ${this.cfg.canvas.maxFileBytes} bytes`);
    return real;
  }

  // ---- pushing ----

  push(input: PushInput): { item: CanvasItem; state: CanvasState } {
    if (!this.enabled) throw fail(404, 'the canvas is off');
    const c = this.cfg.canvas;
    const text = (v: unknown, n: number): string | null => {
      const s = str(v);
      return s ? clip(s, n) : null;
    };
    const path = str(input.path);
    const src = str(input.src);
    const body = typeof input.body === 'string' ? input.body : null;
    let kind = KINDS.includes(input.kind as CanvasKind) ? (input.kind as CanvasKind) : null;
    if (!kind)
      kind = path
        ? IMAGE_TYPES[extname(path).toLowerCase()]
          ? 'image'
          : 'file'
        : src
          ? 'image'
          : body
            ? 'markdown'
            : null;
    if (!kind) throw fail(400, 'nothing to show: pass body, src or path');

    const id = `cv${Date.now().toString(36)}${(this.seq++).toString(36)}`;
    const item: CanvasItem = {
      id,
      at: Date.now(),
      kind,
      title: text(input.title, 120),
      caption: text(input.caption, 400),
      src: null,
      alt: text(input.alt, 200),
      body: null,
      language:
        text(input.language, 24)
          ?.toLowerCase()
          .replace(/[^\w+#.-]/g, '') ?? null,
      name: null,
      bytes: null,
      truncated: false,
    };

    if (kind === 'image') {
      if (path) {
        const file = this.resolveFile(path);
        const type = IMAGE_TYPES[extname(file).toLowerCase()];
        if (!type) throw fail(400, 'that file is not an image the canvas can show');
        const data = readFileSync(file);
        if (data.length > c.maxImageBytes) throw fail(413, 'image is too large');
        this.media.set(id, { type, data });
        item.src = `media/${id}`;
        item.name = basename(file);
        item.bytes = data.length;
      } else if (src) {
        const clean = src.replace(/\s+/g, '');
        if (!/^https:\/\/[^\s"'<>]+$/i.test(src) && !DATA_IMAGE.test(clean))
          throw fail(400, 'src must be an https: URL or a base64 data: image (no SVG)');
        if (clean.length > c.maxImageBytes * 2) throw fail(413, 'data image is too large');
        item.src = src.startsWith('data:') ? clean : src;
      } else throw fail(400, 'an image needs src or path');
      item.title ??= item.name;
    } else if (kind === 'file') {
      if (!path) throw fail(400, 'a file item needs path');
      const file = this.resolveFile(path);
      const buf = readFileSync(file);
      if (looksBinary(buf)) throw fail(415, 'that file is not text');
      let content = buf.toString('utf8');
      if (content.length > c.maxTextChars) {
        content = content.slice(0, c.maxTextChars);
        item.truncated = true;
      }
      item.body = content;
      item.name = basename(file);
      item.bytes = buf.length;
      item.language ??= langOf(file);
      item.title ??= item.name;
    } else {
      if (body === null) throw fail(400, `a ${kind} item needs body`);
      item.body = body.length > c.maxTextChars ? body.slice(0, c.maxTextChars) : body;
      item.truncated = body.length > c.maxTextChars;
      item.bytes = Buffer.byteLength(body);
      if (kind === 'code') item.language ??= 'code';
    }

    if (input.replace === true) {
      this.items.length = 0;
      this.media.clear();
    }
    this.items.push(item);
    while (this.items.length > c.maxItems) {
      const dropped = this.items.shift();
      if (dropped) this.media.delete(dropped.id);
    }
    log('canvas: pushed', item.kind, item.title ? `"${clip(item.title, 60)}"` : id);
    return { item, state: this.changed() };
  }
}
