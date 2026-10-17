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
import { rest, requireSupabase, putAppState } from './bridge-lib.mjs';


const CONFIG = JSON.parse(readFileSync(fileURLToPath(new URL('./news-sources.json', import.meta.url)), 'utf8'));

requireSupabase();

// Throttle: skip if the stored payload is fresh enough.
if (!process.env.FORCE_NEWS) {
  const [existing] = await rest('GET', 'app_state?key=eq.news&select=data').catch(() => []);
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
    // Feed content is untrusted: only plain web links reach the tile, so a
    // `javascript:` link in a compromised feed can't run on the dashboard.
    const href = link ? decode(link) : null;
    const safeLink = href && /^https?:\/\//i.test(href) ? href : null;
    if (title) items.push({ title, link: safeLink, published: isNaN(published) ? null : published });
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

await putAppState('news', { fetched_at: new Date().toISOString(), categories });

console.log(`fetch-news: ${categories.reduce((n, c) => n + c.items.length, 0)} headlines → app_state`);
