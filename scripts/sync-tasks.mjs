#!/usr/bin/env node
// Bridge 5c: TWO-WAY tasks sync, vault (02-tasks/tasks.md) ↔ Supabase `todos`.
//
// Same shadow-state model as sync-goals.mjs, but items are single checkbox
// lines in one file:   - [ ] Title <!-- id:uuid due:YYYY-MM-DD -->
//   - line without an id comment → inserted, id stamped onto the line
//   - only the vault line changed → push;  only the app row changed → pull
//   - both changed differently → last-write-wins (file mtime vs updated_at)
//   - line deleted in vault → row deleted;  row deleted in app → line removed
//   - row without a line → appended to the file
//
// Usage: node scripts/sync-tasks.mjs
// Env:   SUPABASE_URL, SUPABASE_ANON_KEY (.env), VAULT_TASKS_FILE (optional)

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

try { process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url))); } catch {}

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const TASKS_FILE = process.env.VAULT_TASKS_FILE || join(homedir(), 'JC AI Brain', '02-tasks', 'tasks.md');
const STATE_PATH = join(dirname(fileURLToPath(import.meta.url)), '.sync-state-tasks.json');

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

const rowKey = r => JSON.stringify([r.title, !!r.completed, r.due_date || null]);
const itemLine = (r) =>
  `- [${r.completed ? 'x' : ' '}] ${r.title} <!-- id:${r.id}${r.due_date ? ` due:${r.due_date}` : ''} -->`;

function parseItemLine(line) {
  const m = line.match(/^- \[( |x)\]\s+(.*)$/i);
  if (!m) return null;
  let text = m[2];
  let id = null, due = null;
  const comment = text.match(/<!--([^>]*)-->\s*$/);
  if (comment) {
    text = text.slice(0, comment.index).trim();
    id = (comment[1].match(/id:(\S+)/) || [])[1] || null;
    due = (comment[1].match(/due:(\d{4}-\d{2}-\d{2})/) || [])[1] || null;
  }
  if (!text) return null;
  return { id, row: { title: text, completed: m[1].toLowerCase() === 'x', due_date: due } };
}

// ── Load both sides + shadow ──────────────────────────────────────

const raw = readFileSync(TASKS_FILE, 'utf8');
const mtime = statSync(TASKS_FILE).mtimeMs;
const lines = raw.split('\n');
// Skip frontmatter so nothing in it can ever parse as a task.
let bodyStart = 0;
if (lines[0] === '---') {
  const close = lines.indexOf('---', 1);
  if (close !== -1) bodyStart = close + 1;
}

const items = [];                       // { lineIdx, id, row }
for (let i = bodyStart; i < lines.length; i++) {
  const item = parseItemLine(lines[i]);
  if (item) items.push({ lineIdx: i, ...item });
}

const shadow = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf8')) : {};
const nextShadow = {};
const dbRows = await rest('GET', 'todos?select=*');
const dbById = new Map(dbRows.map(r => [r.id, r]));
const itemById = new Map(items.filter(i => i.id).map(i => [i.id, i]));

let pushed = 0, pulled = 0, inserted = 0, exported = 0, deletedRows = 0,
    removedLines = 0, conflicts = 0, unchanged = 0;
const deadLineIdxs = new Set();
const appendLines = [];
let fileDirty = false;

// New tasks: lines without an id.
for (const item of items) {
  if (item.id) continue;
  const [row] = await rest('POST', 'todos', item.row);
  lines[item.lineIdx] = itemLine(row);
  nextShadow[row.id] = rowKey(row);
  fileDirty = true;
  inserted++;
  console.log(`+ inserted "${row.title}" (${row.id})`);
}

const allIds = new Set([...itemById.keys(), ...dbById.keys(), ...Object.keys(shadow)]);
for (const id of allIds) {
  const item = itemById.get(id);
  const db = dbById.get(id);
  const last = shadow[id];

  if (item && db) {
    const fKey = rowKey(item.row), dKey = rowKey(db);
    if (fKey === dKey) { nextShadow[id] = fKey; unchanged++; continue; }
    const fileChanged = fKey !== last, dbChanged = dKey !== last;
    let winner;
    if (fileChanged && !dbChanged) winner = 'file';
    else if (dbChanged && !fileChanged) winner = 'db';
    else {
      winner = mtime > Date.parse(db.updated_at || db.created_at) ? 'file' : 'db';
      conflicts++;
      console.log(`! conflict on "${db.title}" → ${winner === 'file' ? 'vault' : 'app'} wins`);
    }
    if (winner === 'file') {
      await rest('PATCH', `todos?id=eq.${id}`, item.row);
      nextShadow[id] = fKey; pushed++;
      console.log(`→ pushed "${item.row.title}"`);
    } else {
      lines[item.lineIdx] = itemLine(db);
      nextShadow[id] = dKey; fileDirty = true; pulled++;
      console.log(`← pulled "${db.title}"`);
    }
    continue;
  }

  if (item && !db) {
    if (last) {           // deleted in the app → remove the line
      deadLineIdxs.add(item.lineIdx); fileDirty = true; removedLines++;
      console.log(`✗ removed line "${item.row.title}" (deleted in app)`);
    } else {              // id present but row missing → re-insert
      await rest('POST', 'todos', { id, ...item.row });
      nextShadow[id] = rowKey(item.row); inserted++;
      console.log(`+ re-inserted "${item.row.title}" (${id})`);
    }
    continue;
  }

  if (!item && db) {
    if (last) {           // line deleted in vault → delete the row
      await rest('DELETE', `todos?id=eq.${id}`); deletedRows++;
      console.log(`- deleted "${db.title}" (line removed from vault)`);
    } else {              // new in the app → append to the file
      appendLines.push(itemLine(db));
      nextShadow[id] = rowKey(db); fileDirty = true; exported++;
      console.log(`↓ appended "${db.title}"`);
    }
  }
}

if (fileDirty) {
  let out = lines.filter((_, i) => !deadLineIdxs.has(i));
  if (appendLines.length) {
    while (out.length && out[out.length - 1].trim() === '') out.pop();
    out.push(...appendLines, '');
  }
  writeFileSync(TASKS_FILE, out.join('\n'));
}

writeFileSync(STATE_PATH, JSON.stringify(nextShadow, null, 2));
console.log(`sync-tasks: ${inserted} inserted, ${pushed} pushed, ${pulled} pulled, ` +
  `${exported} appended, ${deletedRows} rows deleted, ${removedLines} lines removed, ` +
  `${conflicts} conflicts, ${unchanged} unchanged`);
