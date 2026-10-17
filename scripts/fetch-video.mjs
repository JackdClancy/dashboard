#!/usr/bin/env node
// Video content extraction for social captures (added 2026-07-14).
//
// Given a TikTok / Instagram reel / YouTube Shorts URL, pulls the ACTUAL
// video content — not just the page caption:
//   1. yt-dlp metadata → title, uploader, caption/description
//   2. creator/auto subtitles if the platform provides them
//   3. the video itself, downloaded once; from that local file ffmpeg pulls
//      - the audio → transcribed locally with whisper-cli (whisper.cpp),
//        skipped when step 2 already gave a transcript
//      - a frame every few seconds → on-screen text via macOS Vision
//        (scripts/ocr-frames.swift). Reels carry most of their substance in
//        text overlays — list items, titles, creator names — that speech
//        never says.
//   Nothing leaves the Mac.
//
// Reworked 2026-10-17: audio used to come from `yt-dlp -x --audio-format
// wav`, a single path that failed outright on some TikTok formats. Now the
// download tries several format selectors, and audio is extracted by ffmpeg
// from whatever file arrives. A failure after metadata no longer throws: the
// result carries `error` alongside whatever was recovered, and toMarkdown()
// writes an "_Extraction incomplete" marker that sync-captures.mjs retries.
//
// Used by sync-captures.mjs to enrich inbox files at capture time; also a
// standalone CLI for the vault compile skill:
//
//   node scripts/fetch-video.mjs <url>            → markdown on stdout
//
// Binaries: yt-dlp (see YTDLP_STANDALONE below), ffmpeg/ffprobe, whisper-cli (brew install yt-dlp ffmpeg
// whisper-cpp), swiftc (Xcode command line tools). Resolved via PATH or
// common brew dirs (launchd has a bare PATH). Model: WHISPER_MODEL, else
// scripts/.whisper/ggml-small.en.bin if present, else ggml-base.en.bin
// (gitignored).
//
// Logins: Instagram login-walls a lot of anonymous access. Cookies come from
// YTDLP_COOKIES_FILE, else scripts/.ytdlp-cookies.txt if it exists (written
// by scripts/export-video-cookies.mjs from a signed-in Chrome), else
// YTDLP_COOKIES_BROWSER=chrome|safari to read the browser live.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, mkdtempSync, rmSync, mkdirSync, statSync } from 'node:fs';
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

// yt-dlp's own standalone build (scripts/.bin/, gitignored) wins over
// Homebrew's: it self-updates in seconds with `-U` (bridge-sync.sh does so
// weekly), whereas `brew upgrade` on this Intel Mac compiles OpenSSL and
// Python from source. It's the zip ("onedir") build on purpose — the
// single-file build unpacks to a fresh temp dir per launch and macOS
// re-scans that every time (~30s per call, measured).
export const YTDLP_STANDALONE = join(SCRIPTS_DIR, '.bin', 'yt-dlp-dist', 'yt-dlp_macos');
const YTDLP = existsSync(YTDLP_STANDALONE) ? YTDLP_STANDALONE : resolveBin('yt-dlp');
const FFMPEG = resolveBin('ffmpeg');
const FFPROBE = resolveBin('ffprobe');
const WHISPER = resolveBin('whisper-cli') || resolveBin('whisper-cpp');
const SWIFTC = resolveBin('swiftc');
const MODEL = process.env.WHISPER_MODEL
  || [join(SCRIPTS_DIR, '.whisper', 'ggml-small.en.bin'), join(SCRIPTS_DIR, '.whisper', 'ggml-base.en.bin')]
    .find(existsSync)
  || join(SCRIPTS_DIR, '.whisper', 'ggml-base.en.bin');
export const COOKIES_FILE = process.env.YTDLP_COOKIES_FILE || join(SCRIPTS_DIR, '.ytdlp-cookies.txt');
const OCR_SRC = join(SCRIPTS_DIR, 'ocr-frames.swift');
const OCR_BIN = join(SCRIPTS_DIR, '.bin', 'ocr-frames');
const MAX_FRAMES = 60;
const OCR_MAX_CHARS = 3000;

// Matches URLs this script knows how to pull video content from.
export const VIDEO_URL_RE =
  /https?:\/\/(?:www\.)?(?:(?:vm|vt)\.tiktok\.com\/[^\s<>")]+|tiktok\.com\/[^\s<>")]+|instagram\.com\/(?:reel|reels|p|tv)\/[^\s<>")]+|youtube\.com\/shorts\/[^\s<>")]+)/i;

// Inbox files carrying either marker get retried by sync-captures.mjs.
export const RETRY_MARKER_RE = /_Extraction (?:failed|incomplete):/;

function ytdlp(args, timeout = 180000) {
  const extra = [];
  if (existsSync(COOKIES_FILE)) {
    extra.push('--cookies', COOKIES_FILE);
  } else if (process.env.YTDLP_COOKIES_BROWSER) {
    extra.push('--cookies-from-browser', process.env.YTDLP_COOKIES_BROWSER);
  }
  if (FFMPEG) extra.push('--ffmpeg-location', dirname(FFMPEG));
  return execFileSync(YTDLP, ['--no-warnings', ...extra, ...args], {
    encoding: 'utf8',
    timeout,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// First line of a child-process error that actually says something — yt-dlp
// prints its reason ("ERROR: … login required") on stderr, not in message.
function errLine(e) {
  const text = `${e.stderr || ''}\n${e.message || e}`;
  return text.split('\n').map(l => l.trim()).find(l => /error/i.test(l))
    || text.split('\n').map(l => l.trim()).find(Boolean) || 'unknown error';
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

// Downloads the video (or, failing that, any audio-bearing file) into
// workDir. Format selectors are tried in order because no single one works
// everywhere: TikTok sometimes only serves combined files, and Instagram
// occasionally refuses the video-only stream.
function downloadMedia(url, workDir) {
  const attempts = [
    ['-S', 'res:1080', '-f', 'bv*+ba/b', '--merge-output-format', 'mp4'],
    ['-f', 'b'],
    ['-f', 'ba/b'],
  ];
  let lastErr;
  for (const fmt of attempts) {
    try {
      ytdlp([...fmt, '-o', join(workDir, 'media.%(ext)s'), url], 300000);
      const file = readdirSync(workDir).find(f => f.startsWith('media.') && !f.endsWith('.part'));
      if (file) return join(workDir, file);
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`video download failed: ${lastErr ? errLine(lastErr) : 'no file produced'}`);
}

function streamTypes(file) {
  const out = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_type',
    '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return new Set(out.split(/\s+/).filter(Boolean));
}

// Whisper conditions on the caption so names and jargon it mentions
// ("Daily Stoic", "Claude Code") are spelled the way the creator spells them.
function whisperPrompt(meta) {
  return [meta.uploader, meta.title, meta.description]
    .filter(Boolean).join('. ')
    .replace(/#\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 400);
}

const norm = s => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function transcribe(mediaFile, workDir, prompt) {
  if (!WHISPER) throw new Error('whisper-cli not installed (brew install whisper-cpp)');
  if (!existsSync(MODEL)) throw new Error(`whisper model missing: ${MODEL}`);
  const wav = join(workDir, 'audio.wav');
  execFileSync(FFMPEG, ['-y', '-v', 'error', '-i', mediaFile, '-vn', '-ar', '16000', '-ac', '1', wav],
    { timeout: 120000 });
  const args = ['-m', MODEL, '-f', wav, '-np', '-nt'];
  if (prompt) args.push('--prompt', prompt);
  const out = execFileSync(WHISPER, args, {
    encoding: 'utf8',
    timeout: 900000,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).replace(/\s+/g, ' ').trim();
  // On music-only audio Whisper can echo its prompt back as "speech".
  if (!out || (prompt && norm(prompt).includes(norm(out)))) return null;
  return out;
}

function ocrBinary() {
  if (existsSync(OCR_BIN) && statSync(OCR_BIN).mtimeMs >= statSync(OCR_SRC).mtimeMs) return OCR_BIN;
  if (!SWIFTC) throw new Error('swiftc not installed (xcode-select --install)');
  mkdirSync(dirname(OCR_BIN), { recursive: true });
  execFileSync(SWIFTC, ['-O', OCR_SRC, '-o', OCR_BIN], { timeout: 300000, stdio: 'pipe' });
  return OCR_BIN;
}

// Samples up to MAX_FRAMES frames (one every 2s, spread wider on long
// videos), reads their text, and returns each distinct line once in
// first-seen order — an overlay that stays on screen for ten seconds would
// otherwise repeat five times.
//
// Many reels burn their own subtitles in, which OCR reads back as a noisy
// second copy of the speech. So a line is dropped when the transcript
// already contains it, or when it's just the start of the next line
// (subtitles that build up word by word: "i want" → "i want you to…"). What
// survives is the text a viewer reads but nobody says: title cards, list
// items, handles, repo names — plus any lines Whisper skipped.
// Word-set overlap (Jaccard); short lines need an exact match instead,
// since two-word overlays legitimately differ by one word ("No. 8" / "No. 9").
function similar(a, b) {
  if (a.size < 3 || b.size < 3) return a.size === b.size && [...a].every(w => b.has(w));
  const shared = [...a].filter(w => b.has(w)).length;
  return shared / (a.size + b.size - shared) >= 0.5;
}

function readOnScreenText(mediaFile, durationSec, workDir, transcript) {
  const bin = ocrBinary();
  const frameDir = join(workDir, 'frames');
  mkdirSync(frameDir);
  const every = Math.max(2, (durationSec || 0) / MAX_FRAMES);
  execFileSync(FFMPEG, ['-v', 'error', '-i', mediaFile, '-vf', `fps=1/${every},scale=-2:'min(1280,ih)'`,
    '-frames:v', String(MAX_FRAMES), join(frameDir, 'f%03d.png')], { timeout: 180000 });
  const frames = readdirSync(frameDir).filter(f => f.endsWith('.png')).sort().map(f => join(frameDir, f));
  if (!frames.length) return null;
  const out = execFileSync(bin, frames, { encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024 });
  const spoken = ` ${norm(transcript || '')} `;
  const spokenWords = new Set(spoken.split(' ').filter(Boolean));
  const lines = [];
  for (const line of out.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('### ')) continue;
    const key = norm(t);
    if (key.length < 2 || spoken.includes(` ${key} `)) continue;
    const words = new Set(key.split(' '));
    // Subtitle fragments OCR garbled slightly ("cloud code's performance")
    // are still mostly words the speaker said.
    const said = [...words].filter(w => spokenWords.has(w)).length / words.size;
    if (said >= (words.size <= 4 ? 1 : 0.85)) continue;
    // Screen-recording reels scroll the same page past many frames, and OCR
    // reads it slightly differently each time ("pink-rimmed" / "oink
    // himmed"), so near-duplicates are dropped too, not just exact ones.
    if (lines.some(l => similar(l.words, words))) continue;
    lines.push({ t, key, words });
  }
  const kept = lines.filter((l, i) => !(lines[i + 1]?.key.startsWith(`${l.key} `)));
  let text = '';
  for (const l of kept) {
    if (text.length + l.t.length > OCR_MAX_CHARS) { text += '…(truncated)'; break; }
    text += `${l.t}\n`;
  }
  text = text.trim();
  return text || null;
}

// Returns { title, uploader, caption, durationSec, resolvedUrl, transcript,
// transcriptSource: 'subtitles' | 'whisper' | null, onScreenText, error }.
// Throws only when nothing at all could be read (metadata failed); later
// failures land in `error` with everything recovered so far.
export function fetchVideoContent(url) {
  if (!YTDLP) throw new Error('yt-dlp not installed (brew install yt-dlp)');

  let meta;
  try {
    meta = JSON.parse(ytdlp(['--dump-json', '--no-download', url], 60000));
  } catch (e) {
    throw new Error(errLine(e));
  }
  const result = {
    title: meta.title || null,
    uploader: meta.uploader || meta.channel || meta.uploader_id || null,
    caption: (meta.description || '').trim() || null,
    durationSec: meta.duration || null,
    resolvedUrl: meta.webpage_url || url,
    transcript: null,
    transcriptSource: null,
    onScreenText: null,
    error: null,
  };
  const problems = [];

  const workDir = mkdtempSync(join(tmpdir(), 'fetch-video-'));
  try {
    // Platform-provided subtitles first — free and exact when present.
    const subLangs = Object.keys({ ...meta.subtitles, ...meta.automatic_captions });
    if (subLangs.length) {
      try {
        ytdlp(['--skip-download', '--write-subs', '--write-auto-subs',
          '--sub-langs', 'en.*,en,eng', '--convert-subs', 'srt',
          '-o', join(workDir, 'subs'), result.resolvedUrl], 120000);
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

    let media = null;
    try {
      media = downloadMedia(result.resolvedUrl, workDir);
    } catch (e) {
      problems.push(e.message);
    }

    if (media) {
      const streams = streamTypes(media);
      if (!result.transcript && streams.has('audio')) {
        try {
          result.transcript = transcribe(media, workDir, whisperPrompt(meta));
          if (result.transcript) result.transcriptSource = 'whisper';
        } catch (e) {
          problems.push(`transcription failed: ${errLine(e)}`);
        }
      }
      if (streams.has('video')) {
        try {
          result.onScreenText = readOnScreenText(media, result.durationSec, workDir, result.transcript);
        } catch (e) {
          problems.push(`on-screen text failed: ${errLine(e)}`);
        }
      }
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  if (problems.length) result.error = problems.join('; ');
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
  if (v.error) {
    lines.push('', `_Extraction incomplete: ${v.error}. Retry with \`node scripts/fetch-video.mjs "${v.resolvedUrl}"\`._`);
  }
  if (v.caption) lines.push('', '### Caption', '', v.caption);
  if (v.transcript) {
    lines.push('', `### Transcript (${v.transcriptSource === 'whisper' ? 'local Whisper' : 'platform subtitles'})`, '', v.transcript);
  } else if (!v.error) {
    lines.push('', '_No speech transcript could be extracted (video may be music-only)._');
  }
  if (v.onScreenText) {
    lines.push('', '### On-screen text (local OCR, first-seen order)', '', v.onScreenText);
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
    const v = fetchVideoContent(url);
    console.log(toMarkdown(v));
    if (v.error) process.exit(2);
  } catch (e) {
    console.error(`fetch-video failed: ${e.message.split('\n')[0]}`);
    process.exit(1);
  }
}
