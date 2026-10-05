-- Phase 5C-3 / migration 8: closing a paper trade. PAPER TRADING — SIMULATION ONLY, NO REAL MONEY.
--
-- The smallest addition that makes a close ATOMIC and auditable:
--
--   * exit-execution provenance columns on paper_trade_results (reference price, slippage/fee
--     assumptions, the exit quote's source/asOf/fetchedAt, cash credited, simulation version),
--     complete-or-absent exactly like the entry provenance added to paper_trades in migration 7.
--     Existing columns keep their meaning: exit_price = simulated exit fill, fees = the EXIT fee
--     only (the entry fee stays on paper_trades.fees), pnl = realized P&L, closed_at = close time.
--   * the result is server-owned and immutable: closed_at is stamped by the database, a result must
--     belong to its trade's owner, and no role can UPDATE a result once written.
--   * a CLOSED trade can never be reopened (by any role).
--   * close_paper_trade(): ONE function that locks the trade, re-derives the exit fill, fee and
--     realized P&L, credits the account, writes the result and flips the status in a single
--     transaction. Only service_role may execute it.
--
-- Nothing here grants a client any new privilege. Not in this migration: portfolio analytics, UI,
-- SELL/SHORT, margin or leverage.

-- ── Exit provenance on paper_trade_results ─────────────────
alter table public.paper_trade_results
  add column account_id uuid references public.paper_accounts (id),
  add column sim_version text,
  add column reference_price numeric,      -- the exit quote price BEFORE slippage
  add column slippage_bps numeric,         -- effective rate applied (adverse for a sell: price falls)
  add column fee_bps numeric,              -- effective per-side fee rate applied to the exit
  add column cash_credited numeric,        -- exit proceeds - exit fee: exactly what entered the account
  add column quote_source text,
  add column quote_as_of timestamptz,
  add column quote_fetched_at timestamptz,
  add column quote_is_mock boolean;

create index paper_trade_results_account_idx on public.paper_trade_results (account_id);

-- A simulated exit is only valid when every execution field is present, and nothing execution-shaped
-- may appear without a simulation version. Results written before this migration (none are created
-- by the application) have no execution fields and stay valid.
alter table public.paper_trade_results
  add constraint paper_trade_results_execution_complete check (
    sim_version is null or (
      account_id is not null
      and reference_price is not null
      and slippage_bps is not null
      and fee_bps is not null
      and cash_credited is not null
      and quote_source is not null
      and quote_as_of is not null
      and quote_fetched_at is not null
      and quote_is_mock is not null
    )
  ),
  add constraint paper_trade_results_execution_only_with_version check (
    sim_version is not null or (
      account_id is null and reference_price is null and slippage_bps is null
      and fee_bps is null and cash_credited is null
      and quote_source is null and quote_as_of is null and quote_fetched_at is null
      and quote_is_mock is null
    )
  ),
  add constraint paper_trade_results_execution_values check (
    sim_version is null or (
      coalesce(reference_price > 0 and reference_price <> 'NaN'::numeric and reference_price <> 'Infinity'::numeric, false)
      and coalesce(slippage_bps >= 0 and slippage_bps < 10000 and slippage_bps <> 'NaN'::numeric, false)
      and coalesce(fee_bps >= 0 and fee_bps <> 'NaN'::numeric and fee_bps <> 'Infinity'::numeric, false)
      and coalesce(cash_credited >= 0 and cash_credited <> 'NaN'::numeric and cash_credited <> 'Infinity'::numeric, false)
      and exit_price <> 'NaN'::numeric and exit_price <> 'Infinity'::numeric
      and fees >= 0 and fees <> 'NaN'::numeric and fees <> 'Infinity'::numeric
      and pnl <> 'NaN'::numeric and pnl <> 'Infinity'::numeric and pnl <> '-Infinity'::numeric
    )
  );

-- ── Server-owned, immutable results ────────────────────────
-- closed_at is stamped by the database whatever the caller supplies, so a close cannot be
-- backdated by anyone (service role included). A result must belong to the owner of its trade.
create function public.paper_trade_results_before_insert() returns trigger
language plpgsql as $$
begin
  if not exists (
    select 1 from public.paper_trades t where t.id = new.paper_trade_id and t.user_id = new.user_id
  ) then
    raise exception 'paper_trade_results: a result must belong to its trade''s owner'
      using errcode = 'restrict_violation';
  end if;
  new.closed_at := now();
  return new;
end;
$$;

create trigger paper_trade_results_before_insert before insert on public.paper_trade_results
  for each row execute function public.paper_trade_results_before_insert();

-- Once written, a result is never edited by any role. (DELETE is not blocked here: it happens only
-- through the ON DELETE CASCADE from a trade or profile, and clients hold no DELETE privilege.)
create function public.paper_trade_results_block_update() returns trigger
language plpgsql as $$
begin
  raise exception 'paper_trade_results: a result is immutable once written'
    using errcode = 'restrict_violation';
end;
$$;

create trigger paper_trade_results_block_update before update on public.paper_trade_results
  for each row execute function public.paper_trade_results_block_update();

-- A closed trade stays closed. (Migration 7's guard keeps the entry record immutable; this adds the
-- one status rule it deliberately left to the close flow.)
create function public.paper_trades_guard_status() returns trigger
language plpgsql as $$
begin
  if old.status = 'CLOSED' and new.status is distinct from 'CLOSED' then
    raise exception 'paper_trades: a closed trade cannot be reopened'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

create trigger paper_trades_guard_status before update on public.paper_trades
  for each row execute function public.paper_trades_guard_status();

-- ── The atomic close ───────────────────────────────────────
-- The caller (the server) has already validated the exit quote and computed the simulated exit.
-- This function does not trust that arithmetic: from the LOCKED trade row it re-derives the exit
-- price, the exit fee and the realized P&L and refuses any mismatch. Then, in ONE transaction:
--   1. locks the trade row, scoped to the caller-supplied owner (a concurrent or repeated close of
--      the same trade queues here and then finds it CLOSED),
--   2. rejects unless the trade is OPEN, a cash-funded long with a recorded execution,
--   3. locks the account row and credits the net proceeds,
--   4. inserts the immutable result with its provenance,
--   5. marks the trade CLOSED.
-- Any failure rolls back all of it. p_user_id is trusted because only service_role can execute this
-- function and the server passes the verified session user; the trade is still looked up by BOTH
-- id and owner, so a wrong id can never touch another user's trade.
--
-- Accounting (BUY/LONG only; no margin, leverage or short selling):
--   exit price   = round(reference * (1 - slippage), 8)      adverse for a sell: the fill is LOWER
--   gross        = round(exit price * quantity, 8)
--   exit fee     = round(gross * fee rate, 8)
--   cash credit  = gross - exit fee
--   realized P&L = cash credit - cash_debited                (cash_debited = entry notional + entry fee)
create function public.close_paper_trade(
  p_user_id uuid,
  p_trade_id uuid,
  p_exit_price numeric,
  p_fee numeric,
  p_pnl numeric,
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
  v_trade public.paper_trades%rowtype;
  v_account public.paper_accounts%rowtype;
  v_gross numeric;
  v_credit numeric;
  v_pnl numeric;
  v_balance numeric;
  v_result public.paper_trade_results%rowtype;
begin
  if p_user_id is null or p_trade_id is null then
    raise exception 'PAPER_INVALID_INPUT: user and trade are required';
  end if;
  if p_exit_price is null or p_fee is null or p_pnl is null or p_reference_price is null
     or p_slippage_bps is null or p_fee_bps is null then
    raise exception 'PAPER_INVALID_INPUT: numeric inputs are required';
  end if;
  if p_sim_version is null or length(trim(p_sim_version)) = 0
     or p_quote_source is null or length(trim(p_quote_source)) = 0
     or p_quote_as_of is null or p_quote_fetched_at is null or p_quote_is_mock is null then
    raise exception 'PAPER_INVALID_INPUT: simulation and quote provenance are required';
  end if;
  -- numeric can hold NaN and Infinity, and both pass `> 0`: reject them explicitly.
  if p_exit_price in ('NaN', 'Infinity', '-Infinity') or p_fee in ('NaN', 'Infinity', '-Infinity')
     or p_pnl in ('NaN', 'Infinity', '-Infinity') or p_reference_price in ('NaN', 'Infinity', '-Infinity')
     or p_slippage_bps in ('NaN', 'Infinity', '-Infinity') or p_fee_bps in ('NaN', 'Infinity', '-Infinity') then
    raise exception 'PAPER_INVALID_INPUT: numbers must be finite';
  end if;
  if p_exit_price <= 0 or p_reference_price <= 0 or p_fee < 0
     or p_slippage_bps < 0 or p_slippage_bps >= 10000 or p_fee_bps < 0 then
    raise exception 'PAPER_INVALID_INPUT: numbers are out of range';
  end if;

  -- Serialises concurrent and repeated closes of this trade; scoped to its owner.
  select * into v_trade from public.paper_trades
    where id = p_trade_id and user_id = p_user_id
    for update;
  if not found then
    raise exception 'PAPER_TRADE_NOT_FOUND';
  end if;
  if v_trade.status <> 'OPEN' then
    raise exception 'PAPER_TRADE_NOT_OPEN';
  end if;
  -- Only cash-funded long exposure with a recorded execution can be settled; nothing is invented
  -- for SELL/SHORT or for rows that predate execution accounting.
  if v_trade.side not in ('BUY', 'LONG')
     or v_trade.sim_version is null or v_trade.account_id is null or v_trade.cash_debited is null then
    raise exception 'PAPER_TRADE_NOT_CLOSABLE';
  end if;

  -- Re-derive the simulated exit. Adverse slippage for a sell LOWERS the price.
  if p_exit_price <> round(p_reference_price * (10000 - p_slippage_bps) / 10000, 8) then
    raise exception 'PAPER_INVALID_INPUT: exit price does not match reference price and slippage';
  end if;
  v_gross := round(p_exit_price * v_trade.quantity, 8);
  if v_gross <= 0 then
    raise exception 'PAPER_INVALID_INPUT: proceeds round to zero';
  end if;
  if p_fee <> round(v_gross * p_fee_bps / 10000, 8) then
    raise exception 'PAPER_INVALID_INPUT: fee does not match proceeds and fee rate';
  end if;
  v_credit := v_gross - p_fee;
  if v_credit < 0 then
    raise exception 'PAPER_INVALID_INPUT: fee exceeds proceeds';
  end if;
  v_pnl := v_credit - v_trade.cash_debited;
  if p_pnl <> v_pnl then
    raise exception 'PAPER_INVALID_INPUT: realized P&L does not match proceeds and cost';
  end if;

  select * into v_account from public.paper_accounts where id = v_trade.account_id for update;
  if not found then
    raise exception 'PAPER_INVALID_INPUT: the trade''s account is missing';
  end if;
  v_balance := v_account.cash_balance + v_credit;
  update public.paper_accounts set cash_balance = v_balance where id = v_account.id;

  insert into public.paper_trade_results (
    paper_trade_id, user_id, exit_price, fees, pnl,
    account_id, sim_version, reference_price, slippage_bps, fee_bps, cash_credited,
    quote_source, quote_as_of, quote_fetched_at, quote_is_mock
  ) values (
    v_trade.id, p_user_id, p_exit_price, p_fee, v_pnl,
    v_account.id, p_sim_version, p_reference_price, p_slippage_bps, p_fee_bps, v_credit,
    p_quote_source, p_quote_as_of, p_quote_fetched_at, p_quote_is_mock
  ) returning * into v_result;

  update public.paper_trades set status = 'CLOSED' where id = v_trade.id;

  return jsonb_build_object(
    'result', to_jsonb(v_result),
    'currency', v_account.currency,
    'cash_balance_after', v_balance::text,
    'cash_credited', v_credit::text,
    'pnl', v_pnl::text
  );
end;
$$;

-- Functions are executable by PUBLIC by default: revoke from every API role first.
revoke execute on function public.close_paper_trade(
  uuid, uuid, numeric, numeric, numeric, text, numeric, numeric, numeric,
  text, timestamptz, timestamptz, boolean
) from public, anon, authenticated;
grant execute on function public.close_paper_trade(
  uuid, uuid, numeric, numeric, numeric, text, numeric, numeric, numeric,
  text, timestamptz, timestamptz, boolean
) to service_role;
