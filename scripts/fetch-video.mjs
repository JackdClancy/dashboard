#!/usr/bin/env node
// Video content extraction for social captures (added 2026-07-14).
//
// Given a TikTok / Instagram reel / YouTube Shorts URL, pulls the ACTUAL
// video content — not just the page caption:
//   1. yt-dlp metadata → title, uploader, caption/description
//   2. creator/auto subtitles if the platform provides them, else
//   3. download audio (yt-dlp + ffmpeg) → transcribe locally with
//      whisper-cli (whisper.cpp). Nothing leaves the Mac.
//
// Used by sync-captures.mjs to enrich inbox files at capture time; also a
// standalone CLI for the vault compile skill:
//
//   node scripts/fetch-video.mjs <url>            → markdown on stdout
//
// Binaries: yt-dlp, ffmpeg, whisper-cli (brew install yt-dlp ffmpeg
// whisper-cpp). Resolved via PATH or common brew dirs (launchd has a bare
// PATH). Model: scripts/.whisper/ggml-base.en.bin (gitignored), override
// with WHISPER_MODEL. Instagram sometimes login-walls anonymous access —
// set YTDLP_COOKIES_BROWSER=safari (or chrome) in .env to reuse browser
// cookies for those.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));

try { process.loadEnvFile(join(SCRIPTS_DIR, '..', '.env')); } catch {}

const BIN_DIRS = ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin'];

function resolveBin(name) {
  try {
    return execFileSync('/usr/bin/which', [name], { encoding: 'utf8' }).trim();
  } catch {}
  for (const dir of BIN_DIRS) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

const YTDLP = resolveBin('yt-dlp');
const FFMPEG = resolveBin('ffmpeg');
const WHISPER = resolveBin('whisper-cli') || resolveBin('whisper-cpp');
const MODEL = process.env.WHISPER_MODEL || join(SCRIPTS_DIR, '.whisper', 'ggml-base.en.bin');

// Matches URLs this script knows how to pull video content from.
export const VIDEO_URL_RE =
  /https?:\/\/(?:www\.)?(?:(?:vm|vt)\.tiktok\.com\/[^\s<>")]+|tiktok\.com\/[^\s<>")]+|instagram\.com\/(?:reel|reels|p|tv)\/[^\s<>")]+|youtube\.com\/shorts\/[^\s<>")]+)/i;

function ytdlp(args, timeout = 180000) {
  const extra = [];
  if (process.env.YTDLP_COOKIES_BROWSER) {
    extra.push('--cookies-from-browser', process.env.YTDLP_COOKIES_BROWSER);
  }
  if (FFMPEG) extra.push('--ffmpeg-location', dirname(FFMPEG));
  return execFileSync(YTDLP, ['--no-warnings', ...extra, ...args], {
    encoding: 'utf8',
    timeout,
    maxBuffer: 32 * 1024 * 1024,
  });
}

// SRT/VTT → plain text: drop indices, timestamps, tags; dedupe rolling repeats.
function subsToText(raw) {
  const lines = [];
  for (let line of raw.split(/\r?\n/)) {
    line = line.trim();
    if (!line || /^\d+$/.test(line)) continue;
    if (/-->/.test(line) || /^WEBVTT/i.test(line) || /^(Kind|Language):/i.test(line)) continue;
    line = line.replace(/<[^>]+>/g, '').trim();
    if (line && line !== lines[lines.length - 1]) lines.push(line);
  }
  return lines.join(' ').replace(/\s+/g, ' ').trim();
}

function transcribeAudio(url, workDir) {
  if (!WHISPER) throw new Error('whisper-cli not installed (brew install whisper-cpp)');
  if (!existsSync(MODEL)) throw new Error(`whisper model missing: ${MODEL}`);
  ytdlp(['-x', '--audio-format', 'wav', '--postprocessor-args', 'ffmpeg:-ar 16000 -ac 1',
    '-o', join(workDir, 'audio.%(ext)s'), url]);
  const wav = readdirSync(workDir).find(f => f.endsWith('.wav'));
  if (!wav) throw new Error('audio download produced no wav');
  const out = execFileSync(WHISPER, ['-m', MODEL, '-f', join(workDir, wav), '-np', '-nt'], {
    encoding: 'utf8',
    timeout: 600000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return out.replace(/\s+/g, ' ').trim();
}

// Returns { title, uploader, caption, durationSec, resolvedUrl, transcript,
// transcriptSource: 'subtitles' | 'whisper' | null, error? }.
export function fetchVideoContent(url) {
  if (!YTDLP) throw new Error('yt-dlp not installed (brew install yt-dlp)');

  const meta = JSON.parse(ytdlp(['--dump-json', '--no-download', url], 60000));
  const result = {
    title: meta.title || null,
    uploader: meta.uploader || meta.channel || meta.uploader_id || null,
    caption: (meta.description || '').trim() || null,
    durationSec: meta.duration || null,
    resolvedUrl: meta.webpage_url || url,
    transcript: null,
    transcriptSource: null,
  };

  const workDir = mkdtempSync(join(tmpdir(), 'fetch-video-'));
  try {
    // Platform-provided subtitles first — free and exact when present.
    const subLangs = Object.keys({ ...meta.subtitles, ...meta.automatic_captions });
    if (subLangs.length) {
      try {
        ytdlp(['--skip-download', '--write-subs', '--write-auto-subs',
          '--sub-langs', 'en.*,en,eng', '--convert-subs', 'srt',
          '-o', join(workDir, 'subs'), url], 120000);
        const subFile = readdirSync(workDir).find(f => /\.(srt|vtt)$/.test(f));
        if (subFile) {
          const text = subsToText(readFileSync(join(workDir, subFile), 'utf8'));
          if (text.length > 20) {
            result.transcript = text;
            result.transcriptSource = 'subtitles';
          }
        }
      } catch {}
    }
    if (!result.transcript) {
      result.transcript = transcribeAudio(result.resolvedUrl, workDir);
      result.transcriptSource = 'whisper';
      if (!result.transcript) { result.transcript = null; result.transcriptSource = null; }
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  return result;
}

// Markdown block appended to inbox capture files / printed by the CLI.
export function toMarkdown(v) {
  const mins = v.durationSec ? `${Math.floor(v.durationSec / 60)}:${String(Math.round(v.durationSec % 60)).padStart(2, '0')}` : null;
  const lines = ['## Video content (auto-extracted)', ''];
  if (v.title) lines.push(`**Title:** ${v.title}`);
  if (v.uploader) lines.push(`**Uploader:** ${v.uploader}`);
  if (mins) lines.push(`**Duration:** ${mins}`);
  lines.push(`**Source:** ${v.resolvedUrl}`);
  if (v.caption) lines.push('', '### Caption', '', v.caption);
  if (v.transcript) {
    lines.push('', `### Transcript (${v.transcriptSource === 'whisper' ? 'local Whisper' : 'platform subtitles'})`, '', v.transcript);
  } else {
    lines.push('', '_No speech transcript could be extracted (video may be music-only)._');
  }
  return lines.join('\n');
}

// CLI mode
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.argv[2];
  if (!url) {
    console.error('Usage: node scripts/fetch-video.mjs <tiktok/instagram/shorts url>');
    process.exit(1);
  }
  try {
    console.log(toMarkdown(fetchVideoContent(url)));
  } catch (e) {
    console.error(`fetch-video failed: ${e.message.split('\n')[0]}`);
    process.exit(1);
  }
}
