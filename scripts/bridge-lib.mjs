// Shared plumbing for the bridge scripts (added 2026-10-17). Before this, each
// script carried its own copy of the env loading, the Supabase REST helper and
// the app_state upsert — seven slightly different `rest()` functions, one of
// which crashed on an empty 201 body. Import from here instead of copying.

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

try { process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url))); } catch {}

export const SUPABASE_URL = process.env.SUPABASE_URL;
export const ANON_KEY = process.env.SUPABASE_ANON_KEY;
export const VAULT_DIR = process.env.VAULT_DIR || join(homedir(), 'JC AI Brain');

// Call at the top of any script that talks to Supabase.
export function requireSupabase() {
  if (!SUPABASE_URL || !ANON_KEY) {
    console.error('Missing SUPABASE_URL / SUPABASE_ANON_KEY (set in .env or environment).');
    process.exit(1);
  }
}

// PostgREST call. POSTs ask for the inserted rows back (callers destructure
// `const [row] = await rest('POST', ...)`); everything else is minimal. The
// body is read as text so an empty 201/204 parses as null instead of throwing.
export async function rest(method, path, body, extraHeaders = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${ANON_KEY}`,
      'Content-Type': 'application/json',
      Prefer: method === 'POST' ? 'return=representation' : 'return=minimal',
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Upsert one app_state key (the read-only home-page tiles).
export async function putAppState(key, data) {
  const now = new Date().toISOString();
  await rest('POST', 'app_state?on_conflict=key', { key, data, updated_at: now },
    { Prefer: 'resolution=merge-duplicates,return=minimal' });
}

// Local calendar date as YYYY-MM-DD. Never use toISOString().slice(0, 10) for
// this: NZ is UTC+12/13, so before midday the UTC date is still yesterday —
// which put goals, captures and Hevy workouts on the wrong day, and told the
// triage model "today" was yesterday.
export function localDate(d = new Date()) {
  const dt = d instanceof Date ? d : new Date(d);
  const p = n => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

// "Today is 2026-10-17 (Saturday), timezone Pacific/Auckland." for prompts.
export function todayLine() {
  const now = new Date();
  return `Today is ${localDate(now)} (${now.toLocaleDateString('en-NZ', { weekday: 'long' })}), timezone Pacific/Auckland.`;
}

export const CLAUDE_BIN = process.env.CLAUDE_BIN
  || [join(homedir(), '.local/bin/claude'), '/usr/local/bin/claude', '/opt/homebrew/bin/claude']
    .find(existsSync);

// Writes a vault file only if nobody touched it since we read it. The syncs
// read a file, spend seconds on network calls, then write it back — without
// this, an edit Jack saves in Obsidian during that window is overwritten.
// Returns the new mtime, or throws so the run aborts before its shadow state
// is saved (the next run then sees both edits and resolves them normally).
export function writeIfUnchanged(path, text, mtimeAtRead) {
  if (statSync(path).mtimeMs !== mtimeAtRead) {
    throw new Error(`${path} changed while syncing — leaving it for the next run`);
  }
  writeFileSync(path, text);
  return statSync(path).mtimeMs;
}

// Stamps freshly-inserted ids onto their lines without clobbering anything:
// re-reads the file and swaps each original line (exact text) for its stamped
// version, leaving every other line as it is on disk now. Used right after the
// inserts, where throwing isn't an option — the rows already exist, so failing
// to record their ids is exactly what re-inserts them next run. A line Jack
// edited in the meantime can't be found and is skipped (logged).
export function stampLines(path, replacements) {
  const lines = readFileSync(path, 'utf8').split('\n');
  const taken = new Set();
  for (const { from, to } of replacements) {
    const i = lines.findIndex((l, idx) => l === from && !taken.has(idx));
    if (i === -1) { console.log(`  ! couldn't stamp id (line changed mid-run): ${from}`); continue; }
    lines[i] = to;
    taken.add(i);
  }
  writeFileSync(path, lines.join('\n'));
  return statSync(path).mtimeMs;
}
