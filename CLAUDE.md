# Jack's Dashboard

Static multi-page site (no build step, no framework) deployed via Vercel. Pages: `index.html`, `gym.html`, `finances.html`, `goals.html`, `consumed.html`. Styling is Tailwind via CDN (`tailwind.config` inline) plus a `<style>` block of custom CSS per page; `finances.html` additionally links `finances.css`.

> **This app is the "window" surface of Jack's Life OS.** Governing spec (local snapshot, gitignored):
> `docs/life-os-spec-v3.md` — read it before bridge work. The vault (`~/JC AI Brain`) is the "depth"
> surface; the two connect via **Supabase sync jobs**, not shared files. Don't move this repo into
> the vault; keep them separate (spec §3/§5).

## Bridge scripts (`scripts/`)

The bridge between the vault and Supabase, built 2026-07-03 (spec §5). Zero-dependency Node,
credentials in `.env` (gitignored). Run everything: `sh scripts/bridge-sync.sh`, or install
`scripts/com.jackdclancy.life-os-bridge.plist` into `~/Library/LaunchAgents/` for every-15-min runs.

- `sync-goals.mjs` — **two-way** `~/JC AI Brain/04-goals/*.md` ↔ `goals` table. Shadow state in
  `scripts/.sync-state-goals.json` (gitignored); last-write-wins on conflicts (file mtime vs
  `updated_at`). New file → insert + uuid written back to frontmatter; `status: archived` → row
  deleted; row deleted in app → file marked archived; row with no file → exported to vault.
- `sync-tasks.mjs` — **two-way** `~/JC AI Brain/02-tasks/tasks.md` checkbox lines ↔ `todos` table.
  Same model; each line carries an `<!-- id:… due:… -->` comment.
- `sync-projects.mjs` — **one-way vault → app**: `.md` pointer files in the root of
  `~/JC AI Brain/03-projects/` (frontmatter `type: project`, `status`, title heading, `**Next:**`
  line) → `projects` table → the home page's Current Projects tile. The vault is the only author:
  rows without a pointer file are deleted. **Auto-Next (added 2026-07-06):** before syncing, the
  script refreshes each pointer's `**Next:**` line from the newest file in the project's Layer-2
  `07 Iteration Logs/` folder (fallback `02 Decisions/`, the pre-2026-07-06 location; folder
  matched by pointer basename, case-insensitive, or frontmatter `folder:`), reading its
  `**Next:**` line or `## Next` section — so ending every iteration log with a `**Next:**` line
  keeps the dashboard cue current. A hand-edit to the pointer wins until a newer log lands
  (mtime comparison).
- `snapshot-fitness.mjs` / `snapshot-finances.mjs` — one-way app → vault markdown snapshots
  (Hevy → `07-body/7.2-gym/log/`, Akahu → `10-finances/data/`). Skip silently until
  `HEVY_API_KEY` / `AKAHU_APP_ID` + `AKAHU_USER_TOKEN` are added to `.env`.
- `calendar-lib.mjs` — shared calendar data access (added 2026-07-20). Reads and writes are
  deliberately split across two mechanisms, because Calendar.app's JXA scripting bridge turned out
  to be too slow for bulk reads: `readUpcomingEvents()` parses the ICS export + bridge-events
  ledger (same source `sync-calendar.mjs` uses for the tile) — fast, plain text. Jack's
  `CALENDAR_ICS` is a live iCloud public-share `webcal://` link (Calendar.app → Personal → Share
  Calendar → Public Calendar), so no manual re-export is needed — but that publish feed is its own
  eventually-consistent snapshot, not instant: observed both a multi-minute lag before a new event
  appeared, and, more importantly, **the uid the public feed reports for an event is not the same
  uid Calendar.app uses internally** (confirmed directly — the same event showed a different uid
  via the feed vs. a local `whose({summary:...})` lookup). Passing a feed uid straight to
  `updateEvent`/`deleteEvent` fails with "Event not found" — so both take `matchTitle`/`matchDate`
  instead of trusting a feed uid, resolving the true local event by summary+day and mutating it in
  the SAME `whose()` scan (deliberately not a separate resolve-then-write pair of scans — that
  doubled the failure window and was caught corrupting an event's end time mid-edit while building
  this). `sync-captures.mjs`'s update/delete path and `calendar-manager.mjs`'s
  `edit`/`remove`/`dedupe --apply` all pass `matchTitle`/`matchDate`; never call them with a uid
  straight from `readUpcomingEvents()` alone. `addEvent`, `updateEvent`, `deleteEvent` go through
  Calendar.app via osascript — unavoidable for actually mutating the calendar, but measured highly
  variable per `updateEvent`/`deleteEvent` call against Jack's ~550-event Personal calendar (38s one
  run, 5+ minutes the next, same operation — Calendar.app's `whose()` predicate evaluation scans the
  *entire* event history, not just the matches, and that cost isn't stable; `addEvent`/push is fast,
  a few seconds, since it doesn't scan). Their osascript timeout is set to 8 minutes on purpose —
  killing the process mid-edit doesn't cleanly abort it, it can leave a **partially-applied** edit
  (observed directly: title changed, time didn't, because the process was killed between the two
  property writes). Also: Calendar.app validates start < end on EACH property write, not just at
  save time, so `updateEvent` picks whichever of startDate/endDate is safe to write first against
  the other's still-current value — writing them in a fixed order fails outright whenever a new
  start time lands after the old end time (also observed directly). Use `updateEvent`/`deleteEvent`
  only for single, deliberate mutations, never in a loop. Also fixed: the ledger-merge's "is this
  today or later" cutoff used `someDate.toISOString().slice(0, 10)` — for a UTC-ahead timezone like
  NZ (UTC+12), converting local midnight to ISO/UTC rolls the date back a day, so yesterday's
  events kept passing the cutoff and stayed on the Upcoming tile (observed directly). Fixed with a
  local-Y-M-D string helper (`toDateStr`) instead of `toISOString()` — never use `toISOString()` for
  a date-only comparison against local calendar dates in this file. `findDuplicate` (same-day +
  fuzzy-title match) runs against the `readUpcomingEvents()` list — used as a pre-add dedupe check and to
  resolve which existing event a natural-language edit/cancel refers to. `sync-captures.mjs`,
  `sync-mail.mjs`, and `calendar-manager.mjs` all import this instead of building their own
  AppleScript.
- `sync-captures.mjs` — drains the `captures` queue (home page quick-add bar, plus the share-sheet
  entry points below). **Calendar intent (reworked 2026-07-20):** each capture is classified once
  by headless `claude -p` (`CAPTURE_TRIAGE_MODEL`, default haiku), given the next 45 days of
  existing events (`readUpcomingEvents()`) as context, into `add` (a new event — e.g. "Dentist
  appointment on the 7th at 4pm"), `update` (e.g. "move my dentist appt to 4pm" — only acted on
  when the model points at one specific existing event copied from that context), `delete` (e.g.
  "cancel my dentist appointment"), or `none`. `add` is skipped if `findDuplicate`
  (`calendar-lib.mjs`) finds a same-day, similar-title event already on the calendar — the fix for
  mail/captures creating duplicate events. Calendar writes go through `calendar-lib.mjs` and are
  logged to the vault ledger `09-calendar/(AI) bridge-events.json` (update/delete edit or remove
  the matching ledger entry), which `readUpcomingEvents()` (and so `sync-calendar.mjs`'s Upcoming
  tile) picks up next run. If classification fails (e.g. `claude` CLI unavailable) the
  whole queue is left untouched and retried next run. `none` → a `00-inbox/raw/*.md` file for the
  vault `compile` skill, with frontmatter `source:` set from the row's `source` column (default
  `app-quick-add`). **Video enrichment (added 2026-07-14):**
  captures containing a TikTok / Instagram reel / YouTube Shorts URL get a
  `## Video content (auto-extracted)` block appended — uploader, caption, and a transcript of the
  video's speech via `scripts/fetch-video.mjs` (yt-dlp + ffmpeg + local whisper-cli; model at
  `scripts/.whisper/ggml-base.en.bin`, gitignored; all local, nothing uploaded). Extraction
  failure never blocks the capture — the file gets a retry-command note instead. Optional
  `YTDLP_COOKIES_BROWSER=safari|chrome` in `.env` if Instagram starts login-walling anonymous
  access.

### Capture entry points (share-to-inbox)

The `captures` table (`id`, `content`, `source`, `created_at`) has three writers, all landing in
the same `sync-captures.mjs` drain above — sharing an article or an Instagram post/reel from phone
or laptop lands it in the vault inbox the same way typing in the quick-add bar does:

- **Home page quick-add bar** (`index.html`) — `source: app-quick-add` (DB default).
- **iOS Share Sheet** — `scriptable/share-to-inbox.js`. Install in the Scriptable app (see the
  file's header comment) and enable it under Share Sheet; then any app's Share action (Chrome,
  Safari, Instagram) → Scriptable → Capture inserts the shared URL/text with `source: share-ios`.
- **Laptop/desktop** — `bookmarklet/capture.md` has a one-click bookmarklet (desktop browsers have
  no native share-sheet-to-third-party mechanism) that captures the current tab's title + URL with
  `source: share-bookmarklet`.

All three insert directly to Supabase via the public anon key (same pattern as
`scriptable/todo-widget.js`) — no server code involved.
- `sync-mail.mjs` — **one-way Apple Mail → app** with AI triage (added 2026-07-14). Reads the
  unified inbox (last `MAIL_LOOKBACK_DAYS`, default 7) via osascript/JXA; new messages are
  classified once by headless `claude -p` (`MAIL_TRIAGE_MODEL`, default haiku; binary resolved
  via `CLAUDE_BIN` or common install paths) — verdicts cached in
  `scripts/.sync-state-mail.json`, so a failed triage just retries next run. Important mail
  (real people/companies Jack must read or reply to — never newsletters, promos, notifications,
  receipts, OTPs) → `app_state` key `mail` → home Mail tile showing sender, subject, received
  time **only** (bodies never leave the Mac — the DB policies are public). Archiving/deleting a
  message in Mail drops it from the tile next run. The classifier also extracts concrete actions
  from any email, important or not: appointments/bookings → Apple Calendar (via `calendar-lib.mjs`,
  with the same `findDuplicate` pre-add dedupe check as `sync-captures.mjs`) + the bridge-events
  ledger (same path as `sync-captures.mjs`), explicit tasks → `todos` table (which
  `sync-tasks.mjs` pulls into the vault). Email bodies are untrusted input: the triage call runs
  with tools disallowed and its output is strictly parsed/validated.
- `sync-consumed.mjs` — **one-way vault → app**: scans the compile skill's output folders
  (`08-knowledge/`, `06-thoughts/`, skipping `_`-prefixed files and `type: index` /
  `status: archived` notes) → 50 most recent by frontmatter `updated`/`created` → `app_state` key
  `consumed`. Each item carries title, kind, source link (from a `Source: [label](url)` line or
  the first link in a `## Sources` section), an essence blurb (`## Essence` / `## Takeaway` /
  first paragraph, capped 500 chars), and the vault-relative path. Renders as the home Recently
  Consumed tile (first 8) and the full table on `consumed.html`.
- `sync-calendar.mjs` — thin wrapper around `calendar-lib.mjs`'s `readUpcomingEvents()` (ICS export,
  `CALENDAR_ICS` env, default `~/Downloads/Personal.ics`, also accepts an http/webcal URL, + the
  bridge-events ledger; pragmatic RRULE subset) → next 30 days → `app_state` key `calendar` → the
  home Upcoming tile.
- `calendar-manager.mjs` — manual CLI (added 2026-07-20) for organizing Apple Calendar directly;
  not part of `bridge-sync.sh` — every mutation is something Jack runs deliberately, never
  automatic. `list [--days N]` and `dedupe [--days N] [--apply]` read via `readUpcomingEvents()`
  (fast). `add "<title>" <date> [time]` (dedupe-checked, `--force` to override), `edit <uid>
  [--title] [--date] [--time]`, `remove <uid>` (dry-run unless `--yes`) write via Calendar.app —
  `edit`/`remove` can take a couple of minutes each (see `calendar-lib.mjs` above). `dedupe --apply`
  deletes all but the earliest-starting event per duplicate group. Built on `calendar-lib.mjs`.
- `fetch-news.mjs` — aggregates the RSS feeds in `scripts/news-sources.json` (edit that file to
  change sources — world / AI / Man Utd / pop culture / podcasts) → `app_state` key `news` → the
  home News tile. Self-throttles to one fetch per `refresh_hours` (20); `FORCE_NEWS=1` overrides.

DB details: `goals` and `todos` both have `updated_at` + `set_updated_at()` trigger (added
2026-07-03 for conflict resolution). RLS is enabled but policies are fully public — the anon key
can read/write; tightening is a known follow-up. The app pages subscribe to Supabase Realtime, so
bridge writes appear in the open app without reloads.

## Phone-only layout edits

When asked to change the "phone"/"mobile" layout without affecting desktop:

- **Breakpoint:** under 640px (Tailwind's `sm` breakpoint) counts as phone.
- **Tailwind utility classes:** add a `max-sm:` variant instead of changing the unprefixed class, e.g. `flex` → keep `flex`, add `max-sm:flex-col`. Never remove or edit the unprefixed/`sm:`/`md:`/`lg:` classes when the goal is phone-only — those are what desktop renders.
- **Custom CSS (`<style>` blocks / `finances.css`):** wrap phone-only rules in `@media (max-width: 639px) { ... }`. Don't edit the base (non-media-queried) rule for a phone-only change.
- Applies across `index.html`, `gym.html`, `finances.html`, `goals.html`, `consumed.html`.

## Date display convention (added 2026-07-14)

Every user-visible date renders as **DD-MM-YY** (e.g. `14-07-26`) via the `fmtDMY()` helper each
page defines (`finances.js` has its own copy). Use it for any new date display. Stored/synced
values stay ISO `YYYY-MM-DD` — DB columns, frontmatter, vault filenames, `isoDate()` grid keys —
because they're parsed and sorted; convert only at render time.

## Time display convention (added 2026-07-22)

Every user-visible clock time renders as **12-hour** (e.g. `2:30pm`, or `4pm` with minutes omitted
on the hour) via `fmtTime12()` in `index.html` — the only page with clock-time displays (Mail tile
received time, Upcoming tile event time). Stored/synced values stay 24-hour `HH:MM` (`app_state`
calendar events, `m.received` ISO timestamps) because they're parsed and compared; convert only at
render time, same as `fmtDMY()`.
