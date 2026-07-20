#!/usr/bin/env node
// Feature #7a: calendar → app tile.
//
// Reads the next 30 days of events — ICS export merged with the
// bridge-events ledger, via scripts/calendar-lib.mjs's readUpcomingEvents()
// (shared with sync-captures.mjs / sync-mail.mjs / calendar-manager.mjs) —
// and writes them to Supabase app_state (key 'calendar') for the home page
// tile.
//
// Usage: node scripts/sync-calendar.mjs
// Env:   SUPABASE_URL, SUPABASE_ANON_KEY (.env)
//        CALENDAR_ICS — path or http(s)/webcal URL
//                       (default ~/Downloads/Personal.ics; re-export or point
//                        at an iCloud public-share URL to keep it fresh)

import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readUpcomingEvents } from './calendar-lib.mjs';

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

const events = await readUpcomingEvents({ horizonDays: HORIZON_DAYS });
const upcoming = events.slice(0, MAX_EVENTS).map(({ date, time, title }) => ({ date, time, title }));

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
