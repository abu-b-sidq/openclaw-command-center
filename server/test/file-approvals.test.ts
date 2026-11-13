import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseApproval, statusClass } from '../src/approvals/files.ts';

const CFG = {
  gatedPattern: 'change board',
  gatedLabel: 'Change board',
  approveNote: 'Approve sends “approve {id}” to the agent.',
  gatedNote: 'Waiting at the change board.',
};

const FILE = `# Approval 20260105-2 — restart the staging worker

- **Requester:** Sam Lee (agent:main:slack:direct:u123)
- **Logged:** 2026-01-05 10:12 UTC
- **Their words:** "can you bounce the staging worker?"
- **Action:** \`systemctl restart worker\` on staging, then check the health endpoint.
- **Risk:** a few seconds of queue delay.
- **Rollback:** none needed.
- **Status:** pending

## Context
The worker stopped consuming after the last deploy.
`;

test('statusClass maps loose status text', () => {
  assert.equal(statusClass('pending (waiting on Abu)'), 'pending');
  assert.equal(statusClass('**Done** at 10:30'), 'done');
  assert.equal(statusClass('partly done: step 1 ran'), 'partial');
  assert.equal(statusClass('Denied by the operator'), 'denied');
  assert.equal(statusClass('withdrawn'), 'withdrawn');
  assert.equal(statusClass('who knows'), 'other');
});

test('a hand-written request file parses into an open approval', () => {
  const it = parseApproval('20260105-2', FILE, 1000, CFG);
  assert.equal(it.kind, 'file');
  assert.equal(it.title, 'Restart the staging worker');
  assert.equal(it.open, true);
  assert.equal(it.status, 'pending');
  assert.deepEqual(it.decisions, ['approve', 'deny']);
  assert.equal(it.requester.name, 'Sam Lee');
  assert.equal(it.sessionKey, 'agent:main:slack:direct:u123');
  assert.equal(it.agentId, 'main');
  assert.equal(it.theirWords, '"can you bounce the staging worker?"');
  assert.match(it.action ?? '', /systemctl restart worker/);
  assert.equal(it.rollback, 'none needed.');
  assert.equal(it.gated, false);
  assert.equal(it.note, 'Approve sends “approve 20260105-2” to the agent.');
  assert.deepEqual(it.sections, [
    { title: 'Context', body: 'The worker stopped consuming after the last deploy.' },
  ]);
  assert.ok(it.raw, 'open requests keep the raw file');
});

test('a status that matches the gate pattern marks the request as gated', () => {
  const it = parseApproval(
    '20260105-2',
    FILE.replace('**Status:** pending', '**Status:** pending at the change board'),
    1000,
    CFG,
  );
  assert.equal(it.gated, true);
  assert.equal(it.gatedLabel, 'Change board');
  assert.equal(it.note, 'Waiting at the change board.');
});

test('closed requests offer no decisions and drop the raw file', () => {
  const it = parseApproval(
    '20260105-2',
    FILE.replace('**Status:** pending', '**Status:** done, restarted at 10:20'),
    1000,
    CFG,
  );
  assert.equal(it.open, false);
  assert.equal(it.status, 'done');
  assert.deepEqual(it.decisions, []);
  assert.equal(it.raw, null);
  assert.equal(it.statusLine, 'done, restarted at 10:20');
});

test('without a heading the title comes from the action', () => {
  const it = parseApproval(
    '20260105-3',
    '- **Action:** Rotate the staging API key. Then redeploy.\n- **Status:** pending\n',
    1000,
    CFG,
  );
  assert.equal(it.title, 'Rotate the staging API key.');
});
