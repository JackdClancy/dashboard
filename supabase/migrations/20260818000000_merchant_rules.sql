-- merchant_rules: the learned "what kind of place is this?" cache behind the
-- finances page's categorisation (added 2026-08-18).
--
-- Two kinds of key:
--   kind = 'merchant'        key = normalised merchant/description string
--   kind = 'akahu_category'  key = Akahu NZFCC category.name, e.g.
--                                  'Supermarkets and grocery stores'
--
-- source records how the rule was decided, and is what protects Jack's own
-- corrections: sync-finances.mjs never overwrites a row with source='manual'.

create table if not exists public.merchant_rules (
  key        text not null,
  kind       text not null default 'merchant'
             check (kind in ('merchant', 'akahu_category')),
  category   text not null
             check (category in ('Rent','Groceries','Transport','Entertainment',
                                 'Alcohol','Subscriptions','Food','Other')),
  source     text not null default 'ai'
             check (source in ('manual', 'rule', 'akahu', 'ai')),
  evidence   text,
  sample     text,
  updated_at timestamptz not null default now(),
  primary key (kind, key)
);

alter table public.merchant_rules enable row level security;

-- Same fully-public policy shape as the rest of the dashboard's tables.
-- (Tightening RLS across the whole project is a known follow-up.)
drop policy if exists "merchant_rules public read"   on public.merchant_rules;
drop policy if exists "merchant_rules public insert" on public.merchant_rules;
drop policy if exists "merchant_rules public update" on public.merchant_rules;
drop policy if exists "merchant_rules public delete" on public.merchant_rules;

create policy "merchant_rules public read"   on public.merchant_rules for select using (true);
create policy "merchant_rules public insert" on public.merchant_rules for insert with check (true);
create policy "merchant_rules public update" on public.merchant_rules for update using (true);
create policy "merchant_rules public delete" on public.merchant_rules for delete using (true);

-- Reuse the existing set_updated_at() trigger function if it's present
-- (added 2026-07-03 for goals/todos); skip silently if it isn't.
do $$
begin
  if exists (select 1 from pg_proc where proname = 'set_updated_at') then
    drop trigger if exists merchant_rules_set_updated_at on public.merchant_rules;
    create trigger merchant_rules_set_updated_at
      before update on public.merchant_rules
      for each row execute function public.set_updated_at();
  end if;
end $$;
