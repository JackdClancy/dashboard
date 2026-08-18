#!/usr/bin/env node
// Bridge 5c: finance categorisation, Akahu → Supabase `merchant_rules`.
//
// Resolves "what kind of place is this?" for every merchant Jack has spent at,
// and caches the answer so the app never has to guess twice. Resolution order
// (first hit wins):
//
//   1. manual   — an override Jack tapped in the app. Never overwritten here.
//   2. rule     — a house rule (finance-taxonomy.mjs), for personal strings
//                 like "Flat Account" that no lookup could resolve.
//   3. akahu    — Akahu's own NZFCC establishment classification
//                 (transaction.category.name), mapped to Jack's buckets.
//   4. ai       — headless `claude -p` identifies the business from its name
//                 and decides the bucket. Optional second pass with WebSearch
//                 for names the model doesn't recognise cold.
//
// Anything still unresolved is deliberately NOT written — it surfaces in the
// app's "Needs review" queue, where one tap becomes a permanent manual rule.
// A confidently-wrong bucket is worse than an actionable unknown.
//
// Usage: node scripts/sync-finances.mjs   (DRY_RUN=1 to print without writing)
// Env:   SUPABASE_URL, SUPABASE_ANON_KEY, AKAHU_APP_ID, AKAHU_USER_TOKEN
//        FINANCE_TRIAGE_MODEL (haiku), CLAUDE_BIN, FINANCE_WEB_LOOKUP (1),
//        FINANCE_MAX_WEB (8), FINANCE_MAX_CLASSIFY (60)

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  CATEGORIES, categoryFromAkahu, categoryFromHouseRule, normaliseKey, merchantLabel,
} from './finance-taxonomy.mjs';

try { process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url))); } catch {}

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const APP_ID = process.env.AKAHU_APP_ID;
const USER_TOKEN = process.env.AKAHU_USER_TOKEN;
const MODEL = process.env.FINANCE_TRIAGE_MODEL || 'haiku';
const WEB_LOOKUP = process.env.FINANCE_WEB_LOOKUP !== '0';
const MAX_WEB = +(process.env.FINANCE_MAX_WEB || 8);
const MAX_CLASSIFY = +(process.env.FINANCE_MAX_CLASSIFY || 60);
const MAX_PAGES = +(process.env.AKAHU_MAX_PAGES || 5);
const MAX_ATTEMPTS = +(process.env.FINANCE_MAX_ATTEMPTS || 3);
const RETRY_DAYS = +(process.env.FINANCE_RETRY_DAYS || 7);
const STATE_PATH = fileURLToPath(new URL('.sync-state-finances.json', import.meta.url));

if (!SUPABASE_URL || !ANON_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_ANON_KEY (set in .env or environment).');
  process.exit(1);
}
if (!APP_ID || !USER_TOKEN) {
  console.log('sync-finances: AKAHU_APP_ID / AKAHU_USER_TOKEN not set in .env — skipping.');
  process.exit(0);
}

const CLAUDE_BIN = process.env.CLAUDE_BIN
  || [join(homedir(), '.local/bin/claude'), '/usr/local/bin/claude', '/opt/homebrew/bin/claude']
    .find(existsSync);

async function rest(method, path, body, extraHeaders = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${ANON_KEY}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ── Akahu ─────────────────────────────────────────────────────────
// Paged: one call returns 100 transactions, which is only ~4 weeks of Jack's
// spending — not enough to fill a monthly view.
async function fetchTransactions() {
  const headers = { Authorization: `Bearer ${USER_TOKEN}`, 'X-Akahu-ID': APP_ID };
  const all = [];
  let cursor;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL('https://api.akahu.io/v1/transactions');
    if (cursor) url.searchParams.set('cursor', cursor);
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Akahu transactions → ${res.status}: ${await res.text()}`);
    const data = await res.json();
    all.push(...(data.items || []));
    cursor = data.cursor?.next;
    if (!cursor) break;
  }
  return all;
}

// ── Claude classification ─────────────────────────────────────────
// One call per run for the whole batch. The model may answer null — "I don't
// recognise this" is a valid, useful answer that routes to the review queue.
function classify(subjects, { web = false } = {}) {
  const prompt = `You are categorising bank transactions for Jack, who lives in Christchurch, New Zealand.

For each entry below, work out what kind of business or establishment it is, then assign exactly ONE spending category from this list:
${CATEGORIES.map(c => `- ${c}`).join('\n')}

Category guidance:
- Groceries: supermarkets and food shopping to cook at home (PAK'nSAVE, New World, butchers, greengrocers).
- Food: eating out or ordering in — cafes, restaurants, takeaways, fast food, bakeries.
- Alcohol: bars, pubs, nightclubs, bottle stores. A venue that is primarily a drinking establishment is Alcohol even if it serves food; a restaurant that serves wine is Food.
- Transport: fuel, rideshare, taxis, public transport, parking, vehicle servicing, flights.
- Entertainment: cinemas, events, recreation, gaming, attractions.
- Subscriptions: recurring software, streaming, cloud, phone/internet services.
- Rent: rent, flat expenses, property payments.
- Other: a real business that genuinely fits none of the above (e.g. medical, clothing, homeware, personal care).

Rules:
- "name" values are bank statement strings, which are often abbreviated or truncated. Identify the real business where you can.
- If the entry looks like a person's name, a bank transfer, or is too ambiguous to identify, return null for the category. Do NOT guess.
- Return null rather than a low-confidence guess. An unknown is handled; a wrong answer silently corrupts Jack's spending totals.
- "why" must be a short factual phrase identifying the business (e.g. "Irish pub in Christchurch", "NZ supermarket chain"), max 60 characters.
${web ? '\nUse web search to identify names you do not recognise. Prefer New Zealand results.\n' : ''}
Reply with ONLY a JSON array covering every entry, in the form:
[{"name":"...","category":"Food","why":"..."}]
Use null for category when unsure: [{"name":"...","category":null,"why":"unidentified"}]

ENTRIES:
${JSON.stringify(subjects, null, 1)}`;

  const args = ['-p', '--model', MODEL];
  if (web) {
    args.push('--allowedTools', 'WebSearch,WebFetch');
    args.push('--disallowedTools', 'Bash,Read,Glob,Grep,Write,Edit,Task,NotebookEdit');
  } else {
    args.push('--disallowedTools', 'Bash,Read,Glob,Grep,Write,Edit,WebFetch,WebSearch,Task,NotebookEdit');
  }

  const out = execFileSync(CLAUDE_BIN, args, {
    input: prompt, encoding: 'utf8',
    timeout: web ? 600000 : 300000, maxBuffer: 8 * 1024 * 1024,
  });
  return extractJsonArray(out);
}

// The web-search pass narrates around its answer, so a greedy /\[[\s\S]*\]/
// spans from the first bracket to the last and swallows prose. Scan for
// balanced, string-aware bracket regions instead and take the last one that
// parses as our answer shape.
function extractJsonArray(out) {
  const candidates = [];
  for (let i = 0; i < out.length; i++) {
    if (out[i] !== '[') continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < out.length; j++) {
      const ch = out[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '[') depth++;
      else if (ch === ']' && --depth === 0) { candidates.push(out.slice(i, j + 1)); break; }
    }
  }
  for (const c of candidates.reverse()) {
    try {
      const v = JSON.parse(c);
      if (Array.isArray(v) && v.some(x => x && typeof x === 'object' && 'name' in x)) return v;
    } catch { /* not the answer, keep looking */ }
  }
  throw new Error(`no JSON array in claude output: ${out.slice(0, 200)}`);
}

// Strictly validate model output — it decides where Jack's money is counted.
function validated(rows, expected) {
  const byName = new Map(expected.map(e => [e.name, e]));
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const subject = byName.get(r?.name);
    if (!subject) continue;
    if (r.category === null || r.category === undefined) continue;
    if (!CATEGORIES.includes(r.category)) continue;
    out.push({ subject, category: r.category, why: String(r.why || '').slice(0, 60) });
  }
  return out;
}

// ── Main ──────────────────────────────────────────────────────────

const transactions = await fetchTransactions();
console.log(`sync-finances: ${transactions.length} transactions from Akahu`);

let existing;
try {
  existing = await rest('GET', 'merchant_rules?select=key,kind,category,source');
} catch (e) {
  // Don't take the rest of the bridge down if the table isn't there yet.
  if (/PGRST205|does not exist|404/.test(e.message)) {
    const msg = 'sync-finances: `merchant_rules` table not found — run '
      + 'supabase/migrations/20260818000000_merchant_rules.sql in the Supabase SQL editor.';
    // DRY_RUN still works without the table, so the classification can be
    // previewed before committing to the schema.
    if (!process.env.DRY_RUN) { console.log(msg + ' Skipping.'); process.exit(0); }
    console.log(msg + ' Previewing against an empty rule set.\n');
    existing = [];
  } else throw e;
}
const have = new Map(existing.map(r => [`${r.kind}|${r.key}`, r]));

// Shadow state: which merchants we've already failed to identify, so the
// every-15-minutes schedule doesn't re-ask the model about them forever.
let tried = {};
try { tried = JSON.parse(readFileSync(STATE_PATH, 'utf8')).tried || {}; } catch {}

// Everything Jack has actually spent at (debits only — income isn't bucketed).
const merchants = new Map();   // key -> { key, label, akahuCategory, type, count, total }
const akahuCats = new Map();   // NZFCC category name -> count
for (const t of transactions) {
  if (!(t.amount < 0)) continue;
  const label = merchantLabel(t);
  const key = normaliseKey(label);
  if (!key) continue;
  if (!merchants.has(key)) {
    merchants.set(key, {
      key, label, akahuCategory: t.category?.name || null, type: t.type, count: 0, total: 0,
    });
  }
  const m = merchants.get(key);
  m.count++; m.total += -t.amount;
  if (!m.akahuCategory && t.category?.name) m.akahuCategory = t.category.name;
  if (t.category?.name) akahuCats.set(t.category.name, (akahuCats.get(t.category.name) || 0) + 1);
}

const upserts = [];
const now = new Date().toISOString();
const add = (kind, key, category, source, evidence, sample) => {
  upserts.push({ kind, key, category, source, evidence, sample, updated_at: now });
};

// Tier 3: Akahu's establishment classification → an akahu_category rule.
for (const name of akahuCats.keys()) {
  if (have.has(`akahu_category|${name}`)) continue;
  const cat = categoryFromAkahu(name);
  if (cat) add('akahu_category', name, cat, 'akahu', 'Akahu NZFCC classification', name);
}

// Tier 2: house rules → merchant rules.
const unresolved = [];   // to ask about this run
const deferred = [];     // still unidentified, but backed off from re-asking
for (const m of merchants.values()) {
  const prior = have.get(`merchant|${m.key}`);
  if (prior?.source === 'manual') continue;          // Jack's override always wins
  const house = categoryFromHouseRule(m.label);
  if (house) {
    if (prior?.category !== house || prior?.source !== 'rule') {
      add('merchant', m.key, house, 'rule', 'House rule', m.label);
    }
    continue;
  }
  // Covered by Akahu's classification (either already cached or added above)?
  // Pin it down as a merchant rule as well as an establishment-type rule:
  // the app resolves transaction-by-transaction, and Akahu doesn't attach its
  // category to *every* row for a given shop (an EFTPOS purchase at Bailie's
  // Bar is enriched, the ATM withdrawal at the same bar isn't). Without the
  // merchant rule those unenriched rows fall through to Unreviewed.
  if (m.akahuCategory) {
    const cached = have.get(`akahu_category|${m.akahuCategory}`)
      || upserts.find(u => u.kind === 'akahu_category' && u.key === m.akahuCategory);
    if (cached) {
      if (!prior || prior.category !== cached.category) {
        add('merchant', m.key, cached.category, 'akahu', m.akahuCategory, m.label);
      }
      continue;
    }
  }
  if (prior) continue;                                // already resolved previously

  // Some strings are permanently unresolvable — a flatmate's name on a bank
  // transfer will never be identifiable by any lookup. This job runs every 15
  // minutes, so without a memory of failed attempts we'd re-ask the model
  // about "Joe G" forever. Back off, then stop; Jack's manual tap in the app
  // is the real answer for these.
  const t = tried[m.key];
  if (t) {
    if (t.attempts >= MAX_ATTEMPTS) { deferred.push(m); continue; }
    if (Date.now() - new Date(t.at).getTime() < RETRY_DAYS * 86400000) { deferred.push(m); continue; }
  }
  unresolved.push(m);
}

// Tier 4: ask Claude what these places are.
let aiResolved = 0, stillUnknown = [];
if (unresolved.length && !CLAUDE_BIN) {
  console.log('sync-finances: claude CLI not found — set CLAUDE_BIN in .env. Skipping AI tier.');
  stillUnknown = unresolved;
} else if (unresolved.length) {
  // Biggest spend first, so a capped run resolves the money that matters.
  const batch = unresolved.sort((a, b) => b.total - a.total).slice(0, MAX_CLASSIFY);
  const subjects = batch.map(m => ({
    name: m.label,
    cleaned: m.key,                    // card/ref noise stripped, often clearer
    akahu_category: m.akahuCategory || undefined,
    transaction_type: m.type,
    times_seen: m.count,
  }));

  let resolved = [];
  try {
    resolved = validated(classify(subjects), subjects);
  } catch (e) {
    console.log(`  ! classification failed: ${e.message.split('\n')[0]} — leaving for next run`);
  }

  const byLabel = new Map(batch.map(m => [m.label, m]));
  const done = new Set();
  for (const r of resolved) {
    const m = byLabel.get(r.subject.name);
    if (!m) continue;
    add('merchant', m.key, r.category, 'ai', r.why, m.label);
    done.add(m.key); aiResolved++;
  }
  stillUnknown = batch.filter(m => !done.has(m.key));

  // Second pass: look up the names the model didn't recognise cold.
  if (WEB_LOOKUP && stillUnknown.length && CLAUDE_BIN) {
    const webBatch = stillUnknown.slice(0, MAX_WEB);
    const webSubjects = webBatch.map(m => ({
      name: m.label, transaction_type: m.type, times_seen: m.count,
    }));
    try {
      const webResolved = validated(classify(webSubjects, { web: true }), webSubjects);
      const byWebLabel = new Map(webBatch.map(m => [m.label, m]));
      for (const r of webResolved) {
        const m = byWebLabel.get(r.subject.name);
        if (!m) continue;
        add('merchant', m.key, r.category, 'ai', `${r.why} (web)`, m.label);
        done.add(m.key); aiResolved++;
      }
      stillUnknown = stillUnknown.filter(m => !done.has(m.key));
    } catch (e) {
      console.log(`  ! web lookup failed: ${e.message.split('\n')[0]}`);
    }
  }
}

// Anything we asked about and couldn't identify gets an attempt recorded.
const now2 = new Date().toISOString();
for (const m of stillUnknown) {
  tried[m.key] = { at: now2, attempts: (tried[m.key]?.attempts || 0) + 1, label: m.label };
}
// Once a merchant is resolved (by us or by Jack), drop its failure record so a
// later description change gets a fresh chance.
for (const u of upserts) if (u.kind === 'merchant') delete tried[u.key];

if (process.env.DRY_RUN) {
  console.log(JSON.stringify(upserts, null, 2));
  console.log(`\nsync-finances (dry run): ${upserts.length} rules, ${stillUnknown.length} left for review`);
  process.exit(0);
}

if (upserts.length) {
  await rest('POST', 'merchant_rules?on_conflict=kind,key', upserts,
    { Prefer: 'resolution=merge-duplicates' });
}
writeFileSync(STATE_PATH, JSON.stringify({ tried }, null, 2));

// Report everything still unidentified, not just what we asked about this run —
// once the backoff kicks in `stillUnknown` goes empty while those merchants are
// very much still sitting in the app's Unreviewed bucket.
const needReview = [...stillUnknown, ...deferred].sort((a, b) => b.total - a.total);
const bySource = upserts.reduce((a, u) => ({ ...a, [u.source]: (a[u.source] || 0) + 1 }), {});
console.log(`sync-finances: ${merchants.size} merchants seen, ${upserts.length} rules written`
  + ` (${Object.entries(bySource).map(([s, n]) => `${n} ${s}`).join(', ') || 'none'})`
  + `, ${aiResolved} identified by AI, ${needReview.length} awaiting review`
  + (deferred.length ? ` (${deferred.length} backed off from re-asking)` : ''));
if (needReview.length) {
  console.log('  needs review: ' + needReview.slice(0, 10)
    .map(m => `${m.label} ($${m.total.toFixed(0)})`).join(', '));
}
