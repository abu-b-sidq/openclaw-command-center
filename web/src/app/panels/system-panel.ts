import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Fmt } from '../core/fmt';
import { StateStore } from '../core/state-store';
import { Icon, type IconName } from '../shared/icon';

interface Row {
  icon: IconName;
  label: string;
  value: string;
  cls: string;
  tip?: string;
}

@Component({
  selector: 'article[ccSystemPanel]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  host: { class: 'cc-panel', 'data-panel': 'system' },
  template: `
    <header class="cc-ph">
      <h2><cc-icon name="cpu" /> System overview</h2>
      <span class="cc-ph-r">{{ version() }}</span>
    </header>
    <div class="cc-sysgrid">
      <ul class="cc-kv">
        @for (r of rows(); track r.label) {
          <li [title]="r.tip || ''">
            <cc-icon [name]="r.icon" /><span>{{ r.label }}</span
            ><b [class]="r.cls">{{ r.value }}</b>
          </li>
        } @empty {
          <li class="cc-skel"></li>
          <li class="cc-skel"></li>
          <li class="cc-skel"></li>
          <li class="cc-skel"></li>
        }
      </ul>
      <div
        class="cc-ring"
        [class.warn]="h()?.level === 'warn'"
        [class.bad]="h()?.level === 'bad'"
        [style.--p]="ringPct()"
      >
        <svg viewBox="0 0 120 120" aria-hidden="true">
          <circle class="t" cx="60" cy="60" r="50" />
          <circle class="v" cx="60" cy="60" r="50" pathLength="100" />
        </svg>
        <b>{{ h() ? h()!.passing + '/' + h()!.checks.length : '–' }}</b><small>checks ok</small>
      </div>
    </div>
  `,
})
export class SystemPanel {
  private readonly store = inject(StateStore);
  private readonly fmt = inject(Fmt);
  protected readonly h = this.store.health;
  protected readonly version = computed(() => {
    const v = this.store.state()?.system.status?.version;
    return v ? `v${v}` : '';
  });
  protected readonly ringPct = computed(() => {
    const h = this.h();
    return h ? Math.round((h.passing / h.checks.length) * 100) : 0;
  });

  protected readonly rows = computed<Row[]>(() => {
    const s = this.store.state();
    if (!s) return [];
    const f = this.fmt;
    const el = s.system.channels?.eventLoop,
      host = s.host,
      wal = s.system.status?.wal,
      pl = s.system.health?.plugins;
    const rows: Row[] = [];
    if (el?.cpu != null)
      rows.push({
        icon: 'cpu',
        label: 'Gateway CPU',
        value: `${f.pct(el.cpu)}%`,
        cls: el.cpu > 0.9 ? 'warn' : '',
      });
    if (host?.mem?.total) {
      const used = 1 - host.mem.available / host.mem.total;
      rows.push({
        icon: 'chip',
        label: 'Memory',
        value: `${f.pct(used)}%`,
        cls: used > 0.9 ? 'warn' : '',
        tip: `${f.bytes(host.mem.total - host.mem.available)} of ${f.bytes(host.mem.total)}`,
      });
    }
    if (host?.disk?.total) {
      const used = 1 - host.disk.free / host.disk.total;
      rows.push({
        icon: 'disk',
        label: 'Disk',
        value: `${f.pct(used)}%`,
        cls: used > 0.9 ? 'warn' : '',
        tip: `${f.bytes(host.disk.free)} free`,
      });
    }
    if (el)
      rows.push({
        icon: 'pulse',
        label: 'Event loop',
        value: `${Math.round(el.p99 || 0)} ms`,
        cls: el.degraded ? 'bad' : (el.p99 ?? 0) > 250 ? 'warn' : '',
        tip: `p99 delay · ${f.pct(el.utilization)}% busy`,
      });
    if (host?.gatewayRss)
      rows.push({
        icon: 'server',
        label: 'Gateway RSS',
        value: f.bytes(host.gatewayRss),
        cls: host.gatewayRss > 6e9 ? 'warn' : '',
      });
    if (host?.uptime)
      rows.push({ icon: 'clock', label: 'Uptime', value: f.uptime(host.uptime), cls: '' });
    if (wal?.dbBytes != null)
      rows.push({
        icon: 'db',
        label: 'Database',
        value: f.bytes(wal.dbBytes) + (wal.warning ? ' · WAL warning' : ''),
        cls: wal.warning ? 'warn' : '',
      });
    if (pl)
      rows.push({
        icon: 'plug',
        label: 'Plugins',
        value: `${pl.loaded} loaded${pl.errors.length ? ` · ${pl.errors.length} errors` : ''}`,
        cls: pl.errors.length ? 'bad' : '',
      });
    if (!s.gateway.connected)
      rows.unshift({
        icon: 'alert',
        label: 'Gateway',
        value: 'unreachable',
        cls: 'bad',
        tip: s.gateway.error || '',
      });
    return rows.slice(0, 6);
  });
}
