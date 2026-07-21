#!/usr/bin/env node
// Manual Apple Calendar management CLI — list/add/edit/remove/dedupe.
// Not part of bridge-sync.sh: every mutation here is something Jack runs
// deliberately from the terminal, not something the 15-min bridge triggers
// on its own.
//
// list/dedupe read from the ICS export + bridge-events ledger (fast, via
// calendar-lib.mjs's readUpcomingEvents — a live webcal:// URL if
// CALENDAR_ICS is set to one). add/edit/remove write directly to
// Calendar.app; edit/remove/dedupe --apply locate the event by title+date
// (not the feed's uid — see calendar-lib.mjs's updateEvent/deleteEvent notes
// for why) via a live whose() scan, which is SLOW (up to a few minutes on a
// calendar this size) — that's inherent to Calendar.app's scripting bridge,
// not something this script can speed up, so expect a wait.
//
// Usage:
//   node scripts/calendar-manager.mjs list [--days 14]
//   node scripts/calendar-manager.mjs add "<title>" <YYYY-MM-DD> [HH:MM] [--force] [--calendar Personal]
//   node scripts/calendar-manager.mjs edit <uid> [--title "..."] [--date YYYY-MM-DD] [--time HH:MM] [--calendar Personal]
//   node scripts/calendar-manager.mjs remove <uid> [--yes] [--calendar Personal]
//   node scripts/calendar-manager.mjs dedupe [--days 45] [--apply] [--calendar Personal]
//
// Env: CALENDAR_NAME (default "Personal") — the calendar add/edit/remove write to.

import { fileURLToPath } from 'node:url';
import { readUpcomingEvents, addEvent, updateEvent, deleteEvent, findDuplicate, defaultCalendar } from './calendar-lib.mjs';

try { process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url))); } catch {}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/, HHMM = /^\d{2}:\d{2}$/;

function parseFlags(argv) {
  const flags = {}, positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; }
      else flags[key] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}

function fmtEvent(e) {
  const uid = e.uid ? e.uid.slice(0, 12) + '…' : '(no uid)';
  return `${uid}  ${e.date}${e.time ? ' ' + e.time : ' (all day)'}  ${e.title}`;
}

const [, , cmd, ...rest] = process.argv;
const { flags, positional } = parseFlags(rest);
const calendarName = flags.calendar || defaultCalendar();

switch (cmd) {
  case 'list': {
    const days = Number(flags.days || 14);
    const events = await readUpcomingEvents({ horizonDays: days });
    if (!events.length) console.log(`No events in the next ${days} days.`);
    else events.forEach(e => console.log(fmtEvent(e)));
    break;
  }

  case 'add': {
    const [title, date, time] = positional;
    if (!title || !ISO_DATE.test(date || '')) {
      console.error('Usage: add "<title>" <YYYY-MM-DD> [HH:MM] [--force]');
      process.exit(1);
    }
    if (time && !HHMM.test(time)) { console.error('Time must be HH:MM'); process.exit(1); }

    if (!flags.force) {
      const existing = await readUpcomingEvents({ horizonDays: 400 });
      const dup = findDuplicate({ title, date, candidates: existing });
      if (dup) {
        console.error(`! Looks like a duplicate of existing event "${dup.title}" on ${dup.date}.`);
        console.error('  Re-run with --force to add it anyway.');
        process.exit(1);
      }
    }
    const { uid } = addEvent({ calendarName, title, date, time });
    console.log(`Added "${title}" ${date}${time ? ' ' + time : ''} → ${uid}`);
    break;
  }

  case 'edit': {
    const [uid] = positional;
    if (!uid) { console.error('Usage: edit <uid> [--title T] [--date D] [--time T]'); process.exit(1); }
    if (flags.date && !ISO_DATE.test(flags.date)) { console.error('Date must be YYYY-MM-DD'); process.exit(1); }
    if (flags.time && !HHMM.test(flags.time)) { console.error('Time must be HH:MM'); process.exit(1); }
    const match = (await readUpcomingEvents({ horizonDays: 400 })).find(e => e.uid === uid);
    console.log('Applying via Calendar.app — this can take up to a few minutes on a large calendar…');
    updateEvent({
      calendarName,
      uid: match ? undefined : uid,
      matchTitle: match?.title,
      matchDate: match?.date,
      title: typeof flags.title === 'string' ? flags.title : undefined,
      date: typeof flags.date === 'string' ? flags.date : undefined,
      time: typeof flags.time === 'string' ? flags.time : undefined,
    });
    console.log(`Updated ${uid}`);
    break;
  }

  case 'remove': {
    const [uid] = positional;
    if (!uid) { console.error('Usage: remove <uid> [--yes]'); process.exit(1); }
    const match = (await readUpcomingEvents({ horizonDays: 400 })).find(e => e.uid === uid);
    if (match) console.log(`About to delete: ${fmtEvent(match)}`);
    else console.log(`(uid ${uid} not found in the next ~13 months of the ICS/ledger view — proceeding on the uid alone)`);
    if (!flags.yes) { console.log('Dry run — re-run with --yes to actually delete.'); break; }
    console.log('Applying via Calendar.app — this can take up to a few minutes on a large calendar…');
    deleteEvent({ calendarName, uid: match ? undefined : uid, matchTitle: match?.title, matchDate: match?.date });
    console.log('Deleted.');
    break;
  }

  case 'dedupe': {
    const days = Number(flags.days || 45);
    const events = await readUpcomingEvents({ horizonDays: days });
    const groups = [];
    const claimed = new Set();
    for (let i = 0; i < events.length; i++) {
      if (claimed.has(i)) continue;
      const group = [events[i]];
      for (let j = i + 1; j < events.length; j++) {
        if (claimed.has(j)) continue;
        const dup = findDuplicate({ title: events[i].title, date: events[i].date, candidates: [events[j]] });
        if (dup) { group.push(events[j]); claimed.add(j); }
      }
      if (group.length > 1) { claimed.add(i); groups.push(group); }
    }
    if (!groups.length) { console.log(`No duplicates found in the next ${days} days.`); break; }
    for (const group of groups) {
      console.log('── possible duplicates ──');
      group.forEach(e => console.log('  ' + fmtEvent(e)));
      if (flags.apply) {
        const withUid = group.filter(e => e.uid);
        if (withUid.length < 2) { console.log('  (skipping — need at least 2 uids to dedupe safely)'); continue; }
        const [keep, ...drop] = withUid;
        for (const e of drop) {
          console.log(`  deleting ${e.uid.slice(0, 12)}… via Calendar.app (this can take up to a few minutes)…`);
          try {
            deleteEvent({ calendarName, matchTitle: e.title, matchDate: e.date });
            console.log(`  deleted ${e.uid.slice(0, 12)}… (kept ${keep.uid.slice(0, 12)}…)`);
          } catch (err) {
            console.log(`  ! couldn't delete "${e.title}": ${err.message.split('\n')[0]}`);
          }
        }
      }
    }
    if (!flags.apply) console.log(`\n${groups.length} group(s) found. Re-run with --apply to delete all but the earliest in each group.`);
    break;
  }

  default:
    console.error('Usage: calendar-manager.mjs <list|add|edit|remove|dedupe> ...');
    process.exit(1);
}
