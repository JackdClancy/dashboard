// calendar-lib.mjs — shared calendar data access for the bridge scripts.
//
// Reads and writes are deliberately split across two different mechanisms:
//
// - READS (readUpcomingEvents) parse the same ICS export + bridge-events
//   ledger that sync-calendar.mjs already uses for the dashboard tile — fast
//   (plain text), but only as fresh as the last ICS re-export (or live if
//   CALENDAR_ICS points at a webcal:// URL) plus whatever this bridge has
//   written to the ledger itself.
// - WRITES (addEvent/updateEvent/deleteEvent) go through Calendar.app via
//   JXA (osascript). This is unavoidable for actually mutating the calendar,
//   but it is NOT fast and NOT consistent: measured against Jack's
//   ~550-event Personal calendar, `whose()` lookups (needed for
//   update/delete-by-uid) took anywhere from ~40s to 150s+ across runs,
//   because Calendar.app's scripting bridge evaluates the predicate against
//   its entire event history, not just the matches — and that cost seems to
//   vary run to run. A plain create (addEvent/push) is fast (a few seconds)
//   since it doesn't need to scan anything. This is why updateEvent/
//   deleteEvent are NOT used for bulk reads — only for single, deliberate
//   mutations — and why their osascript timeout is set generously (5 min):
//   killing the process mid-operation doesn't cleanly abort the edit, it can
//   leave it PARTIALLY APPLIED (e.g. title changed but not the time,
//   observed directly while building this) since each property write is its
//   own Apple Event round-trip within the one script. A slow-but-uninterrupted
//   run is much safer than a fast timeout.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// A function, not a frozen constant: callers may load .env (process.loadEnvFile)
// after this module is first imported, and CALENDAR_NAME must reflect that.
export function defaultCalendar() {
  return process.env.CALENDAR_NAME || 'Personal';
}
const DAY_MS = 86400000;

function runJXA(script, args = [], timeoutMs = 30000) {
  return execFileSync('osascript', ['-l', 'JavaScript', '-e', script, ...args.map(String)],
    { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }).trim();
}

// ── Reads: ICS export + bridge-events ledger (fast) ────────────────
// Extracted from sync-calendar.mjs's parser so both scripts stay in sync.

function prop(block, name) {
  const m = block.match(new RegExp(`^${name}(;[^:]*)?:(.*)$`, 'm'));
  return m ? { params: m[1] || '', value: m[2].trim() } : null;
}

function parseDt(p) {
  if (!p) return null;
  const v = p.value;
  if (/VALUE=DATE(?!-)/.test(p.params) || /^\d{8}$/.test(v)) {
    return { date: new Date(+v.slice(0, 4), +v.slice(4, 6) - 1, +v.slice(6, 8)), allDay: true };
  }
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z?)$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  const date = z === 'Z'
    ? new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0)))
    : new Date(+y, +mo - 1, +d, +h, +mi, +(s || 0));
  return { date, allDay: false };
}

function parseRrule(v) {
  const r = {};
  for (const part of v.split(';')) {
    const [k, val] = part.split('=');
    r[k] = val;
  }
  return r;
}

const BYDAY_NUM = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

// Occurrence Dates of an RRULE inside [windowStart, windowEnd) (pragmatic subset).
function expand(start, rule, windowStart, windowEnd) {
  const out = [];
  const interval = +(rule.INTERVAL || 1);
  const until = rule.UNTIL ? (parseDt({ params: '', value: rule.UNTIL })?.date ?? windowEnd) : null;
  let count = rule.COUNT ? +rule.COUNT : Infinity;
  const bydays = rule.FREQ === 'WEEKLY' && rule.BYDAY
    ? rule.BYDAY.split(',').map(d => BYDAY_NUM[d]).filter(n => n !== undefined)
    : null;

  let cur = new Date(start);
  for (let i = 0; i < 5000 && count > 0; i++) {
    if (until && cur > until) break;
    if (cur >= windowEnd) break;

    if (bydays) {
      const weekStart = new Date(cur.getTime() - cur.getDay() * DAY_MS);
      for (const dow of bydays) {
        const occ = new Date(weekStart.getTime() + dow * DAY_MS);
        occ.setHours(start.getHours(), start.getMinutes(), 0, 0);
        if (occ < start || count <= 0) continue;
        if (until && occ > until) continue;
        count--;
        if (occ >= windowStart && occ < windowEnd) out.push(new Date(occ));
      }
    } else {
      count--;
      if (cur >= windowStart) out.push(new Date(cur));
    }

    if (rule.FREQ === 'DAILY') cur = new Date(cur.getTime() + interval * DAY_MS);
    else if (rule.FREQ === 'WEEKLY') cur = new Date(cur.getTime() + interval * 7 * DAY_MS);
    else if (rule.FREQ === 'MONTHLY') cur = new Date(cur.getFullYear(), cur.getMonth() + interval, cur.getDate(), cur.getHours(), cur.getMinutes());
    else if (rule.FREQ === 'YEARLY') cur = new Date(cur.getFullYear() + interval, cur.getMonth(), cur.getDate(), cur.getHours(), cur.getMinutes());
    else break;
  }
  return out;
}

const pad = n => String(n).padStart(2, '0');

// ICS text → [{ date, time, title, uid }] within [windowStart, windowEnd).
export function parseIcsEvents(ics, windowStart, windowEnd) {
  const unfolded = ics.replace(/\r?\n[ \t]/g, '');
  const vevents = unfolded.split('BEGIN:VEVENT').slice(1).map(b => b.split('END:VEVENT')[0]);
  const events = [];

  for (const block of vevents) {
    const summary = prop(block, 'SUMMARY')?.value.replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\n/g, ' ');
    const dtstart = parseDt(prop(block, 'DTSTART'));
    if (!summary || !dtstart) continue;
    if (prop(block, 'STATUS')?.value === 'CANCELLED') continue;
    const uid = prop(block, 'UID')?.value || null;

    const rruleProp = prop(block, 'RRULE');
    const occurrences = rruleProp
      ? expand(dtstart.date, parseRrule(rruleProp.value), windowStart, windowEnd)
      : (dtstart.date >= windowStart && dtstart.date < windowEnd ? [dtstart.date] : []);

    for (const occ of occurrences) {
      events.push({
        date: `${occ.getFullYear()}-${pad(occ.getMonth() + 1)}-${pad(occ.getDate())}`,
        time: dtstart.allDay ? null : `${pad(occ.getHours())}:${pad(occ.getMinutes())}`,
        title: summary,
        uid,
      });
    }
  }
  return events;
}

// Fetch/read the configured ICS source + merge in the bridge-events ledger
// (dedupe by date+title, same as sync-calendar.mjs), pruning stale ledger
// entries as a side effect. → sorted [{ date, time, title, uid }].
export async function readUpcomingEvents({ horizonDays = 30 } = {}) {
  const icsSource = process.env.CALENDAR_ICS || join(homedir(), 'Downloads', 'Personal.ics');
  const vaultDir = process.env.VAULT_DIR || join(homedir(), 'JC AI Brain');
  const ledgerPath = join(vaultDir, '09-calendar', '(AI) bridge-events.json');

  let ics = '';
  if (/^(https?|webcal):/.test(icsSource)) {
    try {
      const res = await fetch(icsSource.replace(/^webcal:/, 'https:'), { signal: AbortSignal.timeout(15000) });
      if (res.ok) ics = await res.text();
    } catch { /* fall through with ledger-only data */ }
  } else {
    try { ics = readFileSync(icsSource, 'utf8'); } catch { /* fall through with ledger-only data */ }
  }

  const now = new Date();
  const windowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const windowEnd = new Date(windowStart.getTime() + horizonDays * DAY_MS);
  const events = ics ? parseIcsEvents(ics, windowStart, windowEnd) : [];

  try {
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    const cutoff = new Date(windowStart.getTime() - 2 * DAY_MS).toISOString().slice(0, 10);
    const kept = ledger.filter(ev => ev.date >= cutoff);
    const have = new Set(events.map(e => e.date + '|' + e.title.toLowerCase()));
    for (const ev of kept) {
      if (ev.date >= windowStart.toISOString().slice(0, 10) &&
          !have.has(ev.date + '|' + ev.title.toLowerCase())) {
        events.push({ date: ev.date, time: ev.time, title: ev.title, uid: ev.uid || null });
      }
    }
    if (kept.length !== ledger.length) writeFileSync(ledgerPath, JSON.stringify(kept, null, 2));
  } catch { /* no ledger yet */ }

  return events.sort((a, b) => (a.date + (a.time || '')) < (b.date + (b.time || '')) ? -1 : 1);
}

// ── Writes: Calendar.app via JXA ────────────────────────────────────

// → { uid } of the newly created event. Fast — no whose()/scan involved.
export function addEvent({ calendarName = defaultCalendar(), title, date, time }) {
  const script = `
function run(argv) {
  const [calName, title, y, mo, d, h, mi, allDayFlag] = argv;
  const Cal = Application('Calendar');
  const cals = Cal.calendars.whose({ name: calName });
  if (cals.length === 0) throw new Error('Calendar not found: ' + calName);
  const cal = cals[0];
  const isAllDay = allDayFlag === '1';
  const start = new Date(Number(y), Number(mo) - 1, Number(d), isAllDay ? 0 : Number(h), isAllDay ? 0 : Number(mi), 0);
  const durationMin = isAllDay ? 24 * 60 : 60;
  const end = new Date(start.getTime() + durationMin * 60000);
  const ev = Cal.Event({ summary: title, startDate: start, endDate: end, alldayEvent: isAllDay });
  cal.events.push(ev);
  return ev.uid();
}`;
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time ? time.split(':').map(Number) : [0, 0];
  const uid = runJXA(script, [calendarName, title, y, mo, d, h, mi, time ? '0' : '1']);
  return { uid };
}

// Slow (up to a few minutes): locates the event via whose({uid}), a full-collection
// scan in Calendar.app's scripting bridge. Only ever call this for a single,
// deliberate edit — never in a loop over many events.
// Only fields explicitly passed (non-undefined) are changed; date/time
// changes carry over the event's existing duration.
export function updateEvent({ calendarName = defaultCalendar(), uid, title, date, time }) {
  const script = `
function run(argv) {
  const [calName, uid, title, hasTitle, y, mo, d, hasDate, h, mi, hasTime] = argv;
  const Cal = Application('Calendar');
  const cals = Cal.calendars.whose({ name: calName });
  if (cals.length === 0) throw new Error('Calendar not found: ' + calName);
  const cal = cals[0];
  const matches = cal.events.whose({ uid: uid });
  if (matches.length === 0) throw new Error('Event not found: ' + uid);
  const ev = matches[0];
  if (hasTitle === '1') ev.summary = title;
  if (hasDate === '1' || hasTime === '1') {
    const cur = ev.startDate();
    const curEnd = ev.endDate();
    const durationMs = curEnd.getTime() - cur.getTime();
    let isAllDay = ev.alldayEvent();
    if (hasTime === '1') isAllDay = false;
    const ny = hasDate === '1' ? Number(y) : cur.getFullYear();
    const nmo = hasDate === '1' ? Number(mo) - 1 : cur.getMonth();
    const nd = hasDate === '1' ? Number(d) : cur.getDate();
    const nh = hasTime === '1' ? Number(h) : (isAllDay ? 0 : cur.getHours());
    const nmi = hasTime === '1' ? Number(mi) : (isAllDay ? 0 : cur.getMinutes());
    const newStart = new Date(ny, nmo, nd, nh, nmi, 0);
    const newDuration = isAllDay ? 24 * 60 * 60000 : (durationMs > 0 ? durationMs : 60 * 60000);
    ev.alldayEvent = isAllDay;
    ev.startDate = newStart;
    ev.endDate = new Date(newStart.getTime() + newDuration);
  }
  return 'ok';
}`;
  const [y, mo, d] = date ? date.split('-').map(Number) : [0, 0, 0];
  const [h, mi] = time ? time.split(':').map(Number) : [0, 0];
  runJXA(script, [calendarName, uid, title || '', title !== undefined ? '1' : '0', y, mo, d, date !== undefined ? '1' : '0', h, mi, time !== undefined ? '1' : '0'], 300000);
}

// Slow (up to a few minutes) — see updateEvent.
export function deleteEvent({ calendarName = defaultCalendar(), uid }) {
  const script = `
function run(argv) {
  const [calName, uid] = argv;
  const Cal = Application('Calendar');
  const cals = Cal.calendars.whose({ name: calName });
  if (cals.length === 0) throw new Error('Calendar not found: ' + calName);
  const cal = cals[0];
  const matches = cal.events.whose({ uid: uid });
  if (matches.length === 0) throw new Error('Event not found: ' + uid);
  matches[0].delete();
  return 'ok';
}`;
  runJXA(script, [calendarName, uid], 300000);
}

// ── Dedupe / fuzzy matching (pure JS, no osascript) ────────────────

function normalizeTitle(t) {
  return String(t || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function titleSimilarity(a, b) {
  const na = normalizeTitle(a), nb = normalizeTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.85;
  const wa = new Set(na.split(' ')), wb = new Set(nb.split(' '));
  const inter = [...wa].filter(w => wb.has(w)).length;
  const union = new Set([...wa, ...wb]).size;
  return union === 0 ? 0 : inter / union;
}

// Same-day + fuzzy-title match against a list of { title, date, ... }
// candidates (as returned by readUpcomingEvents). Returns the best match at
// or above threshold, or null.
export function findDuplicate({ title, date, candidates, threshold = 0.6 }) {
  let best = null, bestScore = 0;
  for (const c of candidates) {
    if (c.date !== date) continue;
    const score = titleSimilarity(title, c.title);
    if (score >= threshold && score > bestScore) { best = c; bestScore = score; }
  }
  return best;
}
