# Jack's Dashboard

Static multi-page site (no build step, no framework) deployed via Vercel. Pages: `index.html`, `gym.html`, `finances.html`, `goals.html`. Styling is Tailwind via CDN (`tailwind.config` inline) plus a `<style>` block of custom CSS per page; `finances.html` additionally links `finances.css`.

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
  rows without a pointer file are deleted.
- `snapshot-fitness.mjs` / `snapshot-finances.mjs` — one-way app → vault markdown snapshots
  (Hevy → `07-body/7.2-gym/log/`, Akahu → `10-finances/data/`). Skip silently until
  `HEVY_API_KEY` / `AKAHU_APP_ID` + `AKAHU_USER_TOKEN` are added to `.env`.

DB details: `goals` and `todos` both have `updated_at` + `set_updated_at()` trigger (added
2026-07-03 for conflict resolution). RLS is enabled but policies are fully public — the anon key
can read/write; tightening is a known follow-up. The app pages subscribe to Supabase Realtime, so
bridge writes appear in the open app without reloads.

## Phone-only layout edits

When asked to change the "phone"/"mobile" layout without affecting desktop:

- **Breakpoint:** under 640px (Tailwind's `sm` breakpoint) counts as phone.
- **Tailwind utility classes:** add a `max-sm:` variant instead of changing the unprefixed class, e.g. `flex` → keep `flex`, add `max-sm:flex-col`. Never remove or edit the unprefixed/`sm:`/`md:`/`lg:` classes when the goal is phone-only — those are what desktop renders.
- **Custom CSS (`<style>` blocks / `finances.css`):** wrap phone-only rules in `@media (max-width: 639px) { ... }`. Don't edit the base (non-media-queried) rule for a phone-only change.
- Applies across `index.html`, `gym.html`, `finances.html`, `goals.html`.
