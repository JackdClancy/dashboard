#!/usr/bin/env node
// Bridge: groceries sync, vault (07-body/7.1-groceries/*.md) ↔ Supabase
// `grocery_lists` + `grocery_items`. Hybrid model:
//   - LISTS are one-way vault → app (like sync-projects.mjs): `list.md` is always the
//     'common' list; any other .md file with `type: recipe` frontmatter is a recipe
//     list, named after the file. A recipe list disappears from the app when its file
//     is deleted from the vault. The 'common' list is never deleted.
//   - ITEMS within a list are two-way (like sync-tasks.mjs): checkbox lines carry an
//     `<!-- id:uuid -->` comment once synced; last-write-wins on conflicts (file mtime
//     vs `updated_at`). Items are grouped by the nearest preceding `## Heading` into a
//     `section` column (null for flat lines, e.g. the whole common list today).
//
// Usage: node scripts/sync-groceries.mjs
// Env:   SUPABASE_URL, SUPABASE_ANON_KEY (.env), VAULT_GROCERIES_DIR (optional)

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

try { process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url))); } catch {}

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const GROCERIES_DIR = process.env.VAULT_GROCERIES_DIR ||
  join(homedir(), 'JC AI Brain', '07-body', '7.1-groceries');
const STATE_PATH = join(dirname(fileURLToPath(import.meta.url)), '.sync-state-groceries.json');

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

const slugify = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const rowKey = r => JSON.stringify([r.text, !!r.checked, r.section || null]);
const itemLine = (r) =>
  `- [${r.checked ? 'x' : ' '}] ${r.text} <!-- id:${r.id} -->`;

function parseItemLine(line) {
  const m = line.match(/^- \[( |x)\]\s+(.*)$/i);
  if (!m) return null;
  let text = m[2];
  let id = null;
  const comment = text.match(/<!--([^>]*)-->\s*$/);
  if (comment) {
    text = text.slice(0, comment.index);
    id = (comment[1].match(/id:(\S+)/) || [])[1] || null;
  }
  text = text.trim();
  if (!text) return null;
  return { id, text, checked: m[1].toLowerCase() === 'x' };
}

function classify(path) {
  const name = basename(path);
  if (name === 'list.md') return { slug: 'common', name: 'Common', kind: 'common' };
  if (name === 'master.md') return { slug: 'master', name: 'Master List', kind: 'master' };
  if (!name.endsWith('.md')) return null;
  const raw = readFileSync(path, 'utf8');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  if (fm.type !== 'recipe') return null;
  const title = basename(name, '.md');
  return { slug: slugify(title), name: title, kind: 'recipe' };
}

// ── Discover files + upsert lists ───────────────────────────────────

if (!existsSync(GROCERIES_DIR)) {
  console.error(`Groceries dir not found: ${GROCERIES_DIR}`);
  process.exit(1);
}

const dbLists = await rest('GET', 'grocery_lists?select=*');
const dbListBySlug = new Map(dbLists.map(l => [l.slug, l]));

const files = readdirSync(GROCERIES_DIR)
  .map(f => join(GROCERIES_DIR, f))
  .filter(p => { try { return statSync(p).isFile(); } catch { return false; } })
  .map(path => { const meta = classify(path); return meta && { path, ...meta }; })
  .filter(Boolean);

const seenSlugs = new Set();
let listsInserted = 0, listsUpdated = 0, listsDeleted = 0;

for (const f of files) {
  seenSlugs.add(f.slug);
  const existing = dbListBySlug.get(f.slug);
  if (!existing) {
    const [row] = await rest('POST', 'grocery_lists', { slug: f.slug, name: f.name, kind: f.kind });
    f.list = row;
    listsInserted++;
    console.log(`+ list "${f.name}" (${f.slug})`);
  } else {
    f.list = existing;
    if (existing.name !== f.name) {
      await rest('PATCH', `grocery_lists?id=eq.${existing.id}`, { name: f.name });
      f.list = { ...existing, name: f.name };
      listsUpdated++;
      console.log(`~ list renamed → "${f.name}" (${f.slug})`);
    }
  }
}

// Vault is the sole author of which recipe lists exist; 'common' and 'master' are
// singleton lists that are never deleted, even if their file briefly can't be read.
for (const l of dbLists) {
  if (l.kind === 'common' || l.kind === 'master' || seenSlugs.has(l.slug)) continue;
  await rest('DELETE', `grocery_lists?id=eq.${l.id}`); // cascades to grocery_items
  listsDeleted++;
  console.log(`- list "${l.name}" deleted (no file for slug "${l.slug}")`);
}

// ── Per-file item sync ───────────────────────────────────────────────

const shadow = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf8')) : {};
const nextShadow = {};
let inserted = 0, pushed = 0, pulled = 0, exported = 0, deletedRows = 0,
    removedLines = 0, conflicts = 0, unchanged = 0;

for (const f of files) {
  const listId = f.list.id;
  const raw = readFileSync(f.path, 'utf8');
  const mtime = statSync(f.path).mtimeMs;
  const lines = raw.split('\n');

  let bodyStart = 0;
  if (lines[0] === '---') {
    const close = lines.indexOf('---', 1);
    if (close !== -1) bodyStart = close + 1;
  }

  const items = []; // { lineIdx, id, section, row }
  let section = null;
  let order = 0;
  for (let i = bodyStart; i < lines.length; i++) {
    const heading = lines[i].match(/^## (.+)$/);
    if (heading) { section = heading[1].trim(); continue; }
    const parsed = parseItemLine(lines[i]);
    if (!parsed) continue;
    items.push({
      lineIdx: i,
      id: parsed.id,
      section,
      row: { text: parsed.text, checked: parsed.checked, section },
      order: order++,
    });
  }

  const dbRows = await rest('GET', `grocery_items?select=*&list_id=eq.${listId}`);
  const dbById = new Map(dbRows.map(r => [r.id, r]));
  const itemById = new Map(items.filter(i => i.id).map(i => [i.id, i]));

  const deadLineIdxs = new Set();
  const appendBySection = new Map(); // section (or null) → [line, ...]
  let fileDirty = false;
  let nextOrder = items.length;

  // New items: lines without an id.
  for (const item of items) {
    if (item.id) continue;
    const [row] = await rest('POST', 'grocery_items',
      { list_id: listId, sort_order: item.order, ...item.row });
    lines[item.lineIdx] = itemLine(row);
    nextShadow[row.id] = rowKey(row);
    fileDirty = true;
    inserted++;
    console.log(`+ inserted "${row.text}" (${f.name})`);
  }

  const allIds = new Set([...itemById.keys(), ...dbById.keys()]);
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
        console.log(`! conflict on "${db.text}" → ${winner === 'file' ? 'vault' : 'app'} wins`);
      }
      if (winner === 'file') {
        await rest('PATCH', `grocery_items?id=eq.${id}`, item.row);
        nextShadow[id] = fKey; pushed++;
        console.log(`→ pushed "${item.row.text}"`);
      } else {
        lines[item.lineIdx] = itemLine(db);
        nextShadow[id] = dKey; fileDirty = true; pulled++;
        console.log(`← pulled "${db.text}"`);
      }
      continue;
    }

    if (item && !db) {
      if (last) {
        deadLineIdxs.add(item.lineIdx); fileDirty = true; removedLines++;
        console.log(`✗ removed line "${item.row.text}" (deleted in app)`);
      } else {
        await rest('POST', 'grocery_items', { id, list_id: listId, sort_order: item.order, ...item.row });
        nextShadow[id] = rowKey(item.row); inserted++;
        console.log(`+ re-inserted "${item.row.text}" (${id})`);
      }
      continue;
    }

    if (!item && db) {
      if (last) {
        await rest('DELETE', `grocery_items?id=eq.${id}`); deletedRows++;
        console.log(`- deleted "${db.text}" (line removed from vault)`);
      } else {
        const key = db.section || null;
        if (!appendBySection.has(key)) appendBySection.set(key, []);
        appendBySection.get(key).push(itemLine({ ...db, sort_order: nextOrder++ }));
        nextShadow[id] = rowKey(db); fileDirty = true; exported++;
        console.log(`↓ appended "${db.text}" (${f.name})`);
      }
    }
  }

  if (fileDirty) {
    let out = lines.filter((_, i) => !deadLineIdxs.has(i));

    // Append new-from-app items under their section heading if it exists in the
    // file, otherwise flat at the end (covers the common list, which has none).
    for (const [sectionName, newLines] of appendBySection) {
      if (sectionName) {
        const headingIdx = out.findIndex(l => l.trim() === `## ${sectionName}`);
        if (headingIdx !== -1) {
          let insertAt = headingIdx + 1;
          while (insertAt < out.length && !/^## /.test(out[insertAt])) insertAt++;
          // Insert before any blank line(s) separating this section from the
          // next, so the blank separator stays last in the section.
          while (insertAt > headingIdx + 1 && out[insertAt - 1].trim() === '') insertAt--;
          out.splice(insertAt, 0, ...newLines);
          continue;
        }
      }
      while (out.length && out[out.length - 1].trim() === '') out.pop();
      out.push(...newLines, '');
    }

    writeFileSync(f.path, out.join('\n'));
  }
}

writeFileSync(STATE_PATH, JSON.stringify(nextShadow, null, 2));
console.log(`sync-groceries: ${listsInserted} lists inserted, ${listsUpdated} lists updated, ` +
  `${listsDeleted} lists deleted, ${inserted} items inserted, ${pushed} pushed, ${pulled} pulled, ` +
  `${exported} appended, ${deletedRows} rows deleted, ${removedLines} lines removed, ` +
  `${conflicts} conflicts, ${unchanged} unchanged`);
