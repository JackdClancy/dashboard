#!/usr/bin/env node
// Bridge 5b: fitness snapshot, app → vault (read-only).
//
// Pulls recent workouts from Hevy via the deployed proxy (/api/hevy) and
// writes a markdown snapshot into the vault so Claudian can read training
// data as context for reviews. Never hand-edit the output file.
//
// Usage: node scripts/snapshot-fitness.mjs
// Env:   HEVY_API_KEY (in .env) — the same key entered on gym.html.
//        APP_URL (optional, defaults to https://jackdc.vercel.app)
//        VAULT_DIR (optional, defaults to ~/JC AI Brain)

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { localDate } from './bridge-lib.mjs';


const HEVY_API_KEY = process.env.HEVY_API_KEY;
const APP_URL = process.env.APP_URL || 'https://jackdc.vercel.app';
const OUT_DIR = join(process.env.VAULT_DIR || join(homedir(), 'JC AI Brain'), '07-body', '7.2-gym', 'log');

if (!HEVY_API_KEY) {
  console.log('snapshot-fitness: HEVY_API_KEY not set in .env — skipping. ' +
    'Add the key from gym.html (Settings) to ~/dashboard/.env to enable fitness snapshots.');
  process.exit(0);
}

// First of the month two months back, local midnight. (Built directly: the
// old setMonth-then-setDate(1) rolled e.g. 30 Apr → "30 Feb" → 2 Mar → 1 Mar.)
const now = new Date();
const since = new Date(now.getFullYear(), now.getMonth() - 2, 1);

const res = await fetch(`${APP_URL}/api/hevy`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ apiKey: HEVY_API_KEY, since: since.toISOString() }),
});
if (!res.ok) throw new Error(`Hevy proxy → ${res.status}: ${await res.text()}`);
const { workouts = [] } = await res.json();

// Hevy timestamps are UTC: slicing them put a 7am NZ workout on the previous day.
const fmtDate = iso => (iso ? localDate(iso) : '');
const byMonth = new Map();
for (const w of workouts) {
  const month = fmtDate(w.start_time || w.created_at).slice(0, 7);
  if (!byMonth.has(month)) byMonth.set(month, { count: 0, volume: 0 });
  const m = byMonth.get(month);
  m.count++;
  m.volume += w.volume_kg || 0;
}

const today = localDate();
const lines = [
  '---',
  'area: body',
  'type: data',
  'status: active',
  `created: ${today}`,
  `updated: ${today}`,
  'tags: [gym, hevy, snapshot]',
  '---',
  '',
  '# Workout log (Hevy snapshot)',
  '',
  `> Machine-written by \`~/dashboard/scripts/snapshot-fitness.mjs\` — do not hand-edit.`,
  `> Last sync: ${new Date().toISOString()}. Window: since ${localDate(since)}.`,
  '',
  '## Monthly totals',
  '',
  '| Month | Workouts | Volume (kg) |',
  '|---|---|---|',
  ...[...byMonth.entries()].sort().reverse().map(([m, v]) =>
    `| ${m} | ${v.count} | ${Math.round(v.volume).toLocaleString()} |`),
  '',
  '## Workouts',
  '',
  '| Date | Title | Volume (kg) |',
  '|---|---|---|',
  ...workouts.map(w =>
    `| ${fmtDate(w.start_time || w.created_at)} | ${w.title || '—'} | ${(w.volume_kg || 0).toLocaleString()} |`),
  '',
];

mkdirSync(OUT_DIR, { recursive: true });
const outPath = join(OUT_DIR, '(AI) hevy-log.md');
writeFileSync(outPath, lines.join('\n'));
console.log(`snapshot-fitness: ${workouts.length} workouts → ${outPath}`);
