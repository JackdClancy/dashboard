#!/usr/bin/env node
// Feature #7b: news tile.
//
// Aggregates the RSS/Atom feeds in scripts/news-sources.json into categorised
// headlines and writes them to Supabase app_state (key 'news') for the home
// page tile. Self-throttles to one real fetch per `refresh_hours` (the bridge
// runs every 15 min; news only needs to be daily). FORCE_NEWS=1 overrides.
// Edit news-sources.json to change sources/categories — no code changes needed.
//
// Usage: node scripts/fetch-news.mjs
// Env:   SUPABASE_URL, SUPABASE_ANON_KEY (.env), FORCE_NEWS (optional)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

try { process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url))); } catch {}

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const CONFIG = JSON.parse(readFileSync(fileURLToPath(new URL('./news-sources.json', import.meta.url)), 'utf8'));

if (!SUPABASE_URL || !ANON_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_ANON_KEY (set in .env or environment).');
  process.exit(1);
}

const sbHeaders = { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' };

// Throttle: skip if the stored payload is fresh enough.
if (!process.env.FORCE_NEWS) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/app_state?key=eq.news&select=data`, { headers: sbHeaders });
  const [existing] = res.ok ? await res.json() : [];
  const fetchedAt = existing?.data?.fetched_at ? Date.parse(existing.data.fetched_at) : 0;
  if (Date.now() - fetchedAt < (CONFIG.refresh_hours || 20) * 3600000) {
    console.log('fetch-news: still fresh — skipping (FORCE_NEWS=1 to override)');
    process.exit(0);
  }
}

const decode = s => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/<[^>]+>/g, '').trim();

// Minimal RSS 2.0 + Atom parser: title, link, published (ms epoch).
function parseFeed(xml) {
  const items = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/g) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/g) || [];
  for (const b of blocks) {
    const title = decode((b.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || '');
    let link = (b.match(/<link[^>]*>([\s\S]*?)<\/link>/) || [])[1]?.trim();
    if (!link) link = (b.match(/<link[^>]*href="([^"]+)"/) || [])[1];
    // Podcast feeds often have no <link> — fall back to a URL-shaped guid.
    if (!link) {
      const guid = (b.match(/<guid[^>]*>([\s\S]*?)<\/guid>/) || [])[1]?.trim();
      if (guid && /^https?:/.test(guid)) link = guid;
    }
    const dateStr = (b.match(/<(?:pubDate|published|updated|dc:date)[^>]*>([\s\S]*?)<\/(?:pubDate|published|updated|dc:date)>/) || [])[1];
    const published = dateStr ? Date.parse(dateStr.trim()) : NaN;
    if (title) items.push({ title, link: link ? decode(link) : null, published: isNaN(published) ? null : published });
  }
  return items;
}

async function fetchFeed(feed) {
  try {
    const res = await fetch(feed.url, {
      signal: AbortSignal.timeout(25000),
      headers: { 'User-Agent': 'Mozilla/5.0 (life-os-bridge)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseFeed(await res.text()).map(i => ({ ...i, source: feed.name }));
  } catch (e) {
    console.log(`  ! ${feed.name}: ${e.message}`);
    return [];
  }
}

const categories = [];
for (const cat of CONFIG.categories) {
  const cutoff = Date.now() - (cat.window_hours || 48) * 3600000;
  const perFeed = await Promise.all(cat.feeds.map(fetchFeed));
  let items;
  if (cat.mode === 'latest_per_feed') {
    // One newest item per feed (e.g. latest episode per podcast), if recent.
    items = perFeed
      .map(list => list.filter(i => i.published && i.published >= cutoff)
        .sort((a, b) => b.published - a.published)[0])
      .filter(Boolean);
  } else {
    // Interleave feeds so one chatty source doesn't crowd out the others.
    const lists = perFeed.map(list =>
      list.filter(i => i.published && i.published >= cutoff)
        .sort((a, b) => b.published - a.published));
    items = [];
    for (let i = 0; items.length < (cat.max || 5) * 2 && lists.some(l => l[i]); i++) {
      for (const l of lists) if (l[i]) items.push(l[i]);
    }
    const seen = new Set();
    items = items.filter(i => {
      const k = i.title.toLowerCase().slice(0, 60);
      return seen.has(k) ? false : seen.add(k);
    });
  }
  items.sort((a, b) => b.published - a.published);
  categories.push({
    key: cat.key,
    label: cat.label,
    items: items.slice(0, cat.max || 5).map(i => ({
      title: i.title, link: i.link, source: i.source,
      published: new Date(i.published).toISOString(),
    })),
  });
  console.log(`  ${cat.label}: ${Math.min(items.length, cat.max || 5)} items`);
}

const res = await fetch(`${SUPABASE_URL}/rest/v1/app_state`, {
  method: 'POST',
  headers: { ...sbHeaders, Prefer: 'resolution=merge-duplicates' },
  body: JSON.stringify({
    key: 'news',
    data: { fetched_at: new Date().toISOString(), categories },
    updated_at: new Date().toISOString(),
  }),
});
if (!res.ok) throw new Error(`Upsert app_state → ${res.status}: ${await res.text()}`);

console.log(`fetch-news: ${categories.reduce((n, c) => n + c.items.length, 0)} headlines → app_state`);
