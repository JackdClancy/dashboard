#!/bin/sh
# Runs all Life OS bridge jobs. Called by launchd every 15 minutes
# (~/Library/LaunchAgents/com.jackdclancy.life-os-bridge.plist) — or run
# manually. Output goes to ~/Library/Logs/life-os-bridge.log via launchd.

DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE=/usr/local/bin/node

echo "── bridge sync $(date '+%Y-%m-%d %H:%M:%S') ──"
"$NODE" "$DIR/scripts/sync-goals.mjs"
"$NODE" "$DIR/scripts/sync-tasks.mjs"
"$NODE" "$DIR/scripts/sync-projects.mjs"
"$NODE" "$DIR/scripts/sync-captures.mjs"
"$NODE" "$DIR/scripts/sync-mail.mjs"
"$NODE" "$DIR/scripts/sync-calendar.mjs"
"$NODE" "$DIR/scripts/sync-consumed.mjs"
"$NODE" "$DIR/scripts/fetch-news.mjs"
"$NODE" "$DIR/scripts/snapshot-fitness.mjs"
"$NODE" "$DIR/scripts/snapshot-finances.mjs"
