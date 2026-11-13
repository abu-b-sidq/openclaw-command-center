// Realtime Talk, gateway-controlled: the gateway owns the provider sideband, turns and agent consults; the browser
// streams audio over WebRTC straight to the provider. When the gateway answers talk.client.create with an offer
// route relative to itself (gateway-control-v1), this server relays the browser's SDP offer there, so the browser
// never needs to reach the gateway and never sees the single-use broker token.
// Gateway talk.event frames for each voice session are buffered here and long-polled by the browser.
// Typed turns go to the same agent session with chat.send.
import { randomUUID } from 'node:crypto';
import type {
  ChatResponse,
  TalkEventsResponse,
  TalkOfferResponse,
  TalkSession,
} from '../../shared/api.ts';
import type { Config } from './config.ts';
import { waitForRun, type Frame, type Gateway } from './gateway.ts';
import { clip, fail, log, obj, str, textOf } from './util.ts';

const MAX_EVENTS = 300;
const SESSION_TTL_MS = 6 * 3600e3;

interface VoiceSession {
  created: number;
  events: { seq: number; ev: Record<string, unknown> }[];
  seq: number;
  waiters: Set<() => void>;
  /** A gateway-relative offer route waiting for the browser's SDP (single use). */
  offer: { path: string; secret: string; headers: Record<string, string> } | null;
}

export class Talk {
  private readonly sessions = new Map<string, VoiceSession>();
  private readonly cfg: Config;
  private readonly gw: Gateway;
  /** The gateway's HTTP origin, for its relative offer route: ws://host:port → http://host:port. */
  private readonly gatewayHttp: string;

  constructor(cfg: Config, gw: Gateway) {
    this.cfg = cfg;
    this.gw = gw;
    const u = new URL(cfg.gateway.url);
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
    this.gatewayHttp = u.origin;
    gw.onEvent((f) => this.onEvent(f));
  }

  get live(): number {
    return this.sessions.size;
  }

  private onEvent(f: Frame): void {
    if (f.event !== 'talk.event') return;
    const sess = this.sessions.get(String(f.payload?.['voiceSessionId'] ?? ''));
    const ev = obj(f.payload?.['talkEvent']);
    if (!sess || !Object.keys(ev).length) return;
    if (/audio\.delta$/.test(String(ev['type'] ?? ''))) return; // byte counters only, too chatty
    sess.events.push({ seq: ++sess.seq, ev });
    if (sess.events.length > MAX_EVENTS) sess.events.splice(0, sess.events.length - MAX_EVENTS);
    for (const w of sess.waiters) w();
  }

  async open(): Promise<TalkSession> {
    if (!this.cfg.talk.enabled) throw fail(404, 'Talk is turned off');
    if (this.cfg.server.dryRun) throw fail(409, 'Dry run: voice is off');
    for (const [id, s] of this.sessions)
      if (Date.now() - s.created > SESSION_TTL_MS) this.sessions.delete(id);
    if (this.sessions.size >= this.cfg.talk.maxLive)
      throw fail(429, 'Too many live Talk sessions. End one first.');
    const s = obj(
      await this.gw.request(
        'talk.client.create',
        {
          mode: 'realtime',
          transport: 'webrtc',
          brain: 'agent-consult',
          sessionKey: this.cfg.assistant.sessionKey,
          capabilities: ['gateway-control-v1'],
        },
        30000,
      ),
    );
    if (s['transport'] !== 'webrtc')
      throw fail(502, `The gateway offered ${String(s['transport'])} Talk; this app needs WebRTC`);
    const id = String(s['voiceSessionId'] ?? '');
    if (!id || typeof s['clientSecret'] !== 'string')
      throw fail(502, 'The gateway returned an incomplete Talk session');
    const offerUrl = str(s['offerUrl']);
    const headers = (s['offerHeaders'] as Record<string, string>) ?? null;
    const relay = !!offerUrl?.startsWith('/');
    this.sessions.set(id, {
      created: Date.now(),
      events: [],
      seq: 0,
      waiters: new Set(),
      offer: relay ? { path: offerUrl!, secret: s['clientSecret'], headers: headers ?? {} } : null,
    });
    log('talk: session', id, s['provider'], s['model'], s['voice'], relay ? '(relayed offer)' : '');
    return {
      provider: str(s['provider']),
      transport: 'webrtc',
      voiceSessionId: id,
      clientSecret: relay ? '' : s['clientSecret'],
      offerUrl: relay ? null : offerUrl,
      offerHeaders: relay ? null : headers,
      offerRelay: relay,
      model: str(s['model']),
      voice: str(s['voice']),
      expiresAt: (s['expiresAt'] as number | string) ?? null,
    };
  }

  /** Relays the browser's SDP offer to the gateway's offer route and returns the answer SDP. */
  async offer(voiceSessionId: string, sdp: string): Promise<TalkOfferResponse> {
    const sess = this.sessions.get(voiceSessionId);
    if (!sess?.offer) throw fail(404, 'No Talk offer is pending for that session');
    if (!/^v=0\r?\n/.test(sdp)) throw fail(400, 'Not an SDP offer');
    const o = sess.offer;
    sess.offer = null; // the broker token is single-use
    let r: Response;
    try {
      r = await fetch(new URL(o.path, this.gatewayHttp), {
        method: 'POST',
        headers: {
          ...o.headers,
          authorization: `Bearer ${o.secret}`,
          'content-type': 'application/sdp',
        },
        body: sdp,
        signal: AbortSignal.timeout(30000),
      });
    } catch (e) {
      throw fail(502, `Couldn't reach the gateway's Talk offer route: ${(e as Error).message}`);
    }
    const text = await r.text();
    if (!r.ok)
      throw fail(502, `The gateway refused the Talk offer (${r.status}): ${clip(text, 160)}`);
    return { sdp: text };
  }

  /** Long-poll: events after `after`, waiting up to 25 s for new ones. */
  async events(voiceSessionId: string, after: number): Promise<TalkEventsResponse> {
    const sess = this.sessions.get(voiceSessionId);
    if (!sess) return { closed: true, events: [] };
    const pick = () => sess.events.filter((e) => e.seq > after);
    let got = pick();
    if (!got.length) {
      await new Promise<void>((resolve) => {
        const w = () => {
          clearTimeout(t);
          sess.waiters.delete(w);
          resolve();
        };
        const t = setTimeout(w, 25000);
        sess.waiters.add(w);
      });
      got = pick();
    }
    return { closed: !this.sessions.has(voiceSessionId), events: got };
  }

  async close(voiceSessionId: string): Promise<{ ok: true }> {
    const sess = this.sessions.get(voiceSessionId);
    if (!sess) return { ok: true };
    this.sessions.delete(voiceSessionId);
    for (const w of sess.waiters) w();
    await this.gw
      .request(
        'talk.client.close',
        { sessionKey: this.cfg.assistant.sessionKey, voiceSessionId },
        10000,
      )
      .catch((e: Error) => log('talk: close failed', e.message));
    log('talk: closed', voiceSessionId);
    return { ok: true };
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id).catch(() => {})));
  }

  /** A typed turn into the assistant's session; waits up to two minutes for the reply. */
  async chat(text: string): Promise<ChatResponse> {
    const t = String(text || '')
      .trim()
      .slice(0, 8000);
    if (!t) throw fail(400, 'empty message');
    if (this.cfg.server.dryRun) return { answer: `Dry run: “${t.slice(0, 80)}” was not sent.` };
    const conn = await this.gw.get();
    const r = obj(
      await conn.request(
        'chat.send',
        { sessionKey: this.cfg.assistant.sessionKey, message: t, idempotencyKey: randomUUID() },
        30000,
      ),
    );
    const runId = str(r['runId']);
    if (!runId) return { answer: textOf(r['message']) || 'Sent.' };
    try {
      return { answer: (await waitForRun(conn, runId)).slice(0, 4000) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }
}
