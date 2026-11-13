// npm run set-password [-- --config path/to/config.json]
// Sets the sign-in password for auth.mode "password". Reads it from the terminal (hidden) or from stdin.
// Writes only a scrypt hash to <dataDir>/password-hash; existing sessions stay signed in.
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { hashPassword } from '../auth.ts';
import { loadConfig } from '../config.ts';

async function readHidden(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
  let muted = false;
  out._writeToOutput = (s: string) => {
    if (!muted || s.includes(prompt)) out.output.write(s);
  };
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

async function readStdin(): Promise<string> {
  let s = '';
  for await (const chunk of process.stdin) s += chunk;
  return s.replace(/\r?\n$/, '');
}

const cfg = loadConfig();
if (cfg.auth.password || cfg.auth.passwordHash) {
  console.error(
    'This config sets auth.password or auth.passwordHash, which win over the stored hash. Change it there instead.',
  );
  process.exit(1);
}
const pw = process.stdin.isTTY ? await readHidden('New password: ') : await readStdin();
if (pw.length < 8) {
  console.error('Use at least 8 characters.');
  process.exit(1);
}
if (process.stdin.isTTY && (await readHidden('Again: ')) !== pw) {
  console.error('The two entries differ. Nothing changed.');
  process.exit(1);
}
mkdirSync(cfg.server.dataDir, { recursive: true, mode: 0o700 });
const file = join(cfg.server.dataDir, 'password-hash');
writeFileSync(file, hashPassword(pw), { mode: 0o600 });
chmodSync(file, 0o600);
console.log(`Password updated (${file}). Restart the server to use it.`);
