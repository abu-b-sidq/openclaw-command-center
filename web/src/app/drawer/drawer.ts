import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import type { ApprovalItem, Decision } from '../../../../shared/api';
import { Approvals, KIND_LABEL } from '../core/approvals';
import { clip, Fmt } from '../core/fmt';
import { controlUiLink, sessionUrl } from '../core/links';
import { markdown } from '../core/markdown';
import { Session } from '../core/session';
import { StateStore, waitingOnYou, type QueueEntry } from '../core/state-store';
import { Drawer } from '../core/ui';
import { ApprovalRow } from '../shared/approval-row';
import { Icon } from '../shared/icon';

interface Fact {
  label: string;
  value: string;
  code?: boolean;
  md?: boolean;
}

/**
 * The side drawer: the whole queue, one request in full (every fact, the markdown sections, all decisions),
 * or the assistant's reports. Esc or the scrim closes it.
 */
@Component({
  selector: 'cc-drawer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ApprovalRow, Icon],
  host: { '(document:keydown.escape)': 'drawer.close()' },
  template: `
    <div class="lv-drawer" [class.open]="shown()" [hidden]="!mounted()">
      <div class="lv-scrim" (click)="drawer.close()"></div>
      <aside
        #panel
        class="lv-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lv-title"
        tabindex="-1"
      >
        <header class="lv-head">
          @if (detail()) {
            <button
              type="button"
              class="icon-button"
              aria-label="Back to the queue"
              (click)="drawer.open('queue')"
            >
              <cc-icon name="back" />
            </button>
          }
          <h2 id="lv-title">{{ title() }}</h2>
          <button type="button" class="icon-button" aria-label="Close" (click)="drawer.close()">
            <cc-icon name="close" />
          </button>
        </header>
        <div class="lv-body">
          @switch (mode()) {
            @case ('queue') {
              @if (!store.state()) {
                <p class="lv-empty">{{ store.error() ? store.errorText() : 'Loading…' }}</p>
              } @else {
                @if (store.state()!.dryRun) {
                  <p class="lv-dry">
                    Dry run: decisions are recorded here, but nothing is sent to the gateway.
                  </p>
                }
                <h3 class="lv-sec">
                  Waiting on you <span>{{ waiting().length }}</span>
                </h3>
                @for (e of waiting(); track e.key) {
                  <cc-approval-row [entry]="e" [full]="true" />
                } @empty {
                  <p class="lv-empty">Nothing is waiting on you.</p>
                }
                @if (handled().length) {
                  <h3 class="lv-sec">Just handled</h3>
                  @for (e of handled(); track e.key) {
                    <cc-approval-row [entry]="e" [full]="true" />
                  }
                }
                @if (closed().length) {
                  <h3 class="lv-sec">Closed recently</h3>
                  <div class="lv-closed">
                    @for (a of closed(); track a.kind + a.id) {
                      <button
                        type="button"
                        class="lv-closed-row"
                        (click)="drawer.open(a.kind + ':' + a.id)"
                      >
                        <code>{{ a.id }}</code><span>{{ clip(a.title, 96) }}</span
                        ><em>{{ clip(a.statusLine, 70) }}</em>
                      </button>
                    }
                  </div>
                }
              }
            }
            @case ('reports') {
              @for (r of reports(); track r.id) {
                <section class="lv-block">
                  <h4>{{ r.when }}</h4>
                  <div class="lv-md" [innerHTML]="r.html"></div>
                </section>
              } @empty {
                <p class="lv-empty">Nothing from {{ session.assistant() }} yet.</p>
              }
            }
            @default {
              @if (detail(); as d) {
                <div class="lv-meta-row">
                  <span class="lq-badge kind">{{ kindLabel(d.item.kind) }}</span>
                  <span class="lq-badge">{{ d.item.status }}</span>
                  @if (d.item.gated) {
                    <span class="lq-badge gate">{{ d.item.gatedLabel || 'Gated' }}</span>
                  }
                  @if (d.item.severity === 'critical') {
                    <span class="lq-badge warn">critical</span>
                  }
                  <span>{{ d.meta }}</span>
                </div>
                <p class="lv-title">
                  @if (d.item.kind === 'exec' && d.item.command) {
                    <code>{{ d.item.command }}</code>
                  } @else {
                    {{ d.item.title }}
                  }
                </p>
                <dl class="lv-facts">
                  @for (f of d.facts; track f.label) {
                    <dt>{{ f.label }}</dt>
                    @if (f.md) {
                      <dd [innerHTML]="md(f.value)"></dd>
                    } @else if (f.code) {
                      <dd>
                        <code>{{ f.value }}</code>
                      </dd>
                    } @else {
                      <dd>{{ f.value }}</dd>
                    }
                  }
                </dl>
                @if (approvals.statusText(d.entry); as st) {
                  <p class="lq-status lv-result" [class]="st.cls">{{ st.text }}</p>
                }
                @for (s of d.sections; track s.title) {
                  <section class="lv-block" [class]="s.cls">
                    <h4>{{ s.title }}</h4>
                    <div class="lv-md" [innerHTML]="md(s.body)"></div>
                  </section>
                }
                @if (d.links.length) {
                  <p class="lv-note">
                    @for (l of d.links; track l.href) {
                      <a [href]="l.href" target="_blank" rel="noopener noreferrer"
                        >{{ l.label }} ↗</a
                      >&nbsp;
                    }
                  </p>
                }
                @if (d.item.raw) {
                  <details class="lv-raw">
                    <summary>
                      Full request{{ d.item.fileName ? ' · ' + d.item.fileName : '' }}
                    </summary>
                    <pre>{{ d.item.raw }}</pre>
                  </details>
                }
              } @else {
                <p class="lv-empty">This request is no longer in the list.</p>
              }
            }
          }
        </div>
        @if (detail(); as d) {
          @if (approvals.showButtons(d.entry)) {
            <footer class="lv-foot">
              <div class="lq-actions">
                @for (dec of d.item.decisions; track dec) {
                  <button
                    type="button"
                    class="lq-btn"
                    [class.approve]="dec === 'approve' || dec === 'allow-once'"
                    [class.always]="dec === 'allow-always'"
                    [class.deny]="dec === 'deny'"
                    [class.armed]="approvals.isArmed(d.entry, dec)"
                    [disabled]="approvals.busy(d.entry)"
                    (click)="decide(d.entry, dec)"
                  >
                    {{ approvals.label(d.entry, dec) }}
                  </button>
                }
              </div>
              @if (d.item.note) {
                <p class="lv-note">{{ d.item.note }}</p>
              }
            </footer>
          }
        }
      </aside>
    </div>
  `,
})
export class DrawerPanel {
  protected readonly drawer = inject(Drawer);
  protected readonly store = inject(StateStore);
  protected readonly session = inject(Session);
  protected readonly approvals = inject(Approvals);
  private readonly fmt = inject(Fmt);
  private readonly panel = viewChild<ElementRef<HTMLElement>>('panel');
  protected readonly clip = clip;

  /** In the DOM (not hidden) and slid in (.open): two steps, so the slide animates both ways. */
  protected readonly mounted = signal(false);
  protected readonly shown = signal(false);

  protected readonly mode = computed(() => {
    const v = this.drawer.view();
    return v === 'queue' || v === 'reports' ? v : 'detail';
  });

  protected readonly waiting = computed(() => this.store.queue().filter(waitingOnYou));
  protected readonly handled = computed(() => this.store.queue().filter((e) => !waitingOnYou(e)));
  /** File requests closed recently that the queue no longer shows. */
  protected readonly closed = computed(() => {
    const inQueue = new Set(this.store.queue().map((e) => e.key));
    return this.store
      .approvals()
      .filter((a) => !a.open && !inQueue.has(`${a.kind}:${a.id}`))
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, 10);
  });

  protected readonly reports = computed(() => {
    const zone = this.fmt.zone ? ` ${this.fmt.zone}` : '';
    return [...(this.store.state()?.replies ?? [])].reverse().map((r) => ({
      id: r.id,
      when: r.ts ? `${this.fmt.when(r.ts)}${zone}` : 'Earlier',
      html: markdown(r.text),
    }));
  });

  protected readonly detail = computed(() => {
    const v = this.drawer.view();
    if (!v || this.mode() !== 'detail') return null;
    const entry = this.store.queue().find((e) => e.key === v) ?? this.closedEntry(v);
    if (!entry) return null;
    const it = entry.item,
      f = this.fmt,
      ui = this.session.boot()?.ui.controlUiUrl;
    const facts: Fact[] = [];
    const add = (label: string, value: string | null | undefined, opt: Partial<Fact> = {}) => {
      if (value) facts.push({ label, value, ...opt });
    };
    add('Requester', [it.requester.name, it.requester.detail].filter(Boolean).join(' · ') || null);
    add('Agent', it.agentId);
    add('Session', it.sessionKey, { code: true });
    add('Host', it.host);
    add('Working dir', it.cwd, { code: true });
    add(
      'Security',
      [it.security, it.ask ? `ask ${it.ask}` : ''].filter(Boolean).join(' · ') || null,
    );
    add('Plugin', it.pluginId, { code: true });
    add('Logged', it.logged);
    add('Status', it.statusLine);
    add('Depends on', it.dependsOn, { md: true });
    add(
      'Expires',
      it.open && it.expiresAt
        ? `${f.when(it.expiresAt)} ${f.zone} (${f.until(it.expiresAt)})`
        : null,
    );
    for (const x of it.extras ?? []) add(x.label, x.value);

    const sections: { title: string; body: string; cls: string }[] = [];
    const sec = (title: string, body: string | null | undefined, cls = '') => {
      if (body) sections.push({ title, body, cls });
    };
    const reply = entry.action?.reply;
    if (reply && reply.length > 180)
      sec(`${it.kind === 'file' ? 'The agent’s' : 'The gateway’s'} reply`, reply, 'reply');
    sec('Their words', it.theirWords, 'quote');
    sec('What will run', it.action);
    sec('Description', it.description);
    sec('Details', it.detail);
    sec('Risk', it.risk);
    sec('Rollback', it.rollback);
    sec('Notes', it.intro);
    for (const s of it.sections ?? []) sec(s.title, s.body);

    const links: { href: string; label: string }[] = [];
    const approvalLink = controlUiLink(ui, it.urlPath);
    if (approvalLink) links.push({ href: approvalLink, label: 'Open in the Control UI' });
    const sess = sessionUrl(ui, it.sessionKey);
    if (sess && sess !== approvalLink)
      links.push({ href: sess, label: 'Open the requesting session' });

    const meta = [
      `updated ${f.ago(it.updatedAt ?? it.createdAt)}`,
      it.createdAt ? `asked ${f.when(it.createdAt)} ${f.zone}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    return { entry, item: it, facts, sections, links, meta };
  });

  protected readonly title = computed(() => {
    const m = this.mode();
    if (m === 'queue') return 'Waiting on you';
    if (m === 'reports') return `${this.session.assistant()}’s reports`;
    const d = this.detail();
    return d
      ? `${KIND_LABEL[d.item.kind] ?? 'Request'} ${d.item.kind === 'file' ? d.item.id : 'approval'}`
      : 'Request';
  });

  constructor() {
    let hideTimer = 0;
    effect(() => {
      const open = !!this.drawer.view();
      untracked(() => {
        clearTimeout(hideTimer);
        document.body.classList.toggle('drawer-open', open);
        if (open) {
          this.mounted.set(true);
          requestAnimationFrame(() => {
            this.shown.set(true);
            this.panel()?.nativeElement.focus({ preventScroll: true });
          });
        } else {
          this.shown.set(false);
          hideTimer = window.setTimeout(() => this.mounted.set(false), 230);
        }
      });
    });
    // A new view starts at the top.
    effect(() => {
      this.drawer.view();
      untracked(() => {
        const body = this.panel()?.nativeElement.querySelector('.lv-body');
        if (body) body.scrollTop = 0;
      });
    });
  }

  /** A request that left the queue (closed, or decided long ago) can still be opened from "Closed recently". */
  private closedEntry(key: string): QueueEntry | null {
    const it = this.store.approvals().find((a: ApprovalItem) => `${a.kind}:${a.id}` === key);
    if (!it) return null;
    return {
      key,
      item: it,
      action: this.store.actionFor(it.kind, it.id),
      ts: it.updatedAt ?? it.createdAt ?? 0,
    };
  }

  protected kindLabel(k: string): string {
    return KIND_LABEL[k] ?? k;
  }

  protected md(src: string): string {
    return markdown(src);
  }

  protected decide(e: QueueEntry, d: Decision): void {
    void this.approvals.act(e, d);
  }
}
