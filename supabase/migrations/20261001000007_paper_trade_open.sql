-- Phase 5C-2 / migration 7: opening a paper trade. PAPER TRADING — SIMULATION ONLY, NO REAL MONEY.
--
-- Adds the smallest foundation needed for ATOMIC simulated-cash accounting:
--
--   * paper_accounts: one row per (user, currency) holding simulated cash. INR and USDT are kept
--     apart because no cross-currency conversion is modelled. Users can only READ their own rows.
--   * execution-provenance columns on paper_trades (reference price, slippage/fee assumptions,
--     the quote's source/asOf/fetchedAt, cash debited, simulation version), all complete-or-absent.
--   * triggers that make the entry record server-owned and immutable (for every role).
--   * open_paper_trade(): ONE function that locks the account, checks cash, debits it and inserts
--     the trade in a single transaction. Only service_role may execute it.
--
-- Not in this migration (later phases): closing trades, P&L, any client write path.

-- ── Simulated cash accounts ────────────────────────────────
create table public.paper_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  currency text not null check (currency in ('INR', 'USDT')),
  starting_cash numeric not null
    check (starting_cash > 0 and starting_cash <> 'NaN'::numeric and starting_cash <> 'Infinity'::numeric),
  cash_balance numeric not null
    check (cash_balance >= 0 and cash_balance <> 'NaN'::numeric and cash_balance <> 'Infinity'::numeric),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, currency)
);

create trigger set_updated_at before update on public.paper_accounts
  for each row execute function public.set_updated_at();

-- Identity and the opening balance never change, even for the service role.
create function public.paper_accounts_guard_update() returns trigger
language plpgsql as $$
begin
  if new.user_id is distinct from old.user_id
     or new.currency is distinct from old.currency
     or new.starting_cash is distinct from old.starting_cash
     or new.id is distinct from old.id then
    raise exception 'paper_accounts: identity and starting cash are immutable'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

create trigger paper_accounts_guard_update before update on public.paper_accounts
  for each row execute function public.paper_accounts_guard_update();

-- ── Execution provenance on paper_trades ───────────────────
alter table public.paper_trades
  add column account_id uuid references public.paper_accounts (id),
  add column sim_version text,
  add column reference_price numeric,      -- the quote price BEFORE slippage
  add column slippage_bps numeric,         -- effective rate applied (adverse for a buy)
  add column fee_bps numeric,              -- effective per-side fee rate applied
  add column notional numeric,             -- entry_price * quantity, rounded to 8 dp
  add column cash_debited numeric,         -- notional + fees: exactly what left the account
  add column quote_source text,
  add column quote_as_of timestamptz,
  add column quote_fetched_at timestamptz,
  add column quote_is_mock boolean;

create index paper_trades_account_idx on public.paper_trades (account_id);

-- A simulated execution is only valid when every execution field is present, and nothing
-- execution-shaped may appear without a simulation version (no half-forged rows). Rows that
-- predate this migration have no execution fields and stay valid.
alter table public.paper_trades
  add constraint paper_trades_execution_complete check (
    sim_version is null or (
      account_id is not null
      and reference_price is not null
      and slippage_bps is not null
      and fee_bps is not null
      and notional is not null
      and cash_debited is not null
      and quote_source is not null
      and quote_as_of is not null
      and quote_fetched_at is not null
      and quote_is_mock is not null
    )
  ),
  add constraint paper_trades_execution_only_with_version check (
    sim_version is not null or (
      account_id is null and reference_price is null and slippage_bps is null
      and fee_bps is null and notional is null and cash_debited is null
      and quote_source is null and quote_as_of is null and quote_fetched_at is null
      and quote_is_mock is null
    )
  ),
  add constraint paper_trades_execution_values check (
    sim_version is null or (
      coalesce(reference_price > 0, false)
      and coalesce(slippage_bps >= 0, false)
      and coalesce(fee_bps >= 0, false)
      and coalesce(notional > 0, false)
      and coalesce(cash_debited = notional + fees, false)
    )
  );

-- The entry record is server-owned. opened_at/created_at are stamped by the database whatever the
-- caller supplies, so a trade cannot be backdated by anyone, service role included.
create function public.paper_trades_before_insert() returns trigger
language plpgsql as $$
begin
  new.opened_at := now();
  new.created_at := now();
  new.updated_at := now();
  return new;
end;
$$;

create trigger paper_trades_before_insert before insert on public.paper_trades
  for each row execute function public.paper_trades_before_insert();

-- Once written, the entry record cannot be edited by any role. Only status and the user-settable
-- stop_loss / take_profit may change (status is changed by the close flow in a later phase).
create function public.paper_trades_guard_update() returns trigger
language plpgsql as $$
begin
  if new.id is distinct from old.id
     or new.user_id is distinct from old.user_id
     or new.asset_id is distinct from old.asset_id
     or new.side is distinct from old.side
     or new.entry_price is distinct from old.entry_price
     or new.quantity is distinct from old.quantity
     or new.fees is distinct from old.fees
     or new.opened_at is distinct from old.opened_at
     or new.created_at is distinct from old.created_at
     or new.account_id is distinct from old.account_id
     or new.sim_version is distinct from old.sim_version
     or new.reference_price is distinct from old.reference_price
     or new.slippage_bps is distinct from old.slippage_bps
     or new.fee_bps is distinct from old.fee_bps
     or new.notional is distinct from old.notional
     or new.cash_debited is distinct from old.cash_debited
     or new.quote_source is distinct from old.quote_source
     or new.quote_as_of is distinct from old.quote_as_of
     or new.quote_fetched_at is distinct from old.quote_fetched_at
     or new.quote_is_mock is distinct from old.quote_is_mock then
    raise exception 'paper_trades: the entry record is immutable'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

create trigger paper_trades_guard_update before update on public.paper_trades
  for each row execute function public.paper_trades_guard_update();

-- ── Privileges + RLS for paper_accounts ────────────────────
-- Migration 4's blanket RLS loop only covered tables that existed then, so it is enabled here.
alter table public.paper_accounts enable row level security;
revoke all on public.paper_accounts from anon, authenticated;
grant select on public.paper_accounts to authenticated;
create policy paper_accounts_select on public.paper_accounts for select to authenticated
  using (user_id = auth.uid());
-- No INSERT/UPDATE/DELETE grant or policy: cash is created and moved only by open_paper_trade()
-- (and, later, by the close flow), both service-role only.

-- ── The atomic open ────────────────────────────────────────
-- The caller (the server) has already validated the quote and computed the simulated execution.
-- This function does not trust that arithmetic: it re-derives the entry price and the fee from the
-- reference price and the recorded rates and refuses any mismatch. It then, in ONE transaction:
--   1. creates the user's account for the asset's currency on first use (starting cash from the
--      server-side simulation config),
--   2. locks the account row (concurrent opens for the same user queue here, so cash cannot be
--      double-spent),
--   3. rejects when cash is insufficient,
--   4. debits the cash,
--   5. inserts the trade.
-- Any failure rolls back all of it. p_user_id is trusted because only service_role can execute
-- this function and the server passes the verified session user.
create function public.open_paper_trade(
  p_user_id uuid,
  p_asset_id uuid,
  p_side text,
  p_quantity numeric,
  p_entry_price numeric,
  p_fee numeric,
  p_starting_cash numeric,
  p_sim_version text,
  p_reference_price numeric,
  p_slippage_bps numeric,
  p_fee_bps numeric,
  p_quote_source text,
  p_quote_as_of timestamptz,
  p_quote_fetched_at timestamptz,
  p_quote_is_mock boolean
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_currency text;
  v_account public.paper_accounts%rowtype;
  v_notional numeric;
  v_cost numeric;
  v_balance numeric;
  v_trade public.paper_trades%rowtype;
begin
  -- Only long exposure funded fully from cash is modelled. SELL/SHORT would need margin and
  -- borrow accounting, which is deliberately not invented here.
  if p_side is null or p_side not in ('BUY', 'LONG') then
    raise exception 'PAPER_INVALID_INPUT: side % is not supported', p_side;
  end if;
  if p_user_id is null or p_asset_id is null then
    raise exception 'PAPER_INVALID_INPUT: user and asset are required';
  end if;
  if p_quantity is null or p_entry_price is null or p_fee is null or p_starting_cash is null
     or p_reference_price is null or p_slippage_bps is null or p_fee_bps is null then
    raise exception 'PAPER_INVALID_INPUT: numeric inputs are required';
  end if;
  -- numeric can hold NaN and Infinity, and both pass `> 0`: reject them explicitly.
  if p_quantity in ('NaN', 'Infinity', '-Infinity') or p_entry_price in ('NaN', 'Infinity', '-Infinity')
     or p_fee in ('NaN', 'Infinity', '-Infinity') or p_starting_cash in ('NaN', 'Infinity', '-Infinity')
     or p_reference_price in ('NaN', 'Infinity', '-Infinity')
     or p_slippage_bps in ('NaN', 'Infinity', '-Infinity') or p_fee_bps in ('NaN', 'Infinity', '-Infinity') then
    raise exception 'PAPER_INVALID_INPUT: numbers must be finite';
  end if;
  if p_quantity <= 0 or p_entry_price <= 0 or p_reference_price <= 0 or p_fee < 0
     or p_starting_cash <= 0 or p_slippage_bps < 0 or p_fee_bps < 0 then
    raise exception 'PAPER_INVALID_INPUT: numbers are out of range';
  end if;

  select a.currency into v_currency from public.assets a where a.id = p_asset_id and a.is_active;
  if not found then
    raise exception 'PAPER_ASSET_NOT_FOUND';
  end if;
  if not exists (select 1 from public.profiles pr where pr.id = p_user_id) then
    raise exception 'PAPER_INVALID_INPUT: unknown user';
  end if;

  -- Re-derive the simulated execution. Adverse slippage for a buy raises the price.
  if p_entry_price <> round(p_reference_price * (10000 + p_slippage_bps) / 10000, 8) then
    raise exception 'PAPER_INVALID_INPUT: entry price does not match reference price and slippage';
  end if;
  v_notional := round(p_entry_price * p_quantity, 8);
  if v_notional <= 0 then
    raise exception 'PAPER_INVALID_INPUT: notional rounds to zero';
  end if;
  if p_fee <> round(v_notional * p_fee_bps / 10000, 8) then
    raise exception 'PAPER_INVALID_INPUT: fee does not match notional and fee rate';
  end if;
  v_cost := v_notional + p_fee;

  insert into public.paper_accounts (user_id, currency, starting_cash, cash_balance)
    values (p_user_id, v_currency, p_starting_cash, p_starting_cash)
    on conflict (user_id, currency) do nothing;

  select * into v_account from public.paper_accounts
    where user_id = p_user_id and currency = v_currency
    for update;

  if v_account.cash_balance < v_cost then
    raise exception 'PAPER_INSUFFICIENT_CASH';
  end if;

  v_balance := v_account.cash_balance - v_cost;
  update public.paper_accounts set cash_balance = v_balance where id = v_account.id;

  insert into public.paper_trades (
    user_id, asset_id, side, entry_price, quantity, fees, status,
    account_id, sim_version, reference_price, slippage_bps, fee_bps, notional, cash_debited,
    quote_source, quote_as_of, quote_fetched_at, quote_is_mock
  ) values (
    p_user_id, p_asset_id, p_side::public.paper_trade_side, p_entry_price, p_quantity, p_fee, 'OPEN',
    v_account.id, p_sim_version, p_reference_price, p_slippage_bps, p_fee_bps, v_notional, v_cost,
    p_quote_source, p_quote_as_of, p_quote_fetched_at, p_quote_is_mock
  ) returning * into v_trade;

  return jsonb_build_object(
    'trade', to_jsonb(v_trade),
    'currency', v_currency,
    'cash_balance_after', v_balance::text
  );
end;
$$;

-- Functions are executable by PUBLIC by default: revoke from every API role first.
revoke execute on function public.open_paper_trade(
  uuid, uuid, text, numeric, numeric, numeric, numeric, text, numeric, numeric, numeric,
  text, timestamptz, timestamptz, boolean
) from public, anon, authenticated;
grant execute on function public.open_paper_trade(
  uuid, uuid, text, numeric, numeric, numeric, numeric, text, numeric, numeric, numeric,
  text, timestamptz, timestamptz, boolean
) to service_role;
