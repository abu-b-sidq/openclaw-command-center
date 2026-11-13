import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { agentOf, loadConfig } from '../src/config.ts';

// loadConfig falls back to ./config.json: run from an empty directory so a local config can't leak in.
process.chdir(mkdtempSync(join(tmpdir(), 'occ-cwd-')));

const writeConfig = (cfg: unknown): string => {
  const dir = mkdtempSync(join(tmpdir(), 'occ-config-'));
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify(cfg));
  return file;
};

test('defaults: loopback, password auth, main session, no config file', () => {
  const cfg = loadConfig([], {});
  assert.equal(cfg.server.host, '127.0.0.1');
  assert.equal(cfg.server.port, 18821);
  assert.equal(cfg.server.basePath, '/');
  assert.equal(cfg.auth.mode, 'password');
  assert.equal(cfg.assistant.sessionKey, 'agent:main:main');
  assert.equal(cfg.approvals.files.enabled, false);
});

test('a config file merges over the defaults and resolves paths against its own directory', () => {
  const file = writeConfig({
    '//': 'comments are ignored',
    server: { port: 19000, dataDir: './state' },
    assistant: { name: 'Friday' },
  });
  const cfg = loadConfig(['--config', file], {});
  assert.equal(cfg.configFile, file);
  assert.equal(cfg.server.port, 19000);
  assert.equal(cfg.server.dataDir, join(file, '..', 'state'));
  assert.equal(cfg.assistant.name, 'Friday');
  assert.equal(cfg.assistant.tagline, 'Command Center', 'untouched siblings keep their defaults');
});

test('unknown keys are rejected with their full path', () => {
  const file = writeConfig({ server: { prot: 1 } });
  assert.throws(() => loadConfig(['--config', file], {}), /Unknown config key "server\.prot"/);
});

test('environment variables win over the file', () => {
  const file = writeConfig({ server: { port: 19000 } });
  const cfg = loadConfig(['--config', file], {
    CC_PORT: '19001',
    OPENCLAW_GATEWAY_TOKEN: 'tok',
    CC_SESSION_KEY: 'agent:ops:main',
    CC_DRY_RUN: 'true',
  });
  assert.equal(cfg.server.port, 19001);
  assert.equal(cfg.gateway.token, 'tok');
  assert.equal(cfg.assistant.sessionKey, 'agent:ops:main');
  assert.equal(cfg.server.dryRun, true);
});

test('basePath is normalised to /segment/', () => {
  assert.equal(
    loadConfig([], { CC_BASE_PATH: 'command-center' }).server.basePath,
    '/command-center/',
  );
  assert.equal(loadConfig([], { CC_BASE_PATH: '/a/b//' }).server.basePath, '/a/b/');
  assert.equal(loadConfig([], { CC_BASE_PATH: '/' }).server.basePath, '/');
});

test('auth mode "none" is refused off loopback', () => {
  assert.throws(
    () => loadConfig([], { CC_AUTH_MODE: 'none', CC_HOST: '0.0.0.0' }),
    /only allowed when server.host is a loopback/,
  );
  assert.equal(loadConfig([], { CC_AUTH_MODE: 'none' }).auth.mode, 'none');
});

test('validation catches bad values', () => {
  assert.throws(() => loadConfig([], { CC_SESSION_KEY: 'main' }), /assistant.sessionKey/);
  assert.throws(
    () => loadConfig([], { OPENCLAW_GATEWAY_URL: 'http://127.0.0.1:18789' }),
    /gateway.url/,
  );
  assert.throws(
    () => loadConfig(['--config', writeConfig({ ui: { timeZone: 'Mars/Olympus' } })], {}),
    /not a valid IANA time zone/,
  );
  assert.throws(
    () =>
      loadConfig(['--config', writeConfig({ approvals: { files: { gatedPattern: '(' } } })], {}),
    /gatedPattern/,
  );
});

test('URLs lose their trailing slash (the calendar link keeps one)', () => {
  const cfg = loadConfig(
    [
      '--config',
      writeConfig({
        ui: {
          controlUiUrl: 'https://claw.example.com/',
          calendarUrl: 'https://calendar.example.com',
        },
      }),
    ],
    {},
  );
  assert.equal(cfg.ui.controlUiUrl, 'https://claw.example.com');
  assert.equal(cfg.ui.calendarUrl, 'https://calendar.example.com/');
});

test('agentOf reads the agent id from a session key', () => {
  assert.equal(agentOf('agent:jarvis:main'), 'jarvis');
  assert.equal(agentOf('agent:main:slack:direct:u1'), 'main');
  assert.equal(agentOf('nope'), null);
});
