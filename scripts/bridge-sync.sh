#!/bin/sh
# Runs all Life OS bridge jobs. Called by launchd every 15 minutes
# (~/Library/LaunchAgents/com.jackdclancy.life-os-bridge.plist) — or run
# manually. Output goes to ~/Library/Logs/life-os-bridge.log via launchd.

DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE=/usr/local/bin/node

echo "── bridge sync $(date '+%Y-%m-%d %H:%M:%S') ──"

# Instagram/TikTok change their pages often and a stale yt-dlp silently stops
# extracting reels, so the standalone build self-updates weekly (the stamp
# file's mtime marks the last check).
YTDLP="$DIR/scripts/.bin/yt-dlp-dist/yt-dlp_macos"
STAMP="$DIR/scripts/.bin/.yt-dlp-updated"
if [ -x "$YTDLP" ] && [ -z "$(find "$STAMP" -mtime -7 2>/dev/null)" ]; then
  "$YTDLP" -U 2>&1 | tail -1 && touch "$STAMP"
fi

"$NODE" "$DIR/scripts/sync-goals.mjs"
"$NODE" "$DIR/scripts/sync-tasks.mjs"
"$NODE" "$DIR/scripts/sync-projects.mjs"
"$NODE" "$DIR/scripts/sync-groceries.mjs"
"$NODE" "$DIR/scripts/sync-captures.mjs"
"$NODE" "$DIR/scripts/retry-video-captures.mjs"
"$NODE" "$DIR/scripts/sync-mail.mjs"
"$NODE" "$DIR/scripts/sync-calendar.mjs"
"$NODE" "$DIR/scripts/sync-consumed.mjs"
"$NODE" "$DIR/scripts/fetch-news.mjs"
"$NODE" "$DIR/scripts/sync-finances.mjs"
"$NODE" "$DIR/scripts/sync-budget.mjs"
"$NODE" "$DIR/scripts/snapshot-fitness.mjs"
"$NODE" "$DIR/scripts/snapshot-finances.mjs"
