import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CanvasService } from '../src/canvas.ts';
import { loadConfig, type Config } from '../src/config.ts';

process.chdir(mkdtempSync(join(tmpdir(), 'occ-cwd-')));

/** A config whose canvas may read only from a fresh temp directory. */
function setup(canvas: Record<string, unknown> = {}): { cfg: Config; root: string; data: string } {
  const dir = mkdtempSync(join(tmpdir(), 'occ-canvas-'));
  const root = join(dir, 'root');
  const data = join(dir, 'data');
  mkdirSync(root);
  mkdirSync(data);
  const file = join(dir, 'config.json');
  writeFileSync(
    file,
    JSON.stringify({
      server: { dataDir: data },
      canvas: { fileRoots: [root], ...canvas },
    }),
  );
  return { cfg: loadConfig(['--config', file], {}), root, data };
}

const header = (token: string): IncomingMessage =>
  ({ headers: { authorization: `Bearer ${token}` } }) as unknown as IncomingMessage;

test('a pushed note lands on the canvas and bumps the revision', () => {
  const { cfg } = setup();
  const c = new CanvasService(cfg);
  const before = c.rev;
  const { item } = c.push({ kind: 'markdown', title: 'Status', body: '# Hi\n\nall good' });
  assert.equal(item.kind, 'markdown');
  assert.equal(item.title, 'Status');
  assert.match(item.body!, /all good/);
  assert.equal(c.state().items.length, 1);
  assert.ok(c.rev > before);
});

test('the kind is inferred from what was pushed', () => {
  const { cfg, root } = setup();
  const c = new CanvasService(cfg);
  writeFileSync(join(root, 'notes.py'), 'print("hi")\n');
  assert.equal(c.push({ body: 'plain words' }).item.kind, 'markdown');
  assert.equal(c.push({ path: join(root, 'notes.py') }).item.kind, 'file');
  assert.equal(
    c.push({ src: 'https://example.com/a.png' }).item.kind,
    'image',
    'an src is a picture',
  );
});

test('a file is read only from inside a file root, and is labelled with its language', () => {
  const { cfg, root } = setup();
  const c = new CanvasService(cfg);
  const file = join(root, 'deploy.sh');
  writeFileSync(file, '#!/bin/sh\necho hello\n');
  const { item } = c.push({ kind: 'file', path: file });
  assert.equal(item.language, 'bash');
  assert.equal(item.name, 'deploy.sh');
  assert.match(item.body!, /echo hello/);
  assert.equal(item.title, 'deploy.sh', 'the file name is the default title');
});

test('paths outside the roots, hidden paths, secret-looking names and symlink escapes are refused', () => {
  const { cfg, root } = setup();
  const c = new CanvasService(cfg);
  const outside = join(root, '..', 'outside.txt');
  writeFileSync(outside, 'nope');
  mkdirSync(join(root, '.hidden'));
  writeFileSync(join(root, '.hidden', 'a.txt'), 'nope');
  writeFileSync(join(root, 'id_rsa'), 'nope');
  writeFileSync(join(root, 'service-token.txt'), 'nope');
  symlinkSync(outside, join(root, 'link.txt'));

  const refused = (path: string) => {
    assert.throws(
      () => c.push({ kind: 'file', path }),
      (e: Error & { status?: number }) => (e.status ?? 0) >= 400 && (e.status ?? 0) < 500,
      path,
    );
  };
  refused(outside);
  refused(join(root, '.hidden', 'a.txt'));
  refused(join(root, 'id_rsa'));
  refused(join(root, 'service-token.txt'));
  refused(join(root, 'link.txt'));
  assert.equal(c.state().items.length, 0);
});

test('binary files and over-sized files are refused', () => {
  const { cfg, root } = setup({ maxFileBytes: 64 });
  const c = new CanvasService(cfg);
  writeFileSync(join(root, 'blob.txt'), Buffer.from([0x68, 0x00, 0x01, 0x02]));
  writeFileSync(join(root, 'big.txt'), 'x'.repeat(200));
  assert.throws(() => c.push({ kind: 'file', path: join(root, 'blob.txt') }), /not text/);
  assert.throws(() => c.push({ kind: 'file', path: join(root, 'big.txt') }), /larger than/);
});

test('image sources: https and base64 data images only, never SVG or javascript:', () => {
  const { cfg, root } = setup();
  const c = new CanvasService(cfg);
  assert.equal(
    c.push({ kind: 'image', src: 'data:image/png;base64,iVBORw0KGgo=' }).item.src,
    'data:image/png;base64,iVBORw0KGgo=',
  );
  for (const src of [
    'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    'javascript:alert(1)',
    'http://example.com/a.png',
    'data:text/html;base64,PGI+',
  ])
    assert.throws(() => c.push({ kind: 'image', src }), /src must be/, src);

  // An image from disk is served back as bytes, not as a path the browser could poke at.
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  writeFileSync(join(root, 'shot.png'), png);
  const { item } = c.push({ path: join(root, 'shot.png') });
  assert.equal(item.src, `media/${item.id}`);
  assert.equal(c.mediaOf(item.id)?.type, 'image/png');
  assert.equal(c.mediaOf(item.id)?.data.length, png.length);
});

test('long text is shortened and the item says so', () => {
  const { cfg } = setup({ maxTextChars: 10 });
  const c = new CanvasService(cfg);
  const { item } = c.push({ kind: 'text', body: 'abcdefghijklmnop' });
  assert.equal(item.body, 'abcdefghij');
  assert.equal(item.truncated, true);
});

test('the canvas keeps only maxItems, dropping the oldest with its bytes', () => {
  const { cfg } = setup({ maxItems: 2 });
  const c = new CanvasService(cfg);
  const first = c.push({ body: 'one' }).item;
  c.push({ body: 'two' });
  c.push({ body: 'three' });
  const ids = c.state().items.map((i) => i.id);
  assert.equal(ids.length, 2);
  assert.ok(!ids.includes(first.id));
  assert.equal(c.mediaOf(first.id), null);
});

test('replace clears what was there, and clear empties the canvas', () => {
  const { cfg } = setup();
  const c = new CanvasService(cfg);
  c.push({ body: 'one' });
  c.push({ body: 'two', replace: true });
  assert.deepEqual(
    c.state().items.map((i) => i.body),
    ['two'],
  );
  c.clear();
  assert.equal(c.state().items.length, 0);
});

test('a waiting browser is woken by the next push', async () => {
  const { cfg } = setup();
  const c = new CanvasService(cfg);
  const waiting = c.wait(c.rev, 5000);
  c.push({ body: 'wake up' });
  const s = await waiting;
  assert.equal(s.items.at(-1)?.body, 'wake up');
});

test('a stale revision returns at once instead of waiting', async () => {
  const { cfg } = setup();
  const c = new CanvasService(cfg);
  c.push({ body: 'already here' });
  const s = await c.wait(c.rev - 1, 5000);
  assert.equal(s.items.length, 1);
});

test('the push token is generated once, kept out of the log and checked exactly', () => {
  const { cfg } = setup();
  const c = new CanvasService(cfg);
  assert.ok(c.token && c.token.length > 20);
  assert.equal(c.tokenFile, join(cfg.server.dataDir, 'canvas-token'));
  assert.equal(c.tokenOk(header(c.token!)), true);
  assert.equal(c.tokenOk(header(`${c.token}x`)), false);
  assert.equal(c.tokenOk({ headers: {} } as unknown as IncomingMessage), false);
  // A second service on the same data directory reuses it, so restarts don't break the agent.
  assert.equal(new CanvasService(cfg).token, c.token);
});

test('a disabled canvas has no token and refuses pushes', () => {
  const { cfg } = setup({ enabled: false });
  const c = new CanvasService(cfg);
  assert.equal(c.token, null);
  assert.equal(c.enabled, false);
  assert.throws(() => c.push({ body: 'hi' }), /canvas is off/);
});

test('with no file roots, nothing on disk can be read', () => {
  const { cfg, root } = setup({ fileRoots: [] });
  const c = new CanvasService(cfg);
  writeFileSync(join(root, 'a.txt'), 'hi');
  assert.throws(() => c.push({ kind: 'file', path: join(root, 'a.txt') }), /fileRoots is empty/);
});
