// Who may use the app. Three modes:
//  - password: built-in login, scrypt-hashed password, HMAC-signed session cookie (HttpOnly, SameSite=Strict).
//  - proxy:    a reverse proxy in front (nginx basic auth, oauth2-proxy, Tailscale…) already authenticated the user.
//              Optional hardening: a shared header, and/or a Linux peer-uid check so only the proxy's uid can connect.
//  - none:     no auth at all; only allowed on a loopback bind (development).
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { Config } from './config.ts';
import { log } from './util.ts';

const COOKIE = 'occ_session';
const SCRYPT = { N: 16384, r: 8, p: 1 } as const;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export function verifyPassword(password: string, hash: string): boolean {
  const m = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([\w-]+)\$([\w-]+)$/.exec(hash);
  if (!m) return false;
  const [, n, r, p, salt, key] = m;
  const want = Buffer.from(key!, 'base64url');
  const got = scryptSync(password, Buffer.from(salt!, 'base64url'), want.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return got.length === want.length && timingSafeEqual(got, want);
}

function writeSecretFile(file: string, content: string): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, content, { mode: 0o600 });
  chmodSync(file, 0o600);
}

// ---- Linux peer uid: which local user opened this TCP connection? ----
const hexPort = (p: number) => p.toString(16).toUpperCase().padStart(4, '0');
const hexIp4 = (ip: string) =>
  ip
    .split('.')
    .map((n) => Number(n).toString(16).toUpperCase().padStart(2, '0'))
    .reverse()
    .join('');
// /proc/net/tcp6 prints an IPv4-mapped address as four little-endian 32-bit words.
const hexMapped6 = (ip4: string) => `0000000000000000FFFF0000${hexIp4(ip4)}`;

export function peerUid(req: IncomingMessage): number | null {
  const s = req.socket;
  const remote = s.remoteAddress || '',
    local = s.localAddress || '';
  const v4 = /^(?:::ffff:)?(\d+\.\d+\.\d+\.\d+)$/i;
  const r4 = v4.exec(remote)?.[1],
    l4 = v4.exec(local)?.[1];
  if (!r4 || !l4 || !s.remotePort || !s.localPort) return null;
  const tables: [string, string, string][] = [
    [
      '/proc/net/tcp',
      `${hexIp4(r4)}:${hexPort(s.remotePort)}`,
      `${hexIp4(l4)}:${hexPort(s.localPort)}`,
    ],
    [
      '/proc/net/tcp6',
      `${hexMapped6(r4)}:${hexPort(s.remotePort)}`,
      `${hexMapped6(l4)}:${hexPort(s.localPort)}`,
    ],
  ];
  for (const [file, peer, us] of tables) {
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    // The peer's own socket row lists it as the local end.
    for (const line of text.split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f[1] === peer && f[2] === us) return Number(f[7]);
    }
  }
  return null;
}

export class Auth {
  private readonly cfg: Config;
  private readonly secret: Buffer;
  private passwordHash: string | null = null;
  private readonly failures = new Map<string, { n: number; first: number }>();
  /** Set when the app made up a first-run password; printed once to the log. */
  generatedPassword: string | null = null;

  constructor(cfg: Config) {
    this.cfg = cfg;
    const a = cfg.auth,
      dir = cfg.server.dataDir;
    if (a.sessionSecret) this.secret = Buffer.from(a.sessionSecret, 'utf8');
    else {
      const file = join(dir, 'session-secret');
      if (!existsSync(file)) writeSecretFile(file, randomBytes(32).toString('base64url'));
      this.secret = Buffer.from(readFileSync(file, 'utf8').trim(), 'utf8');
    }
    if (a.mode !== 'password') return;
    if (a.passwordHash) this.passwordHash = a.passwordHash;
    else if (a.password) this.passwordHash = hashPassword(a.password);
    else {
      const file = join(dir, 'password-hash');
      if (!existsSync(file)) {
        this.generatedPassword = randomBytes(12).toString('base64url');
        writeSecretFile(file, hashPassword(this.generatedPassword));
      }
      this.passwordHash = readFileSync(file, 'utf8').trim();
    }
  }

  get mode() {
    return this.cfg.auth.mode;
  }

  /** Network-level gate, before any route: the peer uid and proxy header checks. */
  admits(req: IncomingMessage): boolean {
    const a = this.cfg.auth;
    if (a.trustedPeerUids.length) {
      const uid = peerUid(req);
      if (uid === null || !a.trustedPeerUids.includes(uid)) {
        log('auth: refused peer', `uid=${uid}`, req.url);
        return false;
      }
    }
    if (a.mode === 'proxy' && a.proxyHeader) {
      const got = String(req.headers[a.proxyHeader.name.toLowerCase()] ?? '');
      const want = a.proxyHeader.value;
      if (got.length !== want.length || !timingSafeEqual(Buffer.from(got), Buffer.from(want)))
        return false;
    }
    return true;
  }

  private sign(body: string): string {
    return createHmac('sha256', this.secret).update(body).digest('base64url');
  }

  /** Is this request signed in? proxy/none modes are always signed in once admitted. */
  authenticated(req: IncomingMessage): boolean {
    if (this.cfg.auth.mode !== 'password') return true;
    const raw = /(?:^|;\s*)occ_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    if (!raw) return false;
    const [v, exp, sig] = raw.split('.');
    if (v !== 'v1' || !exp || !sig || !/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
    const want = Buffer.from(this.sign(`v1.${exp}`));
    const got = Buffer.from(sig);
    return got.length === want.length && timingSafeEqual(got, want);
  }

  private clientKey(req: IncomingMessage): string {
    const fwd = this.cfg.server.trustProxy
      ? String(
          req.headers['x-real-ip'] ||
            String(req.headers['x-forwarded-for'] || '').split(',')[0] ||
            '',
        ).trim()
      : '';
    return fwd || req.socket.remoteAddress || '?';
  }

  /** Returns null on success, or a reason. Ten failures per client per 15 minutes, then a lockout. */
  login(
    req: IncomingMessage,
    res: ServerResponse,
    password: string,
    secure: boolean,
  ): string | null {
    if (this.cfg.auth.mode !== 'password' || !this.passwordHash) return 'Password sign-in is off';
    const key = this.clientKey(req),
      now = Date.now();
    const f = this.failures.get(key);
    if (f && now - f.first > 15 * 60e3) this.failures.delete(key);
    if ((this.failures.get(key)?.n ?? 0) >= 10)
      return 'Too many attempts. Try again in a few minutes.';
    if (!verifyPassword(password, this.passwordHash)) {
      const g = this.failures.get(key) ?? { n: 0, first: now };
      g.n++;
      this.failures.set(key, g);
      log('auth: failed sign-in from', key);
      return 'Wrong password';
    }
    this.failures.delete(key);
    const exp = now + this.cfg.auth.sessionDays * 86400e3;
    const value = `v1.${exp}.${this.sign(`v1.${exp}`)}`;
    res.setHeader('set-cookie', this.cookie(value, Math.floor((exp - now) / 1000), secure));
    return null;
  }

  logout(res: ServerResponse, secure: boolean): void {
    res.setHeader('set-cookie', this.cookie('', 0, secure));
  }

  private cookie(value: string, maxAge: number, secure: boolean): string {
    return [
      `${COOKIE}=${value}`,
      `Path=${this.cfg.server.basePath}`,
      `Max-Age=${maxAge}`,
      'HttpOnly',
      'SameSite=Strict',
      secure ? 'Secure' : '',
    ]
      .filter(Boolean)
      .join('; ');
  }
}
