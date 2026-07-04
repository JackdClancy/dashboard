#!/usr/bin/env node
// Feature #7a: calendar → app tile.
//
// Parses an ICS export (Apple Calendar) and writes the next 14 days of
// events to Supabase app_state (key 'calendar') for the home page tile.
// Handles all-day and timed events, and a pragmatic RRULE subset
// (DAILY/WEEKLY/MONTHLY/YEARLY with INTERVAL/UNTIL/COUNT, BYDAY for weekly).
// TZID times are treated as this Mac's local time (both are NZ).
//
// Usage: node scripts/sync-calendar.mjs
// Env:   SUPABASE_URL, SUPABASE_ANON_KEY (.env)
//        CALENDAR_ICS — path or http(s)/webcal URL
//                       (default ~/Downloads/Personal.ics; re-export or point
//                        at an iCloud public-share URL to keep it fresh)

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

try { process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url))); } catch {}

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const ICS_SOURCE = process.env.CALENDAR_ICS || join(homedir(), 'Downloads', 'Personal.ics');
const HORIZON_DAYS = 30;
const MAX_EVENTS = 20;

if (!SUPABASE_URL || !ANON_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_ANON_KEY (set in .env or environment).');
  process.exit(1);
}

let ics;
if (/^(https?|webcal):/.test(ICS_SOURCE)) {
  const res = await fetch(ICS_SOURCE.replace(/^webcal:/, 'https:'), { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Fetch ICS → ${res.status}`);
  ics = await res.text();
} else {
  try {
    ics = readFileSync(ICS_SOURCE, 'utf8');
  } catch {
    console.log(`sync-calendar: ICS not found at ${ICS_SOURCE} — skipping.`);
    process.exit(0);
  }
}

// Unfold continuation lines, split into VEVENT blocks.
const unfolded = ics.replace(/\r?\n[ \t]/g, '');
const vevents = unfolded.split('BEGIN:VEVENT').slice(1).map(b => b.split('END:VEVENT')[0]);

function prop(block, name) {
  const m = block.match(new RegExp(`^${name}(;[^:]*)?:(.*)$`, 'm'));
  return m ? { params: m[1] || '', value: m[2].trim() } : null;
}

// → { date: Date, allDay: bool } — TZID/floating treated as local time.
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

const DAY_MS = 86400000;
const BYDAY_NUM = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const now = new Date();
const windowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
const windowEnd = new Date(windowStart.getTime() + HORIZON_DAYS * DAY_MS);

// Yields occurrence Dates of an RRULE inside the window (pragmatic subset).
function expand(start, rule) {
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
      // Weekly with BYDAY: walk each listed weekday inside this week.
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
const events = [];

for (const block of vevents) {
  const summary = prop(block, 'SUMMARY')?.value.replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\n/g, ' ');
  const dtstart = parseDt(prop(block, 'DTSTART'));
  if (!summary || !dtstart) continue;
  if (prop(block, 'STATUS')?.value === 'CANCELLED') continue;

  const rruleProp = prop(block, 'RRULE');
  const occurrences = rruleProp
    ? expand(dtstart.date, parseRrule(rruleProp.value))
    : (dtstart.date >= windowStart && dtstart.date < windowEnd ? [dtstart.date] : []);

  for (const occ of occurrences) {
    events.push({
      date: `${occ.getFullYear()}-${pad(occ.getMonth() + 1)}-${pad(occ.getDate())}`,
      time: dtstart.allDay ? null : `${pad(occ.getHours())}:${pad(occ.getMinutes())}`,
      title: summary,
    });
  }
}

events.sort((a, b) => (a.date + (a.time || '')) < (b.date + (b.time || '')) ? -1 : 1);
const upcoming = events.slice(0, MAX_EVENTS);

const res = await fetch(`${SUPABASE_URL}/rest/v1/app_state`, {
  method: 'POST',
  headers: {
    apikey: ANON_KEY,
    Authorization: `Bearer ${ANON_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'resolution=merge-duplicates',
  },
  body: JSON.stringify({
    key: 'calendar',
    data: { synced_at: new Date().toISOString(), source: ICS_SOURCE, events: upcoming },
    updated_at: new Date().toISOString(),
  }),
});
if (!res.ok) throw new Error(`Upsert app_state → ${res.status}: ${await res.text()}`);

console.log(`sync-calendar: ${upcoming.length} events in the next ${HORIZON_DAYS} days → app_state`);
