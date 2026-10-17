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

import { readUpcomingEvents } from './calendar-lib.mjs';
import { requireSupabase, putAppState } from './bridge-lib.mjs';

const HORIZON_DAYS = 30;
const MAX_EVENTS = 20;

requireSupabase();

const events = await readUpcomingEvents({ horizonDays: HORIZON_DAYS });
const upcoming = events.slice(0, MAX_EVENTS).map(({ date, time, title }) => ({ date, time, title }));

// No `source` field: CALENDAR_ICS is Jack's iCloud public-share link, and
// app_state is readable with the public anon key — publishing it here handed
// read access to the whole calendar to anyone who looked.
await putAppState('calendar', { synced_at: new Date().toISOString(), events: upcoming });

console.log(`sync-calendar: ${upcoming.length} events in the next ${HORIZON_DAYS} days → app_state`);
