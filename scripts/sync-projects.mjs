#!/usr/bin/env node
// Bridge 5a: one-way projects sync, vault → Supabase `projects` table.
//
// Layer-1 project pointers are .md files in the ROOT of 03-projects/ with
// `type: project` frontmatter (Layer-2 project folders are ignored). The
// vault is the only author: rows are upserted from files and rows without a
// file are deleted. The app's Current Projects tile just renders the table.
//
// Pointer format:  frontmatter `type: project`, `status: active|paused|done`,
// optional `id` (written back on first sync). Title = first `# ` heading.
// Next action = a line starting `**Next:**`.
//
// Auto-Next: if the pointer has a Layer-2 folder (same name as the pointer
// file, case-insensitive, or frontmatter `folder:`) with a `02 Decisions/`
// subfolder, the newest decision file's `**Next:**` line (or first line of a
// `## Next` section) is written into the pointer — but only when the decision
// file is newer than the pointer, so a hand-edit to the pointer wins until
// the next decision log lands.
//
// Usage: node scripts/sync-projects.mjs
// Env:   SUPABASE_URL, SUPABASE_ANON_KEY (.env), VAULT_PROJECTS_DIR (optional)

import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

try { process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url))); } catch {}

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const PROJECTS_DIR = process.env.VAULT_PROJECTS_DIR || join(homedir(), 'JC AI Brain', '03-projects');

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
      Prefer: method === 'POST' ? 'return=representation' : 'return=minimal',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

function parsePointer(path) {
  if (!statSync(path).isFile() || !path.endsWith('.md')) return null;
  const raw = readFileSync(path, 'utf8');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;

  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  if (fm.type !== 'project') return null;

  const name = (m[2].match(/^# (.+)$/m) || [])[1]?.trim();
  if (!name) return null;
  const next = (m[2].match(/^\*\*Next:\*\*\s*(.+)$/m) || [])[1]?.trim() || null;

  return {
    path, raw,
    id: fm.id || null,
    folder: fm.folder || null,
    row: { name, status: fm.status || 'active', next_action: next },
  };
}

// Newest decision file's Next line for a pointer's Layer-2 folder, or null.
function latestDecisionNext(p) {
  const want = (p.folder || basename(p.path, '.md')).toLowerCase();
  const folder = readdirSync(PROJECTS_DIR).find(d => {
    try { return d.toLowerCase() === want && statSync(join(PROJECTS_DIR, d)).isDirectory(); }
    catch { return false; }
  });
  if (!folder) return null;

  let files;
  const dir = join(PROJECTS_DIR, folder, '02 Decisions');
  try { files = readdirSync(dir).filter(f => f.endsWith('.md')); } catch { return null; }

  let newest = null;
  for (const f of files) {
    const path = join(dir, f);
    const mtime = statSync(path).mtimeMs;
    if (!newest || mtime > newest.mtime) newest = { path, mtime };
  }
  if (!newest) return null;

  const body = readFileSync(newest.path, 'utf8');
  let next = (body.match(/^\*\*Next:\*\*\s*(.+)$/m) || [])[1]?.trim();
  if (!next) {
    const section = body.match(/^## Next\s*\n+([\s\S]*?)(?=\n## |$)/m);
    if (section) next = section[1].trim().split('\n')[0].replace(/^[-*]\s+/, '').trim();
  }
  return next ? { next, mtime: newest.mtime } : null;
}

// Pull the newest decision's Next into the pointer file, unless the pointer
// was edited more recently (manual edits win until the next decision lands).
function applyDecisionNext(p) {
  const derived = latestDecisionNext(p);
  if (!derived || derived.next === p.row.next_action) return;
  if (derived.mtime <= statSync(p.path).mtimeMs) return;

  const updated = /^\*\*Next:\*\*.*$/m.test(p.raw)
    ? p.raw.replace(/^\*\*Next:\*\*.*$/m, `**Next:** ${derived.next}`)
    : p.raw.replace(/\s*$/, `\n\n**Next:** ${derived.next}\n`);
  writeFileSync(p.path, updated);
  p.raw = updated;
  p.row.next_action = derived.next;
  console.log(`~ next-cue "${p.row.name}" ← latest decision log`);
}

const sameRow = (a, b) =>
  a.name === b.name && a.status === b.status &&
  (a.next_action || null) === (b.next_action || null);

const dbRows = await rest('GET', 'projects?select=*');
const dbById = new Map(dbRows.map(r => [r.id, r]));
const pointers = readdirSync(PROJECTS_DIR)
  .map(f => { try { return parsePointer(join(PROJECTS_DIR, f)); } catch { return null; } })
  .filter(Boolean);

const seen = new Set();
let inserted = 0, updated = 0, deleted = 0, unchanged = 0;

for (const p of pointers) {
  applyDecisionNext(p);
  if (!p.id) {
    const [row] = await rest('POST', 'projects', p.row);
    writeFileSync(p.path, p.raw.replace(/^---\n/, `---\nid: ${row.id}\n`));
    seen.add(row.id);
    inserted++;
    console.log(`+ inserted "${p.row.name}" (${row.id})`);
    continue;
  }
  seen.add(p.id);
  const existing = dbById.get(p.id);
  if (!existing) {
    await rest('POST', 'projects', { id: p.id, ...p.row });
    inserted++;
  } else if (!sameRow(p.row, existing)) {
    await rest('PATCH', `projects?id=eq.${p.id}`, p.row);
    updated++;
    console.log(`~ updated "${p.row.name}"`);
  } else {
    unchanged++;
  }
}

// Vault is the only author — rows without a pointer file are stale.
for (const row of dbRows) {
  if (seen.has(row.id)) continue;
  await rest('DELETE', `projects?id=eq.${row.id}`);
  deleted++;
  console.log(`- deleted "${row.name}" (no pointer file)`);
}

console.log(`sync-projects: ${inserted} inserted, ${updated} updated, ${deleted} deleted, ${unchanged} unchanged`);
