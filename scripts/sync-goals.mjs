#!/usr/bin/env node
// Bridge 5c: TWO-WAY goals sync, vault (04-goals/*.md) ↔ Supabase `goals`.
//
// Change detection uses a shadow state file (scripts/.sync-state-goals.json)
// holding each goal as of the last successful sync:
//   - only the vault side changed → push to Supabase
//   - only the app side changed  → pull into the vault file
//   - both changed differently   → last-write-wins (file mtime vs updated_at)
//   - file deleted in vault      → row deleted in Supabase
//   - row deleted in app         → vault file marked `status: archived`
//   - file without id            → inserted, uuid written back to frontmatter
//   - row without a file         → exported to a new vault file
// Setting `status: archived` on a file deletes its row and stops syncing it.
// Pulls are surgical: frontmatter fields, title line, and the `## Done` /
// `## Next` checkbox lines are rewritten; any other prose is preserved.
//
// Usage: node scripts/sync-goals.mjs
// Env:   SUPABASE_URL, SUPABASE_ANON_KEY (.env), VAULT_GOALS_DIR (optional)

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

try { process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url))); } catch {}

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const GOALS_DIR = process.env.VAULT_GOALS_DIR || join(homedir(), 'JC AI Brain', '04-goals');
const STATE_PATH = join(dirname(fileURLToPath(import.meta.url)), '.sync-state-goals.json');

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

// ── Parsing / serialising vault files ─────────────────────────────

function parseGoalFile(path) {
  const raw = readFileSync(path, 'utf8');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;

  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  if (fm.type !== 'long' && fm.type !== 'short') return null;

  const body = m[2];
  const title = (body.match(/^# (.+)$/m) || [])[1]?.trim();
  if (!title) return null;

  const stepsDone = [], stepsNext = [];
  let section = null;
  for (const line of body.split('\n')) {
    const heading = line.match(/^## (.+)$/);
    if (heading) { section = heading[1].trim().toLowerCase(); continue; }
    const step = line.match(/^- \[( |x)\]\s+(.+)$/i);
    if (!step) continue;
    if (section === 'done') stepsDone.push(step[2].trim());
    else if (section === 'next') stepsNext.push(step[2].trim());
  }

  return {
    path, raw,
    mtime: statSync(path).mtimeMs,
    id: fm.id || null,
    status: fm.status || 'active',
    row: {
      title,
      type: fm.type,
      created: fm.created || new Date().toISOString().slice(0, 10),
      due: fm.due || null,
      steps_done: stepsDone,
      steps_next: stepsNext,
    },
  };
}

// Canonical comparison key for a row (file- or DB-shaped).
function rowKey(r) {
  return JSON.stringify([r.title, r.type, String(r.created), r.due || null,
    r.steps_done || [], r.steps_next || []]);
}

function replaceSection(text, name, newLines) {
  const lines = text.split('\n');
  const start = lines.findIndex(l => l.trim().toLowerCase() === `## ${name.toLowerCase()}`);
  if (start === -1) {
    return text.replace(/\n*$/, `\n\n## ${name}\n${newLines.join('\n')}\n`);
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) { end = i; break; }
  }
  const keptProse = lines.slice(start + 1, end)
    .filter(l => !/^- \[( |x)\]/i.test(l) && l.trim() !== '');
  const section = [lines[start], '', ...newLines, ...keptProse, ''];
  return [...lines.slice(0, start), ...section, ...lines.slice(end)].join('\n');
}

// Surgical pull: update frontmatter fields, title, and step sections from a
// DB row while preserving any other prose in the file.
function updateFileFromRow(file, row) {
  let text = file.raw.replace(/^---\n([\s\S]*?)\n---/, (m, fm) => {
    const lines = fm.split('\n').filter(l => !/^(type|created|due):/.test(l));
    const insert = [`type: ${row.type}`, `created: ${row.created}`,
      ...(row.due ? [`due: ${row.due}`] : [])];
    const idIdx = lines.findIndex(l => l.startsWith('id:'));
    lines.splice(idIdx + 1, 0, ...insert);
    return `---\n${lines.join('\n')}\n---`;
  });
  text = text.replace(/^# .+$/m, `# ${row.title}`);
  text = replaceSection(text, 'Done', (row.steps_done || []).map(s => `- [x] ${s}`));
  text = replaceSection(text, 'Next', (row.steps_next || []).map(s => `- [ ] ${s}`));
  writeFileSync(file.path, text);
}

function markFileArchived(file) {
  const text = file.raw.match(/^---\n[\s\S]*?\nstatus:.*$/m)
    ? file.raw.replace(/^status:.*$/m, 'status: archived')
    : file.raw.replace(/^---\n/, '---\nstatus: archived\n');
  writeFileSync(file.path, text);
}

function exportRow(row) {
  const slug = row.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || row.id;
  let path = join(GOALS_DIR, `${slug}.md`);
  if (existsSync(path)) path = join(GOALS_DIR, `${slug}-${row.id.slice(0, 8)}.md`);
  writeFileSync(path, [
    '---',
    `id: ${row.id}`,
    `type: ${row.type}`,
    'status: active',
    `created: ${row.created}`,
    ...(row.due ? [`due: ${row.due}`] : []),
    'area: goals',
    'tags: [goals]',
    '---',
    '',
    `# ${row.title}`,
    '',
    '## Done',
    ...(row.steps_done || []).map(s => `- [x] ${s}`),
    '',
    '## Next',
    ...(row.steps_next || []).map(s => `- [ ] ${s}`),
    '',
  ].join('\n'));
  return path;
}

// ── Sync ──────────────────────────────────────────────────────────

const shadow = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf8')) : {};
const nextShadow = {};

const dbRows = await rest('GET', 'goals?select=*');
const dbById = new Map(dbRows.map(r => [r.id, r]));
const files = readdirSync(GOALS_DIR)
  .filter(f => f.endsWith('.md'))
  .map(f => parseGoalFile(join(GOALS_DIR, f)))
  .filter(Boolean);
const fileById = new Map(files.filter(f => f.id).map(f => [f.id, f]));

let pushed = 0, pulled = 0, inserted = 0, exported = 0, deletedRows = 0,
    archivedFiles = 0, conflicts = 0, unchanged = 0;

// New goals: files without an id yet.
for (const file of files) {
  if (file.id || file.status === 'archived') continue;
  const [row] = await rest('POST', 'goals', file.row);
  writeFileSync(file.path, file.raw.replace(/^---\n/, `---\nid: ${row.id}\n`));
  nextShadow[row.id] = rowKey(file.row);
  inserted++;
  console.log(`+ inserted "${file.row.title}" (${row.id})`);
}

// Everything with an id, on either side.
const allIds = new Set([...fileById.keys(), ...dbById.keys(), ...Object.keys(shadow)]);
for (const id of allIds) {
  const file = fileById.get(id);
  const db = dbById.get(id);
  const last = shadow[id];

  if (file && file.status === 'archived') {
    if (db) { await rest('DELETE', `goals?id=eq.${id}`); deletedRows++;
      console.log(`- deleted "${file.row.title}" (archived in vault)`); }
    continue; // drop from shadow — stops syncing
  }

  if (file && db) {
    const fKey = rowKey(file.row), dKey = rowKey(db);
    if (fKey === dKey) { nextShadow[id] = fKey; unchanged++; continue; }
    const fileChanged = fKey !== last, dbChanged = dKey !== last;
    let winner;
    if (fileChanged && !dbChanged) winner = 'file';
    else if (dbChanged && !fileChanged) winner = 'db';
    else { // both changed (or no shadow): last write wins
      winner = file.mtime > Date.parse(db.updated_at || db.created_at) ? 'file' : 'db';
      conflicts++;
      console.log(`! conflict on "${db.title}" → ${winner === 'file' ? 'vault' : 'app'} wins`);
    }
    if (winner === 'file') {
      await rest('PATCH', `goals?id=eq.${id}`, file.row);
      nextShadow[id] = fKey; pushed++;
      console.log(`→ pushed "${file.row.title}"`);
    } else {
      updateFileFromRow(file, db);
      nextShadow[id] = dKey; pulled++;
      console.log(`← pulled "${db.title}"`);
    }
    continue;
  }

  if (file && !db) {
    if (last) { // existed at last sync → deleted in the app → archive the file
      markFileArchived(file); archivedFiles++;
      console.log(`✗ archived "${file.row.title}" (deleted in app)`);
    } else {    // id present but row missing (e.g. restored file) → re-insert
      await rest('POST', 'goals', { id, ...file.row });
      nextShadow[id] = rowKey(file.row); inserted++;
      console.log(`+ re-inserted "${file.row.title}" (${id})`);
    }
    continue;
  }

  if (!file && db) {
    if (last) { // file existed at last sync → deleted in vault → delete the row
      await rest('DELETE', `goals?id=eq.${id}`); deletedRows++;
      console.log(`- deleted "${db.title}" (file removed from vault)`);
    } else {    // new in the app → export to vault
      const path = exportRow(db);
      nextShadow[id] = rowKey(db); exported++;
      console.log(`↓ exported "${db.title}" → ${path}`);
    }
  }
}

writeFileSync(STATE_PATH, JSON.stringify(nextShadow, null, 2));
console.log(`sync-goals: ${inserted} inserted, ${pushed} pushed, ${pulled} pulled, ` +
  `${exported} exported, ${deletedRows} rows deleted, ${archivedFiles} files archived, ` +
  `${conflicts} conflicts, ${unchanged} unchanged`);
