#!/usr/bin/env node
// Bridge 5b: finances snapshot, app → vault (read-only).
//
// Pulls transactions from Akahu via the deployed proxy (/api/akahu) and
// writes a markdown snapshot into the vault so Claudian can read money
// data as context for reviews. Never hand-edit the output file.
//
// Usage: node scripts/snapshot-finances.mjs
// Env:   AKAHU_APP_ID, AKAHU_USER_TOKEN (in .env) — same values entered on
//        finances.html. APP_URL / VAULT_DIR optional as in snapshot-fitness.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

try { process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url))); } catch {}

const APP_ID = process.env.AKAHU_APP_ID;
const USER_TOKEN = process.env.AKAHU_USER_TOKEN;
const APP_URL = process.env.APP_URL || 'https://jackdc.vercel.app';
const OUT_DIR = join(process.env.VAULT_DIR || join(homedir(), 'JC AI Brain'), '10-finances', 'data');

if (!APP_ID || !USER_TOKEN) {
  console.log('snapshot-finances: AKAHU_APP_ID / AKAHU_USER_TOKEN not set in .env — skipping. ' +
    'Add the values from finances.html to ~/dashboard/.env to enable finance snapshots.');
  process.exit(0);
}

const res = await fetch(`${APP_URL}/api/akahu`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ appId: APP_ID, userToken: USER_TOKEN }),
});
if (!res.ok) throw new Error(`Akahu proxy → ${res.status}: ${await res.text()}`);
const { transactions = [] } = await res.json();

const byMonth = new Map();
for (const t of transactions) {
  const month = (t.date || '').slice(0, 7);
  if (!month) continue;
  if (!byMonth.has(month)) byMonth.set(month, { in: 0, out: 0 });
  const m = byMonth.get(month);
  if (t.amount >= 0) m.in += t.amount; else m.out += -t.amount;
}

const nzd = n => n.toLocaleString('en-NZ', { style: 'currency', currency: 'NZD' });
const today = new Date().toISOString().slice(0, 10);
const recent = transactions.slice(0, 60);

const lines = [
  '---',
  'area: finances',
  'type: data',
  'status: active',
  `created: ${today}`,
  `updated: ${today}`,
  'tags: [finances, akahu, snapshot]',
  '---',
  '',
  '# Transactions (Akahu snapshot)',
  '',
  '> Machine-written by `~/dashboard/scripts/snapshot-finances.mjs` — do not hand-edit.',
  `> Last sync: ${new Date().toISOString()}.`,
  '',
  '## Monthly in/out',
  '',
  '| Month | In | Out | Net |',
  '|---|---|---|---|',
  ...[...byMonth.entries()].sort().reverse().map(([m, v]) =>
    `| ${m} | ${nzd(v.in)} | ${nzd(v.out)} | ${nzd(v.in - v.out)} |`),
  '',
  `## Recent transactions (latest ${recent.length})`,
  '',
  '| Date | Description | Amount |',
  '|---|---|---|',
  ...recent.map(t =>
    `| ${(t.date || '').slice(0, 10)} | ${(t.description || '—').replace(/\|/g, '/')} | ${nzd(t.amount || 0)} |`),
  '',
];

mkdirSync(OUT_DIR, { recursive: true });
const outPath = join(OUT_DIR, '(AI) transactions.md');
writeFileSync(outPath, lines.join('\n'));
console.log(`snapshot-finances: ${transactions.length} transactions → ${outPath}`);
