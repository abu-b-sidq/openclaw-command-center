// OpenClaw gateway WebSocket client (protocol 4, operator role, backend client). One shared connection,
// reconnected on demand. The gateway credential never leaves this process.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isLoopbackHost, type Config } from './config.ts';
import { loadOrCreateDeviceIdentity, signConnect, type DeviceIdentity } from './device-identity.ts';
import { log, obj, str, textOf } from './util.ts';

export interface Frame {
  type: string;
  id?: string;
  event?: string;
  ok?: boolean;
  payload?: Record<string, any>;
  error?: { code?: string; message?: string; details?: Record<string, any> };
}

const PROTOCOL = 4;
const CLIENT_ID = 'gateway-client';
const CLIENT_MODE = 'backend';
const ROLE = 'operator';
const SCOPES = ['operator.read', 'operator.write', 'operator.talk', 'operator.approvals'];

export class GatewayError extends Error {
  readonly code: string | null;
  readonly details: Record<string, any>;
  constructor(e: Frame['error']) {
    super(e?.message || 'gateway request failed');
    this.code = e?.code ?? null;
    this.details = obj(e?.details);
  }
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
type Auth = { token?: string; password?: string };

interface ConnectionOptions {
  url: string;
  auth: Auth;
  device: DeviceIdentity | null;
  version: string;
  onEvent: (f: Frame) => void;
  onClose: () => void;
}

export class Connection {
  private ws: WebSocket | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(f: Frame) => void>();
  private readonly url: string;
  private readonly auth: Auth;
  private readonly device: DeviceIdentity | null;
  private readonly version: string;
  private readonly onEvent: (f: Frame) => void;
  private readonly onClose: () => void;
  hello: Record<string, any> | null = null;
  closed = false;

  constructor(o: ConnectionOptions) {
    this.url = o.url;
    this.auth = o.auth;
    this.device = o.device;
    this.version = o.version;
    this.onEvent = o.onEvent;
    this.onClose = o.onClose;
  }

  connect(): Promise<Record<string, any>> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const ws = new WebSocket(this.url);
      this.ws = ws;
      const timer = setTimeout(() => {
        settle(() => reject(new Error('gateway connect timeout')));
        this.close();
      }, 30000);
      ws.onmessage = (m) => {
        let f: Frame;
        try {
          f = JSON.parse(typeof m.data === 'string' ? m.data : String(m.data)) as Frame;
        } catch {
          return;
        }
        if (f.type === 'event' && f.event === 'connect.challenge')
          return this.sendConnect(obj(f.payload));
        if (f.type === 'res' && f.id === 'connect') {
          if (f.ok === false || f.error) {
            settle(() => reject(new GatewayError(f.error)));
            this.close();
            return;
          }
          this.hello = f.payload ?? {};
          if (this.hello['protocol'] !== undefined && this.hello['protocol'] !== PROTOCOL) {
            settle(() =>
              reject(
                new Error(
                  `gateway speaks protocol ${this.hello?.['protocol']}, this app speaks ${PROTOCOL}`,
                ),
              ),
            );
            this.close();
            return;
          }
          settle(() => resolve(this.hello!));
          return;
        }
        if (f.type === 'res' && f.id) {
          const p = this.pending.get(f.id);
          if (!p) return;
          this.pending.delete(f.id);
          clearTimeout(p.timer);
          if (f.ok === false || f.error) p.reject(new GatewayError(f.error));
          else p.resolve(f.payload);
          return;
        }
        if (f.type === 'event') {
          for (const l of this.listeners) {
            try {
              l(f);
            } catch {
              /* a listener's problem, not the connection's */
            }
          }
          this.onEvent(f);
        }
      };
      ws.onclose = () => {
        this.closed = true;
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(new Error('gateway connection closed'));
        }
        this.pending.clear();
        settle(() => reject(new Error('gateway closed the connection during connect')));
        this.onClose();
      };
      ws.onerror = () => {};
    });
  }

  private sendConnect(challenge: Record<string, any>): void {
    const nonce = str(challenge['nonce']);
    const signedAtMs = typeof challenge['ts'] === 'number' ? challenge['ts'] : Date.now();
    const params: Record<string, unknown> = {
      minProtocol: PROTOCOL,
      maxProtocol: PROTOCOL,
      client: {
        id: CLIENT_ID,
        version: `command-center-${this.version}`,
        platform: process.platform,
        mode: CLIENT_MODE,
      },
      role: ROLE,
      scopes: SCOPES,
      caps: [],
      auth: this.auth,
      userAgent: `openclaw-command-center/${this.version}`,
    };
    if (this.device && nonce) {
      params['device'] = signConnect(this.device, {
        clientId: CLIENT_ID,
        clientMode: CLIENT_MODE,
        role: ROLE,
        scopes: SCOPES,
        signedAtMs,
        token: this.auth.token ?? null,
        nonce,
        platform: process.platform,
      });
    }
    this.send({ type: 'req', id: 'connect', method: 'connect', params });
  }

  private send(obj: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  request<T = any>(method: string, params: unknown = {}, timeoutMs = 15000): Promise<T> {
    if (this.closed) return Promise.reject(new Error('gateway connection closed'));
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ type: 'req', id, method, params });
    });
  }

  addListener(fn: (f: Frame) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  close(): void {
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
  }
}

export interface GatewayStatus {
  connected: boolean;
  error: string | null;
  pairingRequestId: string | null;
  version: string | null;
}

export class Gateway {
  private conn: Connection | null = null;
  private ready: Promise<Connection> | null = null;
  private lastFailAt = 0;
  private device: DeviceIdentity | null | undefined;
  private readonly handlers = new Set<(f: Frame) => void>();
  private readonly cfg: Config;
  private readonly appVersion: string;
  readonly status: GatewayStatus = {
    connected: false,
    error: null,
    pairingRequestId: null,
    version: null,
  };

  constructor(cfg: Config, appVersion: string) {
    this.cfg = cfg;
    this.appVersion = appVersion;
  }

  /** Subscribe to every gateway event, across reconnects. */
  onEvent(fn: (f: Frame) => void): () => void {
    this.handlers.add(fn);
    return () => this.handlers.delete(fn);
  }

  private credentials(): Auth {
    const g = this.cfg.gateway;
    if (g.token) return { token: g.token };
    if (g.password) return { password: g.password };
    try {
      const auth = obj(obj(JSON.parse(readFileSync(g.openclawConfig, 'utf8')))['gateway'])['auth'];
      const a = obj(auth);
      if (typeof a['token'] === 'string' && a['token']) return { token: a['token'] };
      if (typeof a['password'] === 'string' && a['password']) return { password: a['password'] };
    } catch {
      /* no readable local config */
    }
    throw new Error(
      'No gateway credentials. Set gateway.token (or OPENCLAW_GATEWAY_TOKEN), or run on the gateway host so the OpenClaw config can be read.',
    );
  }

  private deviceIdentity(): DeviceIdentity | null {
    if (this.device !== undefined) return this.device;
    const mode = this.cfg.gateway.device;
    const host = new URL(this.cfg.gateway.url).hostname;
    const use = mode === 'always' || (mode === 'auto' && !isLoopbackHost(host));
    this.device = use
      ? loadOrCreateDeviceIdentity(join(this.cfg.server.dataDir, 'device.json'))
      : null;
    if (this.device)
      log(`gateway: signing in with device identity ${this.device.deviceId.slice(0, 12)}…`);
    return this.device;
  }

  get(): Promise<Connection> {
    if (this.ready) return this.ready;
    if (Date.now() - this.lastFailAt < 3000)
      return Promise.reject(new Error(this.status.error || 'gateway unavailable'));
    let conn: Connection;
    try {
      conn = new Connection({
        url: this.cfg.gateway.url,
        auth: this.credentials(),
        device: this.deviceIdentity(),
        version: this.appVersion,
        onEvent: (f) => {
          for (const h of this.handlers) h(f);
        },
        onClose: () => {
          if (this.conn === conn) {
            this.conn = null;
            this.ready = null;
            this.status.connected = false;
            log('gateway: connection closed');
          }
        },
      });
    } catch (e) {
      this.lastFailAt = Date.now();
      this.status.error = (e as Error).message;
      return Promise.reject(e);
    }
    this.conn = conn;
    this.ready = conn.connect().then(
      (hello) => {
        this.status.connected = true;
        this.status.error = null;
        this.status.pairingRequestId = null;
        this.status.version = str(obj(hello['server'])['version']);
        log(
          `gateway: connected to ${this.cfg.gateway.url} (OpenClaw ${this.status.version ?? '?'})`,
        );
        return conn;
      },
      (e: Error) => {
        this.conn = null;
        this.ready = null;
        this.lastFailAt = Date.now();
        this.status.connected = false;
        const requestId = e instanceof GatewayError ? str(e.details['requestId']) : null;
        this.status.pairingRequestId =
          requestId &&
          /PAIRING|NOT_PAIRED/i.test(
            `${e instanceof GatewayError ? e.code : ''} ${e instanceof GatewayError ? e.details['code'] : ''}`,
          )
            ? requestId
            : null;
        this.status.error = this.status.pairingRequestId
          ? `Waiting for pairing approval. On the gateway host run: openclaw devices approve ${this.status.pairingRequestId}`
          : e.message;
        log('gateway: connect failed:', this.status.error);
        throw e;
      },
    );
    return this.ready;
  }

  async request<T = any>(method: string, params: unknown = {}, timeoutMs = 15000): Promise<T> {
    return (await this.get()).request<T>(method, params, timeoutMs);
  }

  close(): void {
    this.conn?.close();
  }
}

/** Wait for an agent run's final text: the chat event stream, with agent.wait as a backstop. */
export function waitForRun(conn: Connection, runId: string, timeoutMs = 120000): Promise<string> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      off();
      clearTimeout(t);
      fn();
    };
    const t = setTimeout(
      () => finish(() => reject(new Error('OpenClaw took too long'))),
      timeoutMs,
    );
    const off = conn.addListener((f) => {
      if (f.event !== 'chat' || f.payload?.['runId'] !== runId) return;
      const p = f.payload;
      if (p['state'] === 'final') {
        const x = textOf(p['message']);
        if (x) finish(() => resolve(x));
      } else if (p['state'] === 'aborted') finish(() => reject(new Error('aborted')));
      else if (p['state'] === 'error')
        finish(() => reject(new Error(p['errorMessage'] || 'OpenClaw run failed')));
    });
    conn
      .request('agent.wait', { runId, timeoutMs }, timeoutMs + 5000)
      .then((r) => {
        const o = obj(r);
        const x = textOf(o['message']) || str(o['text']) || str(obj(o['result'])['text']) || '';
        if (x) finish(() => resolve(x));
        else if (o['status'] !== 'timeout')
          setTimeout(() => finish(() => resolve('Finished with no text reply.')), 500);
      })
      .catch(() => {});
  });
}
