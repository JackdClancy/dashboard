#!/usr/bin/env node
// Feature #5 (entry point): app quick-add → vault inbox.
//
// The home page's capture bar inserts rows into the `captures` table. This
// job drains the queue: each row becomes a markdown file in the vault's
// 00-inbox/raw/ (for the compile skill to process), then the row is deleted.
//
// Usage: node scripts/sync-captures.mjs
// Env:   SUPABASE_URL, SUPABASE_ANON_KEY (.env), VAULT_DIR (optional)

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

try { process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url))); } catch {}

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const RAW_DIR = join(process.env.VAULT_DIR || join(homedir(), 'JC AI Brain'), '00-inbox', 'raw');

if (!SUPABASE_URL || !ANON_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_ANON_KEY (set in .env or environment).');
  process.exit(1);
}

async function rest(method, path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

const rows = await rest('GET', 'captures?select=*&order=created_at.asc');
if (!rows.length) {
  console.log('sync-captures: queue empty');
  process.exit(0);
}

mkdirSync(RAW_DIR, { recursive: true });
let exported = 0;

for (const row of rows) {
  const at = new Date(row.created_at);
  const stamp = at.toISOString().slice(0, 16).replace('T', '-').replace(':', '');
  const slug = row.content.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'capture';
  let path = join(RAW_DIR, `${stamp}-${slug}.md`);
  if (existsSync(path)) path = join(RAW_DIR, `${stamp}-${slug}-${row.id.slice(0, 8)}.md`);

  writeFileSync(path, [
    '---',
    'area: inbox',
    'type: capture',
    'status: raw',
    `created: ${at.toISOString().slice(0, 10)}`,
    'source: app-quick-add',
    'tags: [inbox]',
    '---',
    '',
    row.content,
    '',
  ].join('\n'));

  // Delete only after the file is safely on disk (queue semantics).
  await rest('DELETE', `captures?id=eq.${row.id}`);
  exported++;
  console.log(`↓ captured → ${path}`);
}

console.log(`sync-captures: ${exported} exported to 00-inbox/raw`);
