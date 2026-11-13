import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { Approvals, KIND_LABEL } from '../core/approvals';
import { clip, Fmt } from '../core/fmt';
import type { QueueEntry } from '../core/state-store';
import { Drawer } from '../core/ui';

/** One request in the Needs-you card or the queue drawer: what, who, when, and two-tap decision buttons. */
@Component({
  selector: 'cc-approval-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let e = entry();
    @let it = e.item;
    <div class="lq-item" [attr.data-kind]="it.kind" [attr.data-state]="e.action?.state || ''">
      <button type="button" class="lq-main" (click)="drawer.open(e.key)">
        <span class="lq-meta">
          <span class="lq-badge kind">{{ kindLabel(it.kind) }}</span>
          @if (it.kind === 'file') {
            <code>{{ it.id }}</code>
          }
          {{ meta() }}
          @if (it.gated) {
            <span class="lq-badge gate">{{ it.gatedLabel || 'Gated' }}</span>
          } @else if (it.status === 'partial') {
            <span class="lq-badge">Partly done</span>
          } @else if (!it.open) {
            <span class="lq-badge">{{ it.status }}</span>
          }
          @if (it.severity === 'critical') {
            <span class="lq-badge warn">critical</span>
          }
        </span>
        <span class="lq-title">
          @if (it.kind === 'exec' && it.command) {
            <code>{{ clip(it.command, 160) }}</code>
          } @else {
            {{ clip(it.title, 120) }}
          }
        </span>
      </button>
      @if (approvals.showButtons(e)) {
        <div class="lq-actions">
          @for (d of decisions(); track d; let i = $index) {
            <button
              type="button"
              class="lq-btn"
              [class.approve]="d === 'approve' || d === 'allow-once'"
              [class.always]="d === 'allow-always'"
              [class.deny]="d === 'deny'"
              [class.armed]="approvals.isArmed(e, d)"
              [disabled]="approvals.busy(e)"
              (click)="approvals.act(e, d)"
            >
              {{ approvals.label(e, d) }}
            </button>
          }
        </div>
      }
      @if (approvals.statusText(e); as st) {
        <p class="lq-status" [class]="st.cls">{{ st.text }}</p>
      }
    </div>
  `,
})
export class ApprovalRow {
  protected readonly approvals = inject(Approvals);
  protected readonly drawer = inject(Drawer);
  private readonly fmt = inject(Fmt);
  protected readonly clip = clip;

  readonly entry = input.required<QueueEntry>();
  /** Offer every decision (drawer) or just the everyday ones (card). */
  readonly full = input(false);

  protected readonly decisions = computed(() =>
    this.full() ? this.entry().item.decisions : this.approvals.compact(this.entry().item),
  );

  protected kindLabel(k: string): string {
    return KIND_LABEL[k] ?? k;
  }

  protected meta(): string {
    const it = this.entry().item;
    const who = it.requester.name ? it.requester.name.split(/\s+/)[0] : it.agentId;
    const parts = [who, this.fmt.ago(it.updatedAt ?? it.createdAt)];
    if (it.open && it.expiresAt) parts.push(`expires ${this.fmt.until(it.expiresAt)}`);
    return parts.filter(Boolean).join(' · ');
  }
}
