#!/usr/bin/env node
// Bridge 5d: weekly budget, vault → app (one-way, read-only).
//
// Parses the "The budget — 8 categories" table out of
// ~/JC AI Brain/10-finances/weekly-budget.md into `app_state` key `budget`,
// which the finances page uses to scale each category bar: the end of the bar
// is the budget, and the bar goes red once spending reaches it.
//
// The vault note is the only author — edit the budget in Obsidian and the
// dashboard follows on the next run. A category left as "_set this_" (or any
// non-numeric cell) syncs as null, and the page renders it without a target
// rather than inventing one.
//
// Usage: node scripts/sync-budget.mjs   (DRY_RUN=1 prints without writing)
// Env:   SUPABASE_URL, SUPABASE_ANON_KEY, VAULT_DIR (optional)

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CATEGORIES } from './finance-taxonomy.mjs';

try { process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url))); } catch {}

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const VAULT_DIR = process.env.VAULT_DIR || join(homedir(), 'JC AI Brain');
const BUDGET_PATH = join(VAULT_DIR, '10-finances', 'weekly-budget.md');

if (!SUPABASE_URL || !ANON_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_ANON_KEY (set in .env or environment).');
  process.exit(1);
}
if (!existsSync(BUDGET_PATH)) {
  console.log(`sync-budget: ${BUDGET_PATH} not found — skipping.`);
  process.exit(0);
}

const md = readFileSync(BUDGET_PATH, 'utf8');

// Only rows whose first cell is exactly one of the eight spending categories
// count — that skips the "**Set so far**" total row and the income table.
const budgets = {};
let unset = [];
for (const line of md.split('\n')) {
  const cells = line.split('|').map(c => c.trim());
  if (cells.length < 3) continue;
  const name = cells[1].replace(/\*\*/g, '').trim();
  if (!CATEGORIES.includes(name)) continue;

  const raw = cells[2].replace(/\*\*/g, '').replace(/[~$,]/g, '').trim();
  const value = Number(raw);
  if (raw && Number.isFinite(value) && value >= 0) budgets[name] = value;
  else { budgets[name] = null; unset.push(name); }
}

const found = Object.keys(budgets).length;
if (!found) {
  console.log('sync-budget: no category rows found in weekly-budget.md — skipping '
    + '(expected a "| Category | Budget |" table).');
  process.exit(0);
}

const payload = {
  period: 'week',
  budgets,
  source: '10-finances/weekly-budget.md',
  fetched_at: new Date().toISOString(),
};

if (process.env.DRY_RUN) {
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

const res = await fetch(`${SUPABASE_URL}/rest/v1/app_state`, {
  method: 'POST',
  headers: {
    apikey: ANON_KEY,
    Authorization: `Bearer ${ANON_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'resolution=merge-duplicates',
  },
  body: JSON.stringify({ key: 'budget', data: payload, updated_at: new Date().toISOString() }),
});
if (!res.ok) throw new Error(`Upsert app_state → ${res.status}: ${await res.text()}`);

const set = found - unset.length;
console.log(`sync-budget: ${set}/${found} categories budgeted → app_state`
  + (unset.length ? ` (no budget set: ${unset.join(', ')})` : ''));
