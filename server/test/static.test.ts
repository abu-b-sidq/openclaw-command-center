import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { StaticFiles } from '../src/static.ts';

/** Just enough of a ServerResponse for StaticFiles: the status, headers and body it ends with. */
function fakeResponse() {
  const r = { status: 0, headers: {} as Record<string, unknown>, body: '' };
  const res = {
    writeHead(code: number, headers: Record<string, unknown>) {
      r.status = code;
      r.headers = headers;
      return res;
    },
    end(chunk?: string) {
      r.body = chunk ?? '';
      return res;
    },
  };
  return { res: res as unknown as ServerResponse, r };
}

function build(index: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'occ-static-'));
  writeFileSync(join(dir, 'index.html'), index);
  mkdirSync(join(dir, 'assets'));
  return dir;
}

test('index.html gets the configured base href, self-closing or not', () => {
  for (const tag of ['<base href="/"/>', '<base href="/">', '<base href="/" />']) {
    const web = new StaticFiles(build(`<html><head>${tag}</head></html>`), '/command-center/');
    const { res, r } = fakeResponse();
    web.serve('', res);
    assert.equal(r.status, 200);
    assert.equal(r.body, '<html><head><base href="/command-center/"></head></html>', tag);
    assert.equal(r.headers['cache-control'], 'no-store');
  }
});

test('app routes get the shell; missing assets are a 404; no escaping the directory', () => {
  const web = new StaticFiles(build('<base href="/">app'), '/');
  const route = fakeResponse();
  web.serve('queue', route.res);
  assert.equal(route.r.status, 200);
  assert.match(route.r.body, /app$/);
  const missing = fakeResponse();
  web.serve('main-ABCDEFGH.js', missing.res);
  assert.equal(missing.r.status, 404);
  const escape = fakeResponse();
  web.serve('../../etc/passwd', escape.res);
  assert.equal(escape.r.status, 200, 'a path outside the build serves the shell, never the file');
  assert.match(escape.r.body, /app$/);
});

test('without a build the server says so', () => {
  const web = new StaticFiles(mkdtempSync(join(tmpdir(), 'occ-empty-')), '/');
  const { res, r } = fakeResponse();
  web.serve('', res);
  assert.equal(r.status, 503);
  assert.equal(web.available, false);
});
