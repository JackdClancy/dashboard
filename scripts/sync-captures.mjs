#!/usr/bin/env node
// Feature #5 (entry point): app quick-add → vault inbox / Apple Calendar.
//
// Drains the `captures` table (home page capture bar). Each capture is
// classified once by headless `claude -p` (CAPTURE_TRIAGE_MODEL, default
// haiku), given the next 45 days of existing Apple Calendar events as
// context, into one of:
//   - "add"    — a NEW event ("Dentist appointment on the 7th at 4pm") →
//                created in Apple Calendar (scripts/calendar-lib.mjs) and
//                appended to the vault's bridge-events ledger
//                (09-calendar/(AI) bridge-events.json) so the dashboard's
//                Upcoming tile shows it immediately (sync-calendar.mjs
//                merges it). Skipped if it looks like a duplicate of an
//                event already on the calendar.
//   - "update" — changes an EXISTING event ("move my dentist appt to 4pm").
//                Only acted on when the model points at a specific existing
//                event (match_uid) copied from the context it was given.
//   - "delete" — cancels an EXISTING event ("cancel my dentist appointment").
//                Same match_uid requirement as update.
//   - "none"   — everything else → a markdown file in 00-inbox/raw/ for the
//                compile skill, exactly as before.
// Rows are deleted only after the calendar/file write is safely applied.
// If classification itself fails (claude CLI unavailable, etc.) the whole
// queue is left untouched and retried on the next bridge run.
//
// Usage: node scripts/sync-captures.mjs
// Env:   SUPABASE_URL, SUPABASE_ANON_KEY (.env), VAULT_DIR (optional),
//        CALENDAR_NAME (Apple Calendar target, default "Personal"),
//        CAPTURE_TRIAGE_MODEL (default haiku), CLAUDE_BIN (path to claude CLI)

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { VIDEO_URL_RE, fetchVideoContent, toMarkdown as videoMarkdown } from './fetch-video.mjs';
import { readUpcomingEvents, addEvent, updateEvent, deleteEvent, findDuplicate } from './calendar-lib.mjs';

try { process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url))); } catch {}

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const VAULT_DIR = process.env.VAULT_DIR || join(homedir(), 'JC AI Brain');
const RAW_DIR = join(VAULT_DIR, '00-inbox', 'raw');
const EVENTS_PATH = join(VAULT_DIR, '09-calendar', '(AI) bridge-events.json');
const CALENDAR_NAME = process.env.CALENDAR_NAME || 'Personal';
const MODEL = process.env.CAPTURE_TRIAGE_MODEL || 'haiku';

if (!SUPABASE_URL || !ANON_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_ANON_KEY (set in .env or environment).');
  process.exit(1);
}

const CLAUDE_BIN = process.env.CLAUDE_BIN
  || [join(homedir(), '.local/bin/claude'), '/usr/local/bin/claude', '/opt/homebrew/bin/claude']
    .find(existsSync);

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

// ── Calendar-intent classification (headless claude, one call per run) ──

function classifyCaptures(rows, existingEvents) {
  const today = new Date();
  const prompt = `You are a calendar-and-capture triage assistant for Jack. Today is ${today.toISOString().slice(0, 10)} (${today.toLocaleDateString('en-NZ', { weekday: 'long' })}), timezone Pacific/Auckland.

Each row below is a short note Jack typed into a quick-capture bar. For each row, decide "calendar_action":
- "add" — the note describes a NEW event with a parseable date. A bare date alone isn't enough — it needs a time or an obvious appointment word (appointment, meeting, dentist, doctor, flight, dinner, booking, etc). Set title/date/time for the new event.
- "update" — the note asks to change/move/reschedule an event that already exists in EXISTING EVENTS below (e.g. "move my dentist appt to 4pm", "push the gym session to tomorrow"). Set "match_uid" to the uid copied EXACTLY from EXISTING EVENTS. Only set the fields (title/date/time) that should change; leave the rest null.
- "delete" — the note asks to cancel/remove an event that already exists in EXISTING EVENTS (e.g. "cancel my dentist appointment", "remove the coffee with Sam"). Set "match_uid" to the uid being removed.
- "none" — anything else: thoughts, links, tasks, ambiguous notes, or an update/delete you can't confidently match to exactly one existing event.

Never invent a match_uid — copy it verbatim from EXISTING EVENTS, and only when confident. If in doubt, use "none".

EXISTING EVENTS (next 45 days):
${JSON.stringify(existingEvents.map(e => ({ uid: e.uid, title: e.title, date: e.date, time: e.time })))}

Reply with ONLY a JSON array covering every row, in the form:
[{"id":"...","calendar_action":"add","title":"...","date":"YYYY-MM-DD","time":"HH:MM" or null,"match_uid":null}]

ROWS:
${JSON.stringify(rows.map(r => ({ id: r.id, content: r.content })), null, 1)}`;

  const out = execFileSync(CLAUDE_BIN, [
    '-p', '--model', MODEL,
    '--disallowedTools', 'Bash,Read,Glob,Grep,Write,Edit,WebFetch,WebSearch,Task,NotebookEdit',
  ], { input: prompt, encoding: 'utf8', timeout: 300000, maxBuffer: 8 * 1024 * 1024 });

  const json = out.match(/\[[\s\S]*\]/);
  if (!json) throw new Error(`no JSON array in claude output: ${out.slice(0, 200)}`);
  return JSON.parse(json[0]);
}

// ── Bridge-events ledger (vault-side cache so the dashboard tile updates
//    immediately, ahead of the next static ICS re-export) ────────────────

function loadLedger() {
  return existsSync(EVENTS_PATH) ? JSON.parse(readFileSync(EVENTS_PATH, 'utf8')) : [];
}
function saveLedger(ledger) {
  mkdirSync(join(VAULT_DIR, '09-calendar'), { recursive: true });
  writeFileSync(EVENTS_PATH, JSON.stringify(ledger, null, 2));
}
function pushLedgerEntry(entry) {
  const ledger = loadLedger();
  ledger.push({ ...entry, created_at: new Date().toISOString() });
  saveLedger(ledger);
}
function updateLedgerEntry(uid, changes) {
  const ledger = loadLedger();
  const idx = ledger.findIndex(e => e.uid === uid);
  if (idx === -1) return; // event predates this ledger (manual/ICS-only) — nothing to sync here
  if (changes.title !== undefined) ledger[idx].title = changes.title;
  if (changes.date !== undefined) ledger[idx].date = changes.date;
  if (changes.time !== undefined) ledger[idx].time = changes.time;
  saveLedger(ledger);
}
function removeLedgerEntry(uid) {
  const ledger = loadLedger();
  const next = ledger.filter(e => e.uid !== uid);
  if (next.length !== ledger.length) saveLedger(next);
}

// ── Drain the queue ───────────────────────────────────────────────

const rows = await rest('GET', 'captures?select=*&order=created_at.asc');
if (!rows.length) {
  console.log('sync-captures: queue empty');
  process.exit(0);
}

if (!CLAUDE_BIN) {
  console.log('sync-captures: claude CLI not found — set CLAUDE_BIN in .env. Leaving queue untouched.');
  process.exit(0);
}

let existingEvents = [];
try {
  existingEvents = await readUpcomingEvents({ horizonDays: 45 });
} catch (e) {
  console.log(`sync-captures: can't read upcoming events — ${e.message.split('\n')[0]}`);
}
const validUids = new Set(existingEvents.filter(e => e.uid).map(e => e.uid));

let verdicts;
try {
  verdicts = classifyCaptures(rows, existingEvents);
} catch (e) {
  console.log(`sync-captures: classification failed, leaving queue for next run: ${e.message.split('\n')[0]}`);
  process.exit(0);
}
const byId = new Map(verdicts.map(v => [v.id, v]));

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/, HHMM = /^\d{2}:\d{2}$/;
let inboxed = 0, calendared = 0;

for (const row of rows) {
  const v = byId.get(row.id) || { calendar_action: 'none' };

  if (v.calendar_action === 'add' && ISO_DATE.test(v.date || '')) {
    const time = HHMM.test(v.time || '') ? v.time : null;
    const title = String(v.title || '').slice(0, 120).trim() || 'Event';
    const dup = findDuplicate({ title, date: v.date, candidates: existingEvents });
    if (dup) {
      console.log(`⏭ skipped "${title}" ${v.date} — looks like a duplicate of existing "${dup.title}"`);
    } else {
      try {
        const { uid } = addEvent({ calendarName: CALENDAR_NAME, title, date: v.date, time });
        pushLedgerEntry({ uid, title, date: v.date, time, captured: row.content });
        existingEvents.push({ uid, title, date: v.date, time, allDay: !time });
        console.log(`📅 "${title}" → Apple Calendar (${CALENDAR_NAME}) ${v.date}${time ? ' ' + time : ''}`);
      } catch (e) {
        console.log(`! Calendar.app write failed ("${title}"): ${e.message.split('\n')[0]}`);
        console.log('  If this is a permissions error, grant Calendar automation access when prompted.');
      }
    }
    await rest('DELETE', `captures?id=eq.${row.id}`);
    calendared++;
    continue;
  }

  if ((v.calendar_action === 'update' || v.calendar_action === 'delete') && validUids.has(v.match_uid)) {
    const match = existingEvents.find(e => e.uid === v.match_uid);
    console.log(`  … ${v.calendar_action === 'update' ? 'updating' : 'deleting'} "${match.title}" in Calendar.app (this can take up to a few minutes on a large calendar)`);
    try {
      if (v.calendar_action === 'update') {
        const title = typeof v.title === 'string' && v.title.trim() ? v.title.trim().slice(0, 120) : undefined;
        const date = ISO_DATE.test(v.date || '') ? v.date : undefined;
        const time = HHMM.test(v.time || '') ? v.time : undefined;
        updateEvent({ calendarName: CALENDAR_NAME, uid: v.match_uid, title, date, time });
        updateLedgerEntry(v.match_uid, { title, date, time });
        console.log(`✎ updated "${match.title}" → ${title || match.title} ${date || match.date}${(time ?? match.time) ? ' ' + (time ?? match.time) : ''}`);
      } else {
        deleteEvent({ calendarName: CALENDAR_NAME, uid: v.match_uid });
        removeLedgerEntry(v.match_uid);
        console.log(`🗑 deleted "${match.title}" ${match.date}`);
      }
      await rest('DELETE', `captures?id=eq.${row.id}`);
      calendared++;
    } catch (e) {
      console.log(`! ${v.calendar_action} failed ("${match.title}"): ${e.message.split('\n')[0]}`);
    }
    continue;
  }

  // Not calendar-actionable → vault inbox, as before.
  // Social video links (TikTok / IG reels / Shorts) get the actual video
  // content pulled in — caption + speech transcript — so the compile skill
  // works from what the video says, not just the URL.
  let videoBlock = null;
  const videoUrl = row.content.match(VIDEO_URL_RE)?.[0];
  if (videoUrl) {
    try {
      videoBlock = videoMarkdown(fetchVideoContent(videoUrl));
      console.log(`▶ video content extracted: ${videoUrl}`);
    } catch (e) {
      videoBlock = `## Video content (auto-extracted)\n\n_Extraction failed: ${e.message.split('\n')[0]}. Retry with \`node scripts/fetch-video.mjs "${videoUrl}"\`._`;
      console.log(`! video extraction failed (${videoUrl}): ${e.message.split('\n')[0]}`);
    }
  }

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
    ...(videoBlock ? [videoBlock, ''] : []),
  ].join('\n'));

  await rest('DELETE', `captures?id=eq.${row.id}`);
  inboxed++;
  console.log(`↓ captured → ${path}`);
}

console.log(`sync-captures: ${inboxed} to inbox, ${calendared} to calendar`);
