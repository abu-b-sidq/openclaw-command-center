// Optional Google Calendar + Gmail through the gog CLI (OpenClaw's Google Workspace skill). Read-only:
// the next N hours of calendar and a handful of unread important threads.
import { execFile } from 'node:child_process';
import type { CalendarEvent, MailThread } from '../../../shared/api.ts';
import type { Config } from '../config.ts';
import { arr, clip, obj, str, tsOf } from '../util.ts';

type GoogleConfig = Config['integrations']['google'];

function gog(cmd: string[], args: string[], timeout = 25000): Promise<unknown> {
  const [bin, ...pre] = cmd;
  return new Promise((resolve, reject) => {
    execFile(bin!, [...pre, ...args], { timeout, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      if (err)
        return reject(
          new Error(
            `gog: ${clip(
              String(stderr || err.message)
                .trim()
                .split('\n')
                .pop(),
              160,
            )}`,
          ),
        );
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error('gog: output was not JSON'));
      }
    });
  });
}

export async function calendar(g: GoogleConfig, timeZone: string | null): Promise<CalendarEvent[]> {
  const iso = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const now = Date.now();
  const r = await gog(g.command, [
    'calendar',
    'events',
    '--from',
    iso(now),
    '--to',
    iso(now + g.calendarHours * 3600e3),
    ...(timeZone ? ['--timezone', timeZone] : []),
    '--max',
    '25',
    '--json',
  ]);
  return arr(obj(r)['events'])
    .map(obj)
    .filter(
      (e) =>
        e['status'] !== 'cancelled' &&
        !arr(e['attendees']).some((a) => obj(a)['self'] && obj(a)['responseStatus'] === 'declined'),
    )
    .map((e) => {
      const start = obj(e['start']),
        end = obj(e['end']);
      const attendees = arr(e['attendees']).map(obj);
      return {
        title: clip(e['summary'] || '(no title)', 120),
        start: tsOf(start['dateTime'] || start['date']),
        end: tsOf(end['dateTime'] || end['date']),
        allDay: !start['dateTime'],
        link: str(e['htmlLink']),
        meet: str(e['hangoutLink']),
        location: e['location'] ? clip(e['location'], 80) : null,
        attendees: attendees.length,
        response: str(attendees.find((a) => a['self'])?.['responseStatus']),
      };
    })
    .filter((e) => e.end > now)
    .sort((a, b) => a.start - b.start);
}

const senderName = (f: unknown) => {
  const s = String(f || '');
  const m = /^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/.exec(s);
  return clip(m ? m[1] : s, 60);
};

export async function mail(g: GoogleConfig): Promise<MailThread[]> {
  const r = await gog(g.command, [
    'gmail',
    'search',
    g.mailQuery,
    '--max',
    String(g.mailMax),
    '--json',
  ]);
  return arr(obj(r)['threads'])
    .map(obj)
    .map((t) => ({
      id: String(t['id']),
      from: senderName(t['from']),
      subject: clip(t['subject'] || '(no subject)', 140),
      date: tsOf(t['date']) || null,
      count: typeof t['messageCount'] === 'number' ? t['messageCount'] : 1,
      link: `https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(String(t['id']))}`,
    }));
}
