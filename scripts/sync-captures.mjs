#!/usr/bin/env node
// Feature #5 (entry point): app quick-add → vault inbox / Apple Calendar.
//
// Drains the `captures` table (home page capture bar). Each capture is
// routed:
//   - EVENT-LIKE ("Dentist appointment on the 7th at 4pm") → created in
//     Apple Calendar via osascript AND appended to the vault's bridge-events
//     ledger (09-calendar/(AI) bridge-events.json) so the dashboard's
//     Upcoming tile shows it immediately (sync-calendar.mjs merges it).
//     Routed only when a parseable date comes with a time or an
//     appointment-ish keyword — ambiguous items stay in the inbox.
//   - EVERYTHING ELSE → a markdown file in 00-inbox/raw/ for the compile
//     skill, exactly as before.
// Rows are deleted only after the file/event is safely written.
//
// Usage: node scripts/sync-captures.mjs
// Env:   SUPABASE_URL, SUPABASE_ANON_KEY (.env), VAULT_DIR (optional),
//        CALENDAR_NAME (Apple Calendar target, default "Personal")

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

try { process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url))); } catch {}

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const VAULT_DIR = process.env.VAULT_DIR || join(homedir(), 'JC AI Brain');
const RAW_DIR = join(VAULT_DIR, '00-inbox', 'raw');
const EVENTS_PATH = join(VAULT_DIR, '09-calendar', '(AI) bridge-events.json');
const CALENDAR_NAME = process.env.CALENDAR_NAME || 'Personal';

if (!SUPABASE_URL || !ANON_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_ANON_KEY (set in .env or environment).');
  process.exit(1);
}

async function rest(method, path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

// ── Natural-language event parsing (deliberately conservative) ────

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const EVENT_WORDS = /\b(appointment|appt|meeting|dentist|doctor|gp|physio|interview|flight|dinner|lunch|brunch|coffee|catch\s?up|game|match|booking|booked|reservation|party|bbq|concert|gig|festival|wedding|birthday)\b/i;

// Returns { date: Date, hasTime, title } or null if no confident parse.
function parseEvent(content) {
  const text = content.toLowerCase();
  const now = new Date();
  let matched = [];

  // Time: "at 4pm", "4:30 pm", "16:00"
  let hours = null, minutes = 0;
  let m = text.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (m) {
    hours = (+m[1] % 12) + (m[3] === 'pm' ? 12 : 0);
    minutes = +(m[2] || 0);
    matched.push(m[0]);
  } else if ((m = text.match(/\b(?:at\s+)(\d{1,2}):(\d{2})\b/))) {
    hours = +m[1]; minutes = +m[2];
    matched.push(m[0]);
  }

  // Date, most-specific first.
  let date = null;
  const monthPat = new RegExp(`\\b(?:on\\s+)?(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTHS.join('|')})[a-z]*\\b|\\b(${MONTHS.join('|')})[a-z]*\\s+(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\b`);
  if ((m = text.match(monthPat))) {
    const day = +(m[1] || m[4]);
    const mon = MONTHS.indexOf(m[2] || m[3]);
    date = new Date(now.getFullYear(), mon, day);
    if (date < now && !sameDay(date, now)) date.setFullYear(date.getFullYear() + 1);
    matched.push(m[0]);
  } else if ((m = text.match(/\b(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)\b/))) {
    const day = +m[1];
    date = new Date(now.getFullYear(), now.getMonth(), day);
    if (date < now && !sameDay(date, now)) date.setMonth(date.getMonth() + 1);
    matched.push(m[0]);
  } else if ((m = text.match(new RegExp(`\\b(?:on\\s+|next\\s+)?(${WEEKDAYS.join('|')})\\b`)))) {
    const target = WEEKDAYS.indexOf(m[1]);
    const ahead = (target - now.getDay() + 7) % 7 || 7;
    date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ahead);
    matched.push(m[0]);
  } else if ((m = text.match(/\btomorrow\b/))) {
    date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    matched.push(m[0]);
  } else if ((m = text.match(/\btoday\b|\btonight\b/))) {
    date = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (m[0] === 'tonight' && hours === null) { hours = 19; }
    matched.push(m[0]);
  }

  if (!date) return null;
  // Confidence gate: a bare date isn't enough — need a time or an event word.
  if (hours === null && !EVENT_WORDS.test(content)) return null;

  if (hours !== null) date.setHours(hours, minutes, 0, 0);

  // Title: strip matched phrases + capture-y prefixes, tidy up.
  let title = content;
  for (const frag of matched) {
    title = title.replace(new RegExp(frag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), ' ');
  }
  title = title
    .replace(/\b(i have (a|an)?|i've got (a|an)?|there is (a|an)?|new|add|remind me( about| of)?)\b/gi, ' ')
    .replace(/\b(on|at|the|of)\s*$/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,.-]+|[\s,.-]+$/g, '')
    .trim();
  if (!title) title = 'Event';
  title = title[0].toUpperCase() + title.slice(1);

  return { date, hasTime: hours !== null, title };
}

const sameDay = (a, b) => a.toDateString() === b.toDateString();

// ── Apple Calendar write (osascript) ──────────────────────────────

function addToAppleCalendar(title, date, hasTime) {
  const durationMin = hasTime ? 60 : 24 * 60;
  const script = `
set d to current date
set year of d to ${date.getFullYear()}
set month of d to ${date.getMonth() + 1}
set day of d to ${date.getDate()}
set hours of d to ${hasTime ? date.getHours() : 0}
set minutes of d to ${hasTime ? date.getMinutes() : 0}
set seconds of d to 0
tell application "Calendar"
  tell calendar "${CALENDAR_NAME.replace(/"/g, '\\"')}"
    make new event with properties {summary:"${title.replace(/"/g, '\\"')}", start date:d, end date:d + (${durationMin} * minutes)${hasTime ? '' : ', allday event:true'}}
  end tell
end tell`;
  execFileSync('osascript', ['-e', script], { timeout: 30000 });
}

// ── Drain the queue ───────────────────────────────────────────────

const rows = await rest('GET', 'captures?select=*&order=created_at.asc');
if (!rows.length) {
  console.log('sync-captures: queue empty');
  process.exit(0);
}

const pad = n => String(n).padStart(2, '0');
let inboxed = 0, calendared = 0;

for (const row of rows) {
  const ev = parseEvent(row.content);

  if (ev) {
    const dateStr = `${ev.date.getFullYear()}-${pad(ev.date.getMonth() + 1)}-${pad(ev.date.getDate())}`;
    const timeStr = ev.hasTime ? `${pad(ev.date.getHours())}:${pad(ev.date.getMinutes())}` : null;

    // Ledger first — the dashboard must show it even if Calendar.app fails.
    mkdirSync(join(VAULT_DIR, '09-calendar'), { recursive: true });
    const ledger = existsSync(EVENTS_PATH) ? JSON.parse(readFileSync(EVENTS_PATH, 'utf8')) : [];
    ledger.push({ title: ev.title, date: dateStr, time: timeStr, captured: row.content, created_at: new Date().toISOString() });
    writeFileSync(EVENTS_PATH, JSON.stringify(ledger, null, 2));

    try {
      addToAppleCalendar(ev.title, ev.date, ev.hasTime);
      console.log(`📅 "${ev.title}" → Apple Calendar (${CALENDAR_NAME}) ${dateStr}${timeStr ? ' ' + timeStr : ''}`);
    } catch (e) {
      console.log(`! Calendar.app write failed ("${ev.title}"): ${e.message.split('\n')[0]}`);
      console.log('  Event is still on the dashboard via the bridge ledger. If this is a');
      console.log('  permissions error, grant Calendar automation access when prompted.');
    }
    await rest('DELETE', `captures?id=eq.${row.id}`);
    calendared++;
    continue;
  }

  // Not event-like → vault inbox, as before.
  const at = new Date(row.created_at);
  const stamp = at.toISOString().slice(0, 16).replace('T', '-').replace(':', '');
  const slug = row.content.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'capture';
  let path = join(RAW_DIR, `${stamp}-${slug}.md`);
  if (existsSync(path)) path = join(RAW_DIR, `${stamp}-${slug}-${row.id.slice(0, 8)}.md`);

  mkdirSync(RAW_DIR, { recursive: true });
  writeFileSync(path, [
    '---',
    'area: inbox',
    'type: capture',
    'status: raw',
    `created: ${at.toISOString().slice(0, 10)}`,
    `source: ${row.source || 'app-quick-add'}`,
    'tags: [inbox]',
    '---',
    '',
    row.content,
    '',
  ].join('\n'));

  await rest('DELETE', `captures?id=eq.${row.id}`);
  inboxed++;
  console.log(`↓ captured → ${path}`);
}

console.log(`sync-captures: ${inboxed} to inbox, ${calendared} to calendar`);
