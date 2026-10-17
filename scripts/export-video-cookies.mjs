#!/usr/bin/env node
// One-off: copy Instagram/TikTok login cookies from a signed-in browser into
// scripts/.ytdlp-cookies.txt (gitignored, mode 600), which fetch-video.mjs
// passes to yt-dlp (added 2026-10-17).
//
// Why a file instead of YTDLP_COOKIES_BROWSER: reading Chrome's cookie store
// live needs the "Chrome Safe Storage" keychain item on every run, which
// prompts from the background launchd job. And yt-dlp's own export dumps
// every cookie for every site — so this filters the jar down to the video
// platforms before anything is kept on disk.
//
// Usage: node scripts/export-video-cookies.mjs [chrome|safari]   (default chrome)
// Re-run it if Instagram captures start failing with "login required" —
// Instagram sessions last months, but logging out of Chrome ends them.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { COOKIES_FILE, YTDLP_STANDALONE } from './fetch-video.mjs';

const browser = process.argv[2] || 'chrome';
const KEEP = /(^|\.)(instagram\.com|tiktok\.com)$/i;

const YTDLP = [YTDLP_STANDALONE, '/usr/local/bin/yt-dlp', '/opt/homebrew/bin/yt-dlp'].find(existsSync) || 'yt-dlp';
const work = mkdtempSync(join(tmpdir(), 'video-cookies-'));
const raw = join(work, 'all.txt');
try {
  // yt-dlp only writes its cookie jar while handling a URL; a metadata-only
  // look at Instagram's home page is enough to trigger the save.
  try {
    execFileSync(YTDLP, ['--cookies-from-browser', browser, '--cookies', raw,
      '--skip-download', '--no-warnings', '--simulate', 'https://www.instagram.com/'],
      { stdio: ['ignore', 'ignore', 'pipe'], timeout: 120000 });
  } catch {}
  if (!existsSync(raw)) {
    console.error(`Could not read ${browser} cookies (keychain access denied, or browser not found).`);
    process.exit(1);
  }
  const lines = readFileSync(raw, 'utf8').split('\n');
  const kept = lines.filter(l => {
    if (!l.trim() || (l.startsWith('#') && !l.startsWith('#HttpOnly_'))) return false;
    const domain = l.replace(/^#HttpOnly_/, '').split('\t')[0];
    return KEEP.test(domain.replace(/^\./, ''));
  });
  const igSession = kept.some(l => /instagram\.com\t/.test(l) && /\tsessionid\t/.test(l));
  writeFileSync(COOKIES_FILE, ['# Netscape HTTP Cookie File', ...kept, ''].join('\n'), { mode: 0o600 });
  chmodSync(COOKIES_FILE, 0o600);
  console.log(`Wrote ${kept.length} cookies → ${COOKIES_FILE}`);
  console.log(igSession
    ? '✓ Instagram session found — login-walled reels should now extract.'
    : '! No Instagram session cookie — sign in to instagram.com in the browser, then re-run.');
} finally {
  rmSync(work, { recursive: true, force: true });
}
