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
import { fileURLToPath } from 'node:url';

try { process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url))); } catch {}

const HEVY_API_KEY = process.env.HEVY_API_KEY;
const APP_URL = process.env.APP_URL || 'https://jackdc.vercel.app';
const OUT_DIR = join(process.env.VAULT_DIR || join(homedir(), 'JC AI Brain'), '07-body', '7.2-gym', 'log');

if (!HEVY_API_KEY) {
  console.log('snapshot-fitness: HEVY_API_KEY not set in .env — skipping. ' +
    'Add the key from gym.html (Settings) to ~/dashboard/.env to enable fitness snapshots.');
  process.exit(0);
}

const since = new Date();
since.setMonth(since.getMonth() - 2);
since.setDate(1);

const res = await fetch(`${APP_URL}/api/hevy`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ apiKey: HEVY_API_KEY, since: since.toISOString().slice(0, 10) }),
});
if (!res.ok) throw new Error(`Hevy proxy → ${res.status}: ${await res.text()}`);
const { workouts = [] } = await res.json();

const fmtDate = iso => (iso || '').slice(0, 10);
const byMonth = new Map();
for (const w of workouts) {
  const month = fmtDate(w.start_time || w.created_at).slice(0, 7);
  if (!byMonth.has(month)) byMonth.set(month, { count: 0, volume: 0 });
  const m = byMonth.get(month);
  m.count++;
  m.volume += w.volume_kg || 0;
}

const today = new Date().toISOString().slice(0, 10);
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
  `> Last sync: ${new Date().toISOString()}. Window: since ${since.toISOString().slice(0, 10)}.`,
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
