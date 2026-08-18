-- OPTIONAL (added 2026-08-18). The finances page works without this — it
-- re-reads on tab focus and on a 30s timer — but running this turns those
-- refreshes into instant push updates.
--
-- Two separate problems, found by probing realtime directly:
--
--   1. `merchant_rules` was never added to the supabase_realtime publication,
--      so no events at all were delivered for it. (The page's optimistic local
--      re-render made reassignment *look* live; it wasn't.)
--   2. `app_state` IS in the publication and delivers INSERTs, but not UPDATEs.
--      A budget edit rewrites the existing 'budget' row, so it never arrived.
--      That's a replica-identity issue: without a primary key, Postgres has no
--      way to identify which row an UPDATE touched and drops it from the WAL
--      stream. REPLICA IDENTITY FULL uses the whole row instead.
--
-- Verify afterwards by editing 10-finances/weekly-budget.md with the finances
-- page open — the bar should move within a second or two rather than on the
-- next refresh tick.

alter publication supabase_realtime add table public.merchant_rules;

alter table public.app_state replica identity full;
