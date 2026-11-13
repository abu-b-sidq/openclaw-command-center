import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashPassword, verifyPassword } from '../src/auth.ts';

test('a password verifies against its own hash only', () => {
  const hash = hashPassword('correct horse battery staple');
  assert.match(hash, /^scrypt\$16384\$8\$1\$[\w-]+\$[\w-]+$/);
  assert.equal(verifyPassword('correct horse battery staple', hash), true);
  assert.equal(verifyPassword('correct horse battery stapler', hash), false);
  assert.equal(verifyPassword('', hash), false);
});

test('two hashes of the same password differ (random salt)', () => {
  assert.notEqual(hashPassword('same'), hashPassword('same'));
});

test('malformed hashes never verify', () => {
  assert.equal(verifyPassword('x', ''), false);
  assert.equal(verifyPassword('x', 'plain-text-password'), false);
  assert.equal(verifyPassword('x', 'scrypt$1$2$3$!!$!!'), false);
});
