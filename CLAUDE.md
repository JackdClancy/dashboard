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
- `sync-captures.mjs` — drains the `captures` queue (home page quick-add bar, plus the share-sheet
  entry points below). Event-like captures (parseable date + a time or appointment keyword, e.g.
  "Dentist appointment on the 7th at 4pm") are created in **Apple Calendar** (`CALENDAR_NAME`,
  default "Personal") via osascript and logged to the vault ledger
  `09-calendar/(AI) bridge-events.json`, which `sync-calendar.mjs` merges into the Upcoming tile
  (the static ICS export won't contain them until re-exported). Everything else becomes a
  `00-inbox/raw/*.md` file for the vault `compile` skill, with frontmatter `source:` set from the
  row's `source` column (default `app-quick-add`).

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
  from any email, important or not: appointments/bookings → Apple Calendar + the bridge-events
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
- `sync-calendar.mjs` — parses an Apple Calendar ICS export (`CALENDAR_ICS` env, default
  `~/Downloads/Personal.ics`; also accepts an http/webcal URL) → next 30 days →
  `app_state` key `calendar` → the home Upcoming tile. Pragmatic RRULE subset.
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
