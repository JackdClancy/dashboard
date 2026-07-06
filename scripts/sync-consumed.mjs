#!/usr/bin/env node
// Feature #6: recently-consumed tile.
//
// One-way vault → app. Scans the compiled-output folders (08-knowledge/ and
// 06-thoughts/) for notes the compile skill has filed, picks the most recently
// created/updated, and writes them to Supabase app_state (key 'consumed') for
// the home page tile. Read-only mirror of the vault — never writes vault files.
//
// Usage: node scripts/sync-consumed.mjs
// Env:   SUPABASE_URL, SUPABASE_ANON_KEY (.env), VAULT (optional override)

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

try { process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url))); } catch {}

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const VAULT = process.env.VAULT || join(homedir(), 'JC AI Brain');
const MAX_ITEMS = 8;

if (!SUPABASE_URL || !ANON_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_ANON_KEY (set in .env or environment).');
  process.exit(1);
}

const SOURCES = [
  { dir: join(VAULT, '08-knowledge'), kind: 'knowledge' },
  { dir: join(VAULT, '06-thoughts'), kind: 'thought' },
];

function* mdFiles(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name.startsWith('_')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* mdFiles(p);
    else if (e.name.endsWith('.md')) yield p;
  }
}

function parseNote(path, kind) {
  const raw = readFileSync(path, 'utf8');
  const fm = {};
  let body = raw;
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (m) {
    body = raw.slice(m[0].length);
    for (const line of m[1].split('\n')) {
      const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
      if (kv) fm[kv[1]] = kv[2].trim();
    }
  }
  if (fm.status === 'archived' || fm.type === 'index') return null;

  const title = (body.match(/^#\s+(.+)$/m) || [])[1]?.trim()
    || path.split('/').pop().replace(/\.md$/, '');
  // "Source: [label](url)" line written by the compile skill, if present.
  const src = body.match(/^Source:\s*\[([^\]]*)\]\(([^)]+)\)/m);
  // Newest of created/updated; fall back to file mtime.
  const dates = [fm.updated, fm.created]
    .map(d => (d ? Date.parse(d) : NaN)).filter(n => !isNaN(n));
  const when = dates.length ? Math.max(...dates) : statSync(path).mtimeMs;

  return {
    title,
    kind,
    link: src ? src[2] : null,
    source: src ? src[1] : null,
    date: new Date(when).toISOString().slice(0, 10),
    _sort: when,
  };
}

const items = [];
for (const { dir, kind } of SOURCES) {
  for (const path of mdFiles(dir)) {
    try {
      const note = parseNote(path, kind);
      if (note) items.push(note);
    } catch (e) {
      console.log(`  ! ${path}: ${e.message}`);
    }
  }
}

items.sort((a, b) => b._sort - a._sort);
const payload = items.slice(0, MAX_ITEMS).map(({ _sort, ...rest }) => rest);

const res = await fetch(`${SUPABASE_URL}/rest/v1/app_state`, {
  method: 'POST',
  headers: {
    apikey: ANON_KEY,
    Authorization: `Bearer ${ANON_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'resolution=merge-duplicates',
  },
  body: JSON.stringify({
    key: 'consumed',
    data: { fetched_at: new Date().toISOString(), items: payload },
    updated_at: new Date().toISOString(),
  }),
});
if (!res.ok) throw new Error(`Upsert app_state → ${res.status}: ${await res.text()}`);

console.log(`sync-consumed: ${payload.length} of ${items.length} notes → app_state`);
