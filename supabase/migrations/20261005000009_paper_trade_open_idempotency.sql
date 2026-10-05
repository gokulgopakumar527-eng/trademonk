-- Phase 5C-7C-A / migration 9: idempotent open. PAPER TRADING — SIMULATION ONLY, NO REAL MONEY.
--
-- Closes the one remaining replay hole in the paper-trading flow: before this migration, a repeated
-- open request (timeout retry, double click, replay, concurrent duplicate) created a second
-- position and debited cash twice. The close side was already protected by its row lock.
--
--   * paper_trades.idempotency_key: client-generated, REQUIRED by the new open function, nullable
--     in the table only so rows written before this migration stay valid (they keep NULL).
--   * a partial unique index on (user_id, idempotency_key): the database-level guarantee.
--     Same user + same key = one logical open. Different users may reuse a key independently.
--     Nothing price/symbol/quantity-shaped is unique, so deliberate separate opens still work.
--   * paper_trades.cash_balance_after: the account balance right after THIS open, so a replay can
--     return the original receipt rather than whatever the balance is later.
--   * both new columns are immutable for every role (extends migration 7's guard).
--   * open_paper_trade() gains a 16th argument and the 15-argument signature is DROPPED, so no
--     key-less call path survives. Still service_role only.
--
-- Not in this migration: application code, UI, staging tooling, documentation.

-- ── Columns, constraints, unique index ─────────────────────
alter table public.paper_trades
  add column idempotency_key text,
  add column cash_balance_after numeric;

alter table public.paper_trades
  add constraint paper_trades_idempotency_key_format check (
    idempotency_key is null
    or (char_length(idempotency_key) between 16 and 128 and idempotency_key ~ '^[A-Za-z0-9._-]+$')
  ),
  -- the key and the receipt balance are written together or not at all
  add constraint paper_trades_idempotency_receipt check (
    (idempotency_key is null) = (cash_balance_after is null)
  ),
  add constraint paper_trades_cash_balance_after_value check (
    cash_balance_after is null
    or (cash_balance_after >= 0
        and cash_balance_after <> 'NaN'::numeric
        and cash_balance_after <> 'Infinity'::numeric)
  );

create unique index paper_trades_user_idempotency_key_uidx
  on public.paper_trades (user_id, idempotency_key)
  where idempotency_key is not null;

-- ── Immutability: extend migration 7's guard with the two new columns ──
create or replace function public.paper_trades_guard_update() returns trigger
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
     or new.quote_is_mock is distinct from old.quote_is_mock
     or new.idempotency_key is distinct from old.idempotency_key
     or new.cash_balance_after is distinct from old.cash_balance_after then
    raise exception 'paper_trades: the entry record is immutable'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

-- ── Replace the open function: 15 arguments out, 16 (with the key) in ──
drop function public.open_paper_trade(
  uuid, uuid, text, numeric, numeric, numeric, numeric, text, numeric, numeric, numeric,
  text, timestamptz, timestamptz, boolean
);

-- Same business rules as migration 7 (re-derived price and fee, cash check, atomic debit + insert),
-- plus idempotency. Order inside the ONE transaction:
--   1. pure input validation (including the key's format),
--   2. resolve the asset's currency (the active check is deliberately deferred, see below),
--   3. take a transaction-scoped advisory lock on (user, key). It serialises same-key requests
--      even when they would otherwise lock different accounts (an asset in another currency),
--   4. look the key up. If it exists: verify the logical request matches, debit NOTHING, insert
--      NOTHING, and return the stored receipt with replayed = true,
--   5. otherwise run the normal open (active-asset check, account lock, cash check, debit, insert),
--      storing the key and the post-open balance in the same statement as the trade.
-- The lock order is always advisory -> account row, so it cannot deadlock. The unique index is the
-- backstop if the lock were ever bypassed. A rollback discards the key with everything else, so a
-- failed open never reserves it.
--
-- Reuse of a key is checked against asset, side and quantity only. The price is NOT compared:
-- a legitimate retry re-quotes, so its reference price and entry price may differ.
-- The returned trade object is the trade's CURRENT row (its status may since have become CLOSED);
-- the entry fields and cash_balance_after are the original, immutable values.
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
  p_quote_is_mock boolean,
  p_idempotency_key text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_currency text;
  v_active boolean;
  v_existing public.paper_trades%rowtype;
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
  if p_idempotency_key is null
     or char_length(p_idempotency_key) not between 16 and 128
     or p_idempotency_key !~ '^[A-Za-z0-9._-]+$' then
    raise exception 'PAPER_INVALID_INPUT: idempotency key is required (16-128 characters of A-Z a-z 0-9 . _ -)';
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

  -- The currency is needed to know the account. Whether the asset is still ACTIVE only matters for
  -- a NEW open, so that check comes after the replay lookup: a replay of an already-created trade
  -- still resolves after the asset is later deactivated.
  select a.currency, a.is_active into v_currency, v_active from public.assets a where a.id = p_asset_id;
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

  -- Serialise every request that carries this (user, key). Held until the transaction ends.
  perform pg_advisory_xact_lock(hashtextextended('paper_open:' || p_user_id::text || ':' || p_idempotency_key, 0));

  select * into v_existing from public.paper_trades
    where user_id = p_user_id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.asset_id is distinct from p_asset_id
       or v_existing.side is distinct from p_side::public.paper_trade_side
       or v_existing.quantity is distinct from p_quantity then
      raise exception 'PAPER_IDEMPOTENCY_KEY_REUSED: this key was already used for a different trade';
    end if;
    return jsonb_build_object(
      'trade', to_jsonb(v_existing),
      'currency', v_currency,
      'cash_balance_after', v_existing.cash_balance_after::text,
      'replayed', true
    );
  end if;

  -- A new open from here on.
  if not v_active then
    raise exception 'PAPER_ASSET_NOT_FOUND';
  end if;

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
    quote_source, quote_as_of, quote_fetched_at, quote_is_mock,
    idempotency_key, cash_balance_after
  ) values (
    p_user_id, p_asset_id, p_side::public.paper_trade_side, p_entry_price, p_quantity, p_fee, 'OPEN',
    v_account.id, p_sim_version, p_reference_price, p_slippage_bps, p_fee_bps, v_notional, v_cost,
    p_quote_source, p_quote_as_of, p_quote_fetched_at, p_quote_is_mock,
    p_idempotency_key, v_balance
  ) returning * into v_trade;

  return jsonb_build_object(
    'trade', to_jsonb(v_trade),
    'currency', v_currency,
    'cash_balance_after', v_balance::text,
    'replayed', false
  );
end;
$$;

-- Functions are executable by PUBLIC by default: revoke from every API role first.
revoke execute on function public.open_paper_trade(
  uuid, uuid, text, numeric, numeric, numeric, numeric, text, numeric, numeric, numeric,
  text, timestamptz, timestamptz, boolean, text
) from public, anon, authenticated;
grant execute on function public.open_paper_trade(
  uuid, uuid, text, numeric, numeric, numeric, numeric, text, numeric, numeric, numeric,
  text, timestamptz, timestamptz, boolean, text
) to service_role;

-- Safety net: exactly one open_paper_trade overload may exist. If a key-less signature survived
-- (for example after a manual edit), this migration fails instead of leaving a bypass.
do $$
begin
  if (select count(*) from pg_proc where proname = 'open_paper_trade' and pronamespace = 'public'::regnamespace) <> 1 then
    raise exception 'migration 9: expected exactly one open_paper_trade overload';
  end if;
end $$;
