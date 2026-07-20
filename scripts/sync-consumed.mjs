#!/usr/bin/env node
// Feature #6: recently-consumed tile.
//
// One-way vault → app. Scans the compiled-output folders (08-knowledge/,
// 06-thoughts/, and health captures in 07-body/) for notes the compile skill
// has filed, picks the most recently created/updated, and writes them to
// Supabase app_state (key 'consumed') for the home page tile. Read-only mirror
// of the vault — never writes vault files.
//
// Running-log notes (a single note with dated `## YYYY-MM-DD` entries, e.g.
// 07-body/(AI) health-knowledge.md) are split so each dated entry becomes its
// own consumed item, dated + linked by that entry rather than the whole file.
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
const MAX_ITEMS = 50; // full list for consumed.html; the home tile shows the first 8

if (!SUPABASE_URL || !ANON_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_ANON_KEY (set in .env or environment).');
  process.exit(1);
}

const SOURCES = [
  { dir: join(VAULT, '08-knowledge'), kind: 'knowledge' },
  { dir: join(VAULT, '06-thoughts'), kind: 'thought' },
  // Health/fitness captures compile into 07-body as running-log notes. Require a
  // source link so non-content notes (grocery list, workout plan) are ignored,
  // and skip machine-written snapshot folders (log/ = Hevy snapshots).
  { dir: join(VAULT, '07-body'), kind: 'health', requireSource: true, skipDirs: ['log'] },
];

// Dated running-log heading, e.g. "## 2026-07-19 — Creatine is bigger than sport".
const DATED_H2 = /^##[ \t]+(\d{4}-\d{2}-\d{2})\b[ \t]*[—–-]?[ \t]*(.*)$/gm;

function* mdFiles(dir, skipDirs = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name.startsWith('_')) continue;
    if (e.isDirectory() && skipDirs.includes(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* mdFiles(p, skipDirs);
    else if (e.name.endsWith('.md')) yield p;
  }
}

// The compile skill records provenance either as a "Source: [label](url)" line
// or a "## Sources" bullet list — take the first link of either.
function findSource(text) {
  let src = text.match(/^Source:\s*\[([^\]]*)\]\(([^)]+)\)/m);
  if (!src) {
    const section = text.match(/^## Sources?\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m);
    if (section) src = section[1].match(/\[([^\]]*)\]\(([^)]+)\)/);
  }
  return src ? { source: src[1], link: src[2] } : { source: null, link: null };
}

// Returns an array of consumed items for one file: one item for a normal note,
// or one per dated `## YYYY-MM-DD` entry for a running-log note.
function parseFile(path, kind, opts = {}) {
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
  if (fm.status === 'archived' || fm.type === 'index') return [];

  const noteTitle = (body.match(/^#\s+(.+)$/m) || [])[1]?.trim()
    || path.split('/').pop().replace(/\.md$/, '');
  const relPath = path.slice(VAULT.length + 1);

  // Running-log note: split on dated H2 headings, newest entry per its own date.
  const heads = [];
  let hm;
  DATED_H2.lastIndex = 0;
  while ((hm = DATED_H2.exec(body))) {
    heads.push({ start: hm.index, bodyStart: hm.index + hm[0].length, date: hm[1], title: hm[2].trim() });
  }
  if (heads.length) {
    const items = heads.map((h, i) => {
      const end = i + 1 < heads.length ? heads[i + 1].start : body.length;
      const section = body.slice(h.bodyStart, end);
      const { source, link } = findSource(section);
      const when = Date.parse(h.date);
      return {
        title: h.title || `${noteTitle} — ${h.date}`,
        kind,
        link,
        source,
        essence: sectionEssence(section),
        path: relPath,
        date: h.date,
        _sort: isNaN(when) ? statSync(path).mtimeMs : when,
      };
    });
    return opts.requireSource ? items.filter(it => it.link) : items;
  }

  // Single note (original behaviour).
  const { source, link } = findSource(body);
  if (opts.requireSource && !link) return [];
  const dates = [fm.updated, fm.created]
    .map(d => (d ? Date.parse(d) : NaN)).filter(n => !isNaN(n));
  const when = dates.length ? Math.max(...dates) : statSync(path).mtimeMs;
  return [{
    title: noteTitle,
    kind,
    link,
    source,
    essence: extractEssence(body),
    path: relPath,
    date: new Date(when).toISOString().slice(0, 10),
    _sort: when,
  }];
}

// Shared markdown → plain-text cleanup, capped at 500 chars.
function cleanProse(text) {
  const plain = (text || '')
    .split('\n')
    .map(l => l.replace(/^>\s?/, '').replace(/^[-*]\s+/, '').trim())  // unwrap quotes/bullets
    .filter(l => l && !/^(\||#)/.test(l) && !/^Source:/i.test(l))     // drop tables/headings/source
    .join(' ')
    .replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > 500 ? plain.slice(0, 497).trimEnd() + '…' : plain || null;
}

// The compile skill writes an "## Essence" section (sometimes "## Takeaway").
// Fall back to the first prose paragraph after the title.
function extractEssence(body) {
  for (const name of ['Essence', 'Takeaway']) {
    const m = body.match(new RegExp(`^## ${name}\\s*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm'));
    if (m) return cleanProse(m[1]);
  }
  const afterTitle = body.replace(/^[\s\S]*?^#\s+.+$/m, '');
  const para = (afterTitle.match(/\n\n(?!Source:)([^#>|][\s\S]*?)(?=\n\n|$)/) || [])[1] || '';
  return cleanProse(para);
}

// Essence for one dated log entry: the entry body minus its Source line and
// minus the trailing "Takeaway for Jack" aside (keep the substance).
function sectionEssence(section) {
  const trimmed = section
    .split(/^\*\*Takeaway\b[^\n]*/m)[0]          // drop the trailing takeaway aside
    .replace(/^Source:[\s\S]*?\n[ \t]*\n/m, ''); // drop the whole (possibly wrapped) source line
  return cleanProse(trimmed);
}

const items = [];
for (const { dir, kind, requireSource, skipDirs } of SOURCES) {
  for (const path of mdFiles(dir, skipDirs)) {
    try {
      for (const it of parseFile(path, kind, { requireSource })) items.push(it);
    } catch (e) {
      console.log(`  ! ${path}: ${e.message}`);
    }
  }
}

items.sort((a, b) => b._sort - a._sort);
const payload = items.slice(0, MAX_ITEMS).map(({ _sort, ...rest }) => rest);

// DRY_RUN=1 prints the payload and skips the Supabase write (for local testing).
if (process.env.DRY_RUN) {
  console.log(JSON.stringify(payload, null, 2));
  console.log(`\nsync-consumed (dry run): ${payload.length} of ${items.length} items`);
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
  body: JSON.stringify({
    key: 'consumed',
    data: { fetched_at: new Date().toISOString(), items: payload },
    updated_at: new Date().toISOString(),
  }),
});
if (!res.ok) throw new Error(`Upsert app_state → ${res.status}: ${await res.text()}`);

console.log(`sync-consumed: ${payload.length} of ${items.length} items → app_state`);
