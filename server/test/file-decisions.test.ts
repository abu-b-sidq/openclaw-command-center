import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import type { Gateway } from '../src/gateway.ts';
import { StateService } from '../src/state.ts';

const ID = '20260105-2';
const PREFIX = 'agent:main:approval-';
const KEY = `${PREFIX}${ID}`;

interface Fake {
  sends: any[];
  history: any[];
  running: boolean;
  historyError: boolean;
  delay: number;
  /** A gateway whose chat.history has no sessionInfo, so run state comes from sessions.list. */
  legacy: boolean;
  /** Other sessions whose keys contain ours (approval 1 vs 10-19), listed before it by sessions.list. */
  others: number;
  queuedCount: number;
  pendingTotal: number;
  calls: string[];
}

function setup(over: Partial<Fake> = {}, dryRun = false) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-dedupe-'));
  writeFileSync(
    join(dir, `${ID}.md`),
    `# Approval ${ID} — restart a worker\n\n- **Status:** pending\n`,
  );
  const cfgFile = join(dir, 'config.json');
  writeFileSync(
    cfgFile,
    JSON.stringify({
      server: { dataDir: join(dir, 'data'), dryRun },
      auth: { mode: 'none' },
      gateway: { token: 'x' },
      approvals: { files: { enabled: true, dir, sessionKeyPrefix: PREFIX } },
      integrations: { google: { enabled: false } },
    }),
  );
  const cfg = loadConfig(['--config', cfgFile], {});
  const fake: Fake = {
    sends: [],
    history: [],
    running: false,
    historyError: false,
    delay: 0,
    legacy: false,
    others: 0,
    queuedCount: 0,
    pendingTotal: 0,
    calls: [],
    ...over,
  };
  const request = async (method: string, params: any) => {
    fake.calls.push(method);
    if (fake.delay) await new Promise((r) => setTimeout(r, fake.delay));
    const row = { key: KEY, status: fake.running ? 'running' : 'done', hasActiveRun: fake.running };
    if (method === 'sessions.list') {
      const rows = [
        ...Array.from({ length: fake.others }, (_, i) => ({ key: `${KEY}${i}`, status: 'done' })),
        ...(fake.running ? [row] : []),
      ];
      return { sessions: rows.slice(0, params.limit), hasMore: rows.length > params.limit };
    }
    if (method === 'chat.history') {
      if (fake.historyError) throw new Error('gateway down');
      return {
        messages: fake.history,
        hasMore: false,
        pendingInputs: { items: [], total: fake.pendingTotal, queuedCount: fake.queuedCount },
        ...(fake.legacy
          ? {}
          : { sessionInfo: { ...row, activeRunIds: fake.running ? ['run-1'] : [] } }),
      };
    }
    if (method === 'chat.send') {
      fake.sends.push(params);
      return { runId: null, message: 'ok' };
    }
    throw new Error(`unexpected ${method}`);
  };
  const conn = { request, addListener: () => () => {} };
  const gw = { request, get: async () => conn, onEvent: () => () => {} } as unknown as Gateway;
  return { fake, state: new StateService(cfg, gw, () => 'Assistant') };
}

const approve = (state: StateService, force = false) =>
  state.resolve({ kind: 'file', id: ID, decision: 'approve', ...(force ? { force } : {}) });
const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e) => e.status as number,
  );

test('no prior session: the decision is sent once', async () => {
  const { fake, state } = setup();
  const r = await approve(state);
  assert.equal(r.ok, true);
  assert.equal(fake.sends.length, 1);
  assert.equal(fake.sends[0].sessionKey, KEY);
  assert.match(fake.sends[0].message, new RegExp(`^approve ${ID}`));
});

test('a decision already in the session history is refused with 409', async () => {
  const { fake, state } = setup({
    history: [
      {
        role: 'user',
        content: `approve ${ID}\n\n(clicked at 10:00)`,
        timestamp: Date.now() - 5000,
      },
    ],
  });
  await assert.rejects(approve(state), (e: any) => {
    assert.equal(e.status, 409);
    assert.match(e.message, /already sent/);
    assert.match(e.message, /still says pending/);
    return true;
  });
  assert.equal(fake.sends.length, 0);
});

test('a typed decision behind an envelope prefix is recognised, but another id is not', async () => {
  const typed = setup({
    history: [{ role: 'user', content: `[Fri 10:00] Deny ${ID}`, timestamp: 1 }],
  });
  assert.equal(await status(approve(typed.state)), 409);
  const other = setup({
    history: [
      { role: 'user', content: `approve ${ID}7` },
      { role: 'user', content: `please approve 20260105-3` },
      { role: 'assistant', content: `approve ${ID}` },
    ],
  });
  assert.equal(await status(approve(other.state)), 200);
});

test('force sends anyway and bumps the idempotency key', async () => {
  const { fake, state } = setup({ history: [{ role: 'user', content: `approve ${ID}` }] });
  assert.equal(await status(approve(state)), 409);
  assert.equal(await status(approve(state, true)), 200);
  assert.equal(fake.sends.length, 1);
  assert.equal(fake.sends[0].idempotencyKey, `cc-approval:${KEY}:approve:2`);
});

test('an active run is refused with 409, even with force', async () => {
  const { fake, state } = setup({ running: true });
  assert.equal(await status(approve(state)), 409);
  assert.equal(await status(approve(state, true)), 409);
  assert.equal(fake.sends.length, 0);
});

test('the run check reads the exact session, not a search that other ids can crowd out', async () => {
  const { fake, state } = setup({ running: true, others: 60 });
  assert.equal(await status(approve(state)), 409);
  assert.equal(await status(approve(state, true)), 409);
  assert.equal(fake.sends.length, 0);
  assert.equal(fake.calls.includes('sessions.list'), false);
});

test('without sessionInfo, the exact key is found among sessions sharing its prefix', async () => {
  const { fake, state } = setup({ legacy: true, running: true, others: 3 });
  assert.equal(await status(approve(state, true)), 409);
  assert.equal(fake.sends.length, 0);
  const idle = setup({ legacy: true, others: 3 });
  assert.equal(await status(approve(idle.state)), 200);
});

test('without sessionInfo, a key that may sit past the search page fails closed', async () => {
  for (const running of [true, false]) {
    const { fake, state } = setup({ legacy: true, running, others: 60 });
    assert.equal(await status(approve(state, true)), 503);
    assert.equal(fake.sends.length, 0);
  }
});

test('a queued input counts as a run in progress; cancelled ones do not', async () => {
  const queued = setup({ queuedCount: 1, pendingTotal: 1 });
  assert.equal(await status(approve(queued.state, true)), 409);
  assert.equal(queued.fake.sends.length, 0);
  const cancelled = setup({ queuedCount: 0, pendingTotal: 2 });
  assert.equal(await status(approve(cancelled.state)), 200);
  assert.equal(cancelled.fake.sends.length, 1);
});

test('a gateway read error fails closed with 503 and sends nothing', async () => {
  const { fake, state } = setup({ historyError: true });
  assert.equal(await status(approve(state)), 503);
  assert.equal(await status(approve(state, true)), 503);
  assert.equal(fake.sends.length, 0);
});

test('two concurrent requests for the same id send exactly once', async () => {
  const { fake, state } = setup({ delay: 20 });
  const codes = await Promise.all([status(approve(state)), status(approve(state))]);
  assert.deepEqual(codes.sort(), [200, 409]);
  assert.equal(fake.sends.length, 1);
});

test('dry run still reads the session and sends nothing', async () => {
  const clean = setup({}, true);
  const r = await approve(clean.state);
  assert.equal(r.dryRun, true);
  assert.equal(clean.fake.sends.length, 0);
  const dup = setup({ history: [{ role: 'user', content: `approve ${ID}` }] }, true);
  assert.equal(await status(approve(dup.state)), 409);
});
