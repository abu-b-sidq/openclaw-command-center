// Host numbers for the System overview: memory, root disk, load, uptime and, when the gateway runs on this
// machine, its resident memory. Read-only; Linux gets /proc detail, other platforms get what os.* offers.
import { readdirSync, readFileSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import os from 'node:os';
import type { HostStats } from '../../shared/api.ts';

function linuxMem(): { total: number; available: number } | null {
  try {
    const mi = readFileSync('/proc/meminfo', 'utf8');
    const kb = (k: string) =>
      Number((new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(mi) || [])[1] || 0) * 1024;
    return { total: kb('MemTotal'), available: kb('MemAvailable') };
  } catch {
    return null;
  }
}

/** RSS of the local OpenClaw gateway process, if there is one. */
function gatewayRss(): number | null {
  let pids: string[] = [];
  try {
    pids = readdirSync('/proc').filter((p) => /^\d+$/.test(p));
  } catch {
    return null;
  }
  for (const pid of pids) {
    let cmd = '';
    try {
      cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    } catch {
      continue;
    }
    if (!/openclaw[^\0]*\0gateway(\0|$)/.test(cmd) && !cmd.includes('openclaw-gateway')) continue;
    try {
      return (
        Number(
          (/^VmRSS:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8')) || [])[1] || 0,
        ) * 1024 || null
      );
    } catch {
      return null;
    }
  }
  return null;
}

export async function hostStats(): Promise<HostStats> {
  const linux = process.platform === 'linux';
  let disk: HostStats['disk'] = null;
  try {
    const s = await statfs('/');
    disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch {
    /* not available here */
  }
  return {
    mem: (linux && linuxMem()) || { total: os.totalmem(), available: os.freemem() },
    disk,
    load: os.loadavg(),
    cpus: os.cpus().length,
    uptime: os.uptime(),
    gatewayRss: linux ? gatewayRss() : null,
  };
}
