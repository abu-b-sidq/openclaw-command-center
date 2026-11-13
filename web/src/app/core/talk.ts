import { computed, effect, inject, Injectable, signal } from '@angular/core';
import type {
  ChatResponse,
  Reply,
  TalkEvent,
  TalkEventsResponse,
  TalkSession,
} from '../../../../shared/api';
import { Api } from './api';
import { Fmt } from './fmt';
import { Session } from './session';
import { StateStore } from './state-store';
import { Toast } from './ui';

export type Mood = 'idle' | 'listening' | 'thinking' | 'speaking';
const PTT_IDLE_MS = 120e3;
const CHECKING = /^(Checking with OpenClaw|OpenClaw is working)/;

/**
 * Live OpenClaw Talk in the browser: realtime audio over WebRTC straight to the provider the gateway chose,
 * with the gateway owning the provider sideband, turns and agent consults. The server hands out only a
 * short-lived client secret and relays the gateway's talk events, which drive the transcript and the orb.
 *
 * Hold Space for push-to-talk (the mic track only carries audio while Space is down; the provider's VAD closes
 * the turn about half a second after release), or tap the mic for an open-mic call. Esc hangs up.
 */
@Injectable({ providedIn: 'root' })
export class Talk {
  private readonly api = inject(Api);
  private readonly toast = inject(Toast);
  private readonly session = inject(Session);
  private readonly store = inject(StateStore);
  private readonly fmt = inject(Fmt);

  readonly live = signal(false);
  readonly connecting = signal(false);
  readonly active = computed(() => this.live() || this.connecting());
  private readonly speaking = signal(false);
  private readonly thinking = signal(false);
  private readonly typing = signal(0);
  readonly ptt = signal(false);
  readonly held = signal(false);

  readonly speaker = signal('');
  readonly line = signal('');
  readonly resp = signal('');
  readonly status = signal<{ kind: 'off' | 'live' | ''; text: string; meta: string }>({
    kind: 'off',
    text: 'Talk off',
    meta: '',
  });

  readonly mood = computed<Mood>(() =>
    this.live()
      ? this.speaking()
        ? 'speaking'
        : this.thinking() || this.typing()
          ? 'thinking'
          : this.ptt() && !this.held()
            ? 'idle'
            : 'listening'
      : this.connecting() || this.typing()
        ? 'thinking'
        : 'idle',
  );
  readonly checking = computed(() => this.active() && CHECKING.test(this.resp()));
  readonly pttMuted = computed(() => this.ptt() && this.active() && !this.held());
  readonly stateLabel = computed(() => {
    const m = this.mood();
    if (!this.active()) return m === 'thinking' ? 'Thinking' : 'Idle';
    if (this.checking()) return 'Checking OpenClaw';
    if (m === 'speaking') return 'Speaking';
    if (m === 'thinking') return 'Thinking';
    if (m === 'listening') return 'Listening';
    return this.pttMuted() ? 'Mic off' : 'Connecting';
  });
  readonly hint = computed(() => {
    if (!this.live()) return 'Tap the mic or hold Space · real OpenClaw Talk';
    if (!this.ptt()) return 'Listening · talk over me any time';
    return this.held()
      ? 'Listening · let go of Space to send'
      : 'Mic off · hold Space to talk · Esc hangs up';
  });

  private pc: RTCPeerConnection | null = null;
  private stream: MediaStream | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private actx: AudioContext | null = null;
  private micAn: AnalyserNode | null = null;
  private outAn: AnalyserNode | null = null;
  private sess: TalkSession | null = null;
  private raf = 0;
  private quietFrames = 0;
  private turnRole = '';
  private turnText = '';
  private lastTyped = '';
  private lastTypedAt = 0;
  private consultEndAt = 0;
  private swallow = false;
  private idleTimer = 0;
  private lastAct = 0;

  constructor() {
    this.greet();
    // The stylesheet keys the orb, waveforms and state list off body attributes.
    effect(() => {
      const b = document.body;
      b.dataset['state'] = this.mood();
      b.classList.toggle('talk-live', this.active());
      b.classList.toggle('ptt-held', this.ptt() && this.active() && this.held());
      b.classList.toggle('ptt-muted', this.pttMuted());
      b.classList.toggle('cc-checking', this.checking());
    });
    effect(() => this.store.talkLive.set(this.active()));
  }

  private get name(): string {
    return this.session.assistant();
  }

  greet(): void {
    const voice = this.session.boot()?.features.talk ?? true;
    this.show(
      this.name,
      voice ? 'Tap the mic, or hold Space and talk.' : 'Type a message below.',
      `Ask me anything. I’ll check with OpenClaw and report back.`,
    );
  }

  private show(who: string, text: string, sub?: string): void {
    this.speaker.set(who);
    this.line.set(text);
    if (sub !== undefined) this.resp.set(sub);
  }

  // ---------- push-to-talk ----------
  private pttSync(): void {
    if (this.stream)
      for (const t of this.stream.getAudioTracks()) t.enabled = !this.ptt() || this.held();
  }

  private pttDown(): void {
    this.held.set(true);
    this.ptt.set(true);
    this.lastAct = Date.now();
    if (!this.active()) void this.start();
    this.pttSync();
  }

  private pttUp(): void {
    this.held.set(false);
    this.lastAct = Date.now();
    this.pttSync();
  }

  /** A push-to-talk call hangs up after 2 quiet minutes, so a stray Space press doesn't leave a call open. */
  private idleCheck(): void {
    if (
      !this.live() ||
      !this.ptt() ||
      this.held() ||
      this.speaking() ||
      this.thinking() ||
      this.typing()
    ) {
      this.lastAct = Date.now();
      return;
    }
    if (Date.now() - this.lastAct > PTT_IDLE_MS) this.end('Talk off · idle');
  }

  /** Keyboard: hold Space to talk (never inside text fields, never presses a focused button), Esc hangs up. */
  attachKeys(): () => void {
    const editable = (el: EventTarget | null) => {
      const e = el as HTMLElement | null;
      return !!e && (e.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName));
    };
    const isSpace = (e: KeyboardEvent) => e.code === 'Space' || e.key === ' ';
    const down = (e: KeyboardEvent) => {
      // With the drawer open, Esc closes the drawer and leaves the call up.
      if (e.key === 'Escape' && this.active() && !document.body.classList.contains('drawer-open')) {
        this.end('Talk off');
        return;
      }
      if (!isSpace(e) || e.ctrlKey || e.metaKey || e.altKey || e.isComposing || editable(e.target))
        return;
      if (!this.session.boot()?.features.talk) return;
      e.preventDefault();
      e.stopPropagation();
      this.swallow = true;
      if (!e.repeat && !this.held()) this.pttDown();
    };
    const up = (e: KeyboardEvent) => {
      if (!isSpace(e) || !this.swallow) return;
      e.preventDefault();
      e.stopPropagation();
      this.swallow = false;
      if (this.held()) this.pttUp();
    };
    const blur = () => {
      this.swallow = false;
      if (this.held()) this.pttUp();
    };
    const vis = () => {
      if (document.hidden && this.held()) this.pttUp();
    };
    const hide = () => this.end();
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    window.addEventListener('blur', blur);
    document.addEventListener('visibilitychange', vis);
    window.addEventListener('pagehide', hide);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
      window.removeEventListener('blur', blur);
      document.removeEventListener('visibilitychange', vis);
      window.removeEventListener('pagehide', hide);
    };
  }

  // ---------- audio level → orb, waveforms, speaking state ----------
  private level(an: AnalyserNode | null): number {
    if (!an) return 0;
    const a = new Float32Array(an.fftSize);
    an.getFloatTimeDomainData(a);
    let ss = 0;
    for (const x of a) ss += x * x;
    return Math.sqrt(ss / a.length);
  }

  private loop = (): void => {
    const out = this.level(this.outAn),
      mic = this.level(this.micAn);
    // Speaking follows the provider's audio track: some realtime models send no output-audio events.
    if (out > 0.012) {
      this.quietFrames = 0;
      if (!this.speaking()) {
        this.speaking.set(true);
        this.thinking.set(false);
      }
    } else if (this.speaking() && ++this.quietFrames > 45) this.speaking.set(false);
    document.documentElement.style.setProperty(
      '--level',
      Math.min(1, out > 0.01 ? out * 5 : mic * 6).toFixed(3),
    );
    this.raf = requestAnimationFrame(this.loop);
  };

  // ---------- gateway talk events ----------
  private transcript(role: string, delta: string): void {
    if (role !== this.turnRole) {
      this.turnRole = role;
      this.turnText = '';
    }
    this.turnText += delta;
    this.show(role === 'user' ? 'You · live' : this.name, this.turnText.trim() || '…');
    this.thinking.set(role === 'user');
  }

  private onTalkEvent(ev: TalkEvent): void {
    const d = (ev.payload && typeof ev.payload === 'object' ? ev.payload : ev) as Record<
      string,
      any
    >;
    const t = String(ev.type || '');
    switch (t) {
      case 'transcript.delta':
      case 'transcript.done': {
        const role = d['role'] === 'user' ? 'user' : 'assistant';
        const text = String(d['text'] ?? d['delta'] ?? d['transcript'] ?? '');
        if (t === 'transcript.done') {
          this.turnRole = role;
          this.turnText = text;
          this.show(role === 'user' ? 'You' : this.name, text.trim() || '…');
          this.thinking.set(role === 'user');
        } else this.transcript(role, text);
        break;
      }
      case 'output.text.delta':
        this.transcript('assistant', String(d['text'] ?? d['delta'] ?? ''));
        break;
      case 'output.text.done':
        if (d['text']) {
          this.turnRole = 'assistant';
          this.turnText = String(d['text']);
          this.show(this.name, this.turnText);
        }
        break;
      case 'output.audio.started':
        this.speaking.set(true);
        this.thinking.set(false);
        break;
      case 'output.audio.done':
        this.speaking.set(false);
        break;
      case 'turn.started':
        this.thinking.set(true);
        break;
      case 'tool.call': {
        this.thinking.set(true);
        let q = '';
        try {
          const a = typeof d['args'] === 'string' ? JSON.parse(d['args']) : d['args'] || {};
          q = a.question || a.task || '';
        } catch {
          /* unparsable args */
        }
        this.resp.set(`Checking with OpenClaw${q ? `: ${String(q).slice(0, 160)}` : '…'}`);
        break;
      }
      case 'tool.progress':
        this.resp.set('OpenClaw is working…');
        break;
      case 'tool.result': {
        this.consultEndAt = Date.now();
        const r = d['result'] ?? d['output'] ?? d['text'];
        const txt = typeof r === 'string' ? r : (r && (r.text || r.result)) || '';
        this.resp.set(
          txt
            ? `OpenClaw: ${String(txt).replace(/\s+/g, ' ').slice(0, 220)}`
            : 'OpenClaw answered.',
        );
        this.thinking.set(false);
        break;
      }
      case 'tool.error':
        this.consultEndAt = Date.now();
        this.resp.set(
          `OpenClaw check failed${d['message'] || d['error'] ? `: ${d['message'] || d['error']}` : ''}`,
        );
        this.thinking.set(false);
        break;
      case 'session.error':
        this.resp.set(String(d['message'] || d['error'] || 'Realtime session error'));
        break;
      case 'session.closed':
      case 'session.replaced':
        this.end(t === 'session.replaced' ? 'Talk moved elsewhere' : 'Talk ended');
        break;
    }
  }

  private async pollEvents(id: string): Promise<void> {
    let after = 0;
    while (this.sess && this.sess.voiceSessionId === id) {
      try {
        const r = await this.api.post<TalkEventsResponse>('talk/events', {
          voiceSessionId: id,
          after,
        });
        for (const e of r.events || []) {
          after = Math.max(after, e.seq);
          if (this.sess?.voiceSessionId === id) this.onTalkEvent(e.ev);
        }
        if (r.closed) {
          if (this.sess?.voiceSessionId === id) this.end('Talk ended');
          return;
        }
      } catch {
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }

  // ---------- call lifecycle ----------
  async start(): Promise<void> {
    if (this.active()) return;
    this.connecting.set(true);
    this.status.set({ kind: '', text: 'Connecting…', meta: '' });
    this.show(
      this.name,
      'Waking up…',
      this.ptt()
        ? 'Opening a realtime Talk session. Talk once it says Listening.'
        : 'Opening a realtime Talk session.',
    );
    try {
      if (typeof RTCPeerConnection === 'undefined') throw new Error('This browser has no WebRTC');
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      if (!this.connecting()) return this.cleanup();
      this.pttSync();
      const sess = await this.api.post<TalkSession>('talk/session');
      this.sess = sess;
      if (!this.connecting()) {
        void this.api.post('talk/close', { voiceSessionId: sess.voiceSessionId }).catch(() => {});
        this.sess = null;
        return this.cleanup();
      }
      const actx = new AudioContext();
      this.actx = actx;
      this.micAn = actx.createAnalyser();
      this.micAn.fftSize = 512;
      actx.createMediaStreamSource(this.stream).connect(this.micAn);
      const pc = new RTCPeerConnection();
      this.pc = pc;
      const audio = document.createElement('audio');
      audio.autoplay = true;
      audio.setAttribute('playsinline', '');
      audio.style.display = 'none';
      document.body.append(audio);
      this.audioEl = audio;
      pc.ontrack = (ev) => {
        const rs = ev.streams[0];
        if (!rs) return;
        audio.srcObject = rs;
        audio.play().catch(() => {});
        try {
          this.outAn = actx.createAnalyser();
          this.outAn.fftSize = 512;
          actx.createMediaStreamSource(rs).connect(this.outAn);
        } catch {
          /* level meter only */
        }
      };
      for (const t of this.stream.getAudioTracks()) pc.addTrack(t, this.stream);
      const goLive = () => {
        if (this.live() || !this.pc) return;
        this.live.set(true);
        this.connecting.set(false);
        this.lastAct = Date.now();
        this.status.set({
          kind: 'live',
          text: 'Talk live',
          meta: [sess.provider, sess.voice].filter(Boolean).join(' · '),
        });
        if (this.ptt() && !this.held())
          this.show(this.name, 'Ready.', 'Hold Space and talk. Let go and I’ll answer.');
        else
          this.show(
            this.name,
            'I’m listening.',
            'Ask me anything. I’ll check with OpenClaw and report back.',
          );
        clearInterval(this.idleTimer);
        this.idleTimer = window.setInterval(() => this.idleCheck(), 5e3);
        this.pttSync();
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') goLive();
        if ((pc.connectionState === 'failed' || pc.connectionState === 'closed') && this.active())
          this.end('Talk disconnected');
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const offerUrl = new URL(
        sess.offerUrl || 'https://api.openai.com/v1/realtime/calls',
        location.origin,
      ).toString();
      const r = await fetch(offerUrl, {
        method: 'POST',
        body: offer.sdp,
        headers: {
          ...(sess.offerHeaders || {}),
          Authorization: `Bearer ${sess.clientSecret}`,
          'Content-Type': 'application/sdp',
        },
      });
      if (!r.ok) throw new Error(`WebRTC setup failed (${r.status})`);
      const answer = await r.text();
      if (!this.pc) return;
      await pc.setRemoteDescription({ type: 'answer', sdp: answer });
      void this.pollEvents(sess.voiceSessionId);
      cancelAnimationFrame(this.raf);
      this.loop();
    } catch (e) {
      const blocked = (e as DOMException)?.name === 'NotAllowedError';
      this.end(blocked ? 'Microphone blocked' : 'Talk failed');
      this.toast.show(
        blocked
          ? `Allow microphone access to talk to ${this.name}.`
          : `Talk failed: ${(e as Error).message || e}`,
      );
    }
  }

  private cleanup(): void {
    try {
      this.pc?.close();
    } catch {
      /* already closed */
    }
    this.pc = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.audioEl) {
      this.audioEl.srcObject = null;
      this.audioEl.remove();
      this.audioEl = null;
    }
    if (this.actx) {
      this.actx.close().catch(() => {});
      this.actx = null;
    }
    this.micAn = this.outAn = null;
  }

  end(why?: string): void {
    const was = this.active();
    this.live.set(false);
    this.connecting.set(false);
    this.speaking.set(false);
    this.thinking.set(false);
    this.turnRole = this.turnText = '';
    this.ptt.set(false);
    this.held.set(false);
    clearInterval(this.idleTimer);
    if (this.sess) {
      const id = this.sess.voiceSessionId;
      this.sess = null;
      void this.api.post('talk/close', { voiceSessionId: id }).catch(() => {});
    }
    this.cleanup();
    cancelAnimationFrame(this.raf);
    document.documentElement.style.setProperty('--level', '0');
    this.status.set({ kind: 'off', text: why || 'Talk off', meta: '' });
    if (was && why) this.resp.set(why);
  }

  toggle(): void {
    if (this.active()) this.end('Talk off');
    else {
      this.ptt.set(false);
      void this.start();
    }
  }

  /** A typed turn into the same OpenClaw session, with or without a live call. */
  async say(text: string): Promise<void> {
    const t = (text || '').trim();
    if (!t) return;
    this.typing.update((n) => n + 1);
    this.turnRole = '';
    this.show('You', t, `${this.name} is on it…`);
    try {
      const r = await this.api.post<ChatResponse>('chat', { text: t });
      this.lastTyped = String(r.answer || '').trim();
      this.lastTypedAt = Date.now();
      this.show(
        this.name,
        (r.answer || r.error || 'Done.').replace(/\s+\n/g, '\n').slice(0, 600),
        r.error
          ? `${this.name} couldn’t finish that run`
          : `Reply from ${this.name}${this.live() ? ' · voice still live' : ''}`,
      );
    } catch (e) {
      this.resp.set(`Message failed: ${(e as Error).message}`);
    }
    this.typing.update((n) => Math.max(0, n - 1));
  }

  /**
   * A reply this page didn't just show: a report on delegated work that finished later. Replies to a typed
   * message come back through say(), and answers on a live call are spoken. Returns true when announced.
   */
  report(r: Reply): boolean {
    const text = String(r?.text || '').trim();
    if (!text) return false;
    if (
      (this.lastTyped && text === this.lastTyped) ||
      (this.lastTypedAt && r.ts && Math.abs(r.ts - this.lastTypedAt) < 20e3)
    )
      return false;
    if (this.live() && (this.thinking() || Date.now() - this.consultEndAt < 30e3)) return false;
    const one = text.replace(/\s+/g, ' ');
    if (!this.live() && !this.typing()) {
      this.turnRole = '';
      this.show(
        this.name,
        one.slice(0, 600),
        `Report from ${this.name} · ${this.fmt.time(r.ts || Date.now())} ${this.fmt.zone}`,
      );
    }
    this.toast.show(`${this.name}: ${one.length > 140 ? `${one.slice(0, 139)}…` : one}`);
    return true;
  }
}
