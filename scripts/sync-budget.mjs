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
import { CATEGORIES } from './finance-taxonomy.mjs';
import { requireSupabase, putAppState, VAULT_DIR } from './bridge-lib.mjs';


const BUDGET_PATH = join(VAULT_DIR, '10-finances', 'weekly-budget.md');

requireSupabase();
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

await putAppState('budget', payload);

const set = found - unset.length;
console.log(`sync-budget: ${set}/${found} categories budgeted → app_state`
  + (unset.length ? ` (no budget set: ${unset.join(', ')})` : ''));
