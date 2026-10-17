#!/usr/bin/env node
// Retries video extraction for inbox captures that didn't fully come
// through (added 2026-10-17).
//
// sync-captures.mjs extracts a reel's content once, at capture time. When
// that fails — Instagram login wall, a flaky download, a format the audio
// step choked on — the inbox file gets an "_Extraction failed:" or
// "_Extraction incomplete:" marker, and before this script nothing ever
// looked at it again: a reel only came through if Jack happened to share it
// twice. This re-runs fetch-video.mjs on marked files in 00-inbox/raw/ and
// swaps the improved block in place.
//
// Backoff lives in scripts/.sync-state-video-retries.json (gitignored):
// at most VIDEO_MAX_ATTEMPTS (3) tries per file, VIDEO_RETRY_GAP_HOURS (2)
// apart, VIDEO_RETRY_PER_RUN (2) files per run — each try can take minutes
// and this runs inside the 15-min bridge. After the last attempt the marker
// stays and the compile skill reports the item as not recovered.
//
// Usage: node scripts/retry-video-captures.mjs   (FORCE_VIDEO_RETRY=1 ignores backoff)

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { VIDEO_URL_RE, RETRY_MARKER_RE, fetchVideoContent, toMarkdown } from './fetch-video.mjs';

try { process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url))); } catch {}

const VAULT_DIR = process.env.VAULT_DIR || join(homedir(), 'JC AI Brain');
const RAW_DIR = join(VAULT_DIR, '00-inbox', 'raw');
const STATE_PATH = fileURLToPath(new URL('./.sync-state-video-retries.json', import.meta.url));
const MAX_ATTEMPTS = Number(process.env.VIDEO_MAX_ATTEMPTS || 3);
const GAP_MS = Number(process.env.VIDEO_RETRY_GAP_HOURS || 2) * 3600e3;
const PER_RUN = Number(process.env.VIDEO_RETRY_PER_RUN || 2);
const FORCE = process.env.FORCE_VIDEO_RETRY === '1';
const BLOCK_HEADING = '## Video content (auto-extracted)';

if (!existsSync(RAW_DIR)) process.exit(0);

let state = {};
try { state = JSON.parse(readFileSync(STATE_PATH, 'utf8')); } catch {}

const files = readdirSync(RAW_DIR).filter(f => f.endsWith('.md'));
// Files the compile skill has since archived don't need tracking.
for (const name of Object.keys(state)) if (!files.includes(name)) delete state[name];

let tried = 0, recovered = 0;
for (const name of files) {
  if (tried >= PER_RUN) break;
  const path = join(RAW_DIR, name);
  const text = readFileSync(path, 'utf8');
  const at = text.indexOf(BLOCK_HEADING);
  if (at === -1 || !RETRY_MARKER_RE.test(text.slice(at))) continue;
  const url = text.match(VIDEO_URL_RE)?.[0];
  if (!url) continue;

  const s = state[name] || { attempts: 0, last: 0 };
  if (!FORCE && (s.attempts >= MAX_ATTEMPTS || Date.now() - s.last < GAP_MS)) continue;

  tried++;
  s.attempts++;
  s.last = Date.now();
  state[name] = s;
  let block;
  try {
    const v = fetchVideoContent(url);
    block = toMarkdown(v);
    if (!v.error) recovered++;
    console.log(`${v.error ? '~ partial' : '✓ recovered'} (${s.attempts}/${MAX_ATTEMPTS}) ${name}${v.error ? `: ${v.error}` : ''}`);
  } catch (e) {
    console.log(`! still failing (${s.attempts}/${MAX_ATTEMPTS}) ${name}: ${e.message.split('\n')[0]}`);
    block = `${BLOCK_HEADING}\n\n_Extraction failed: ${e.message.split('\n')[0]}. Retry with \`node scripts/fetch-video.mjs "${url}"\`._`;
  }
  // sync-captures.mjs always appends the video block last, so everything
  // from its heading to EOF is ours to replace.
  writeFileSync(path, `${text.slice(0, at)}${block}\n`);
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
if (tried) console.log(`retry-video-captures: ${recovered}/${tried} recovered`);
