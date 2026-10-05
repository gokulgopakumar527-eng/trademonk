#!/usr/bin/env bash
# Real multi-session tests for open_paper_trade() idempotency and close_paper_trade(): row-lock serialisation of repeated/concurrent
# closes, no deadlock between concurrent opens and closes, and rollback that survives a commit
# boundary. Run by scripts/test-db.sh against the same throwaway PostgreSQL database, after the SQL
# tests. Every session is a separate psql process, i.e. a separate connection and transaction.
#
# Usage: concurrency.sh <database>. Never point this at a real project.
set -euo pipefail
DB="${1:?usage: concurrency.sh <database>}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PASSES=0

q()    { psql -v ON_ERROR_STOP=1 -q -t -A -d "$DB" "$@"; }
pass() { PASSES=$((PASSES + 1)); echo "PASS (concurrency): $1"; }
fail() { echo "FAIL (concurrency): $1" >&2; exit 1; }
expect() { [ "$1" = "$2" ] && pass "$3" || fail "$3 (expected '$2', got '$1')"; }

BTC='dddddddd-0000-0000-0000-000000000001'
newuser() { # prints a fresh user id (the signup trigger creates the profile)
  local id; id="$(q -c "select gen_random_uuid()")"
  q -c "insert into auth.users (id, email) values ('$id', '$id@conc.test')" >/dev/null
  echo "$id"
}

# Helpers that mirror what the server computes. Executed by sessions acting as service_role.
q >/dev/null <<SQL
create schema c;
grant usage on schema c to public;
insert into public.assets (id, market, symbol, name, asset_type, currency)
  values ('$BTC', 'CRYPTO', 'BTC', 'Bitcoin', 'CRYPTO', 'USDT') on conflict do nothing;

create function c.open(uid uuid, qty numeric, ref numeric, ikey text default null) returns uuid language plpgsql as \$\$
declare
  entry numeric := round(ref * 10005 / 10000, 8);
  notional numeric := round(entry * qty, 8);
  fee numeric := round(notional * 10 / 10000, 8);
begin
  return (public.open_paper_trade(uid, '$BTC', 'BUY', qty, entry, fee, 10000, 'PAPER_SIM_V1', ref, 5, 10,
    'binance-public', now(), now(), false, coalesce(ikey, 'conc-key-' || gen_random_uuid()::text)) -> 'trade' ->> 'id')::uuid;
end \$\$;

create function c.close(uid uuid, tid uuid, ref numeric) returns text language plpgsql as \$\$
declare
  tr public.paper_trades%rowtype;
  exit_p numeric := round(ref * 9995 / 10000, 8);
  gross numeric; fee numeric; pnl numeric;
begin
  select * into tr from public.paper_trades where id = tid;
  gross := round(exit_p * tr.quantity, 8);
  fee := round(gross * 10 / 10000, 8);
  pnl := gross - fee - tr.cash_debited;
  return 'OK ' || (public.close_paper_trade(uid, tid, exit_p, fee, pnl, 'PAPER_SIM_V1', ref, 5, 10,
    'binance-public', now(), now(), false) ->> 'pnl');
end \$\$;

create function c.boom() returns trigger language plpgsql as \$\$
begin raise exception 'BOOM: injected failure'; end \$\$;
SQL

as_service() { psql -v ON_ERROR_STOP=1 -q -t -A -d "$DB" -c "set role service_role" "$@"; }
balance() { q -c "select cash_balance from public.paper_accounts where user_id = '$1' and currency = 'USDT'"; }
results() { q -c "select count(*) from public.paper_trade_results where paper_trade_id = '$1'"; }
status()  { q -c "select status from public.paper_trades where id = '$1'"; }
ledger_ok() { # balance == starting cash + sum(P&L) - cost of open trades, for user $1
  q -c "select (a.starting_cash
        + coalesce((select sum(x.pnl) from public.paper_trade_results x where x.account_id = a.id), 0)
        - coalesce((select sum(p.cash_debited) from public.paper_trades p where p.account_id = a.id and p.status = 'OPEN'), 0))
        = a.cash_balance from public.paper_accounts a where a.user_id = '$1' and a.currency = 'USDT'"
}

# ── A. Deterministic lock proof: a second close WAITS for the first, then finds the trade CLOSED ──
U="$(newuser)"; T="$(q -c "set role service_role; select c.open('$U', 2, 100)" | tail -1)"
expect "$(status "$T")" "OPEN" "lock: fixture trade is OPEN"
psql -v ON_ERROR_STOP=1 -q -t -A -d "$DB" >"$TMP/a.out" 2>&1 <<SQL &
set role service_role;
begin;
select c.close('$U', '$T', 110);
select pg_sleep(3);
commit;
SQL
PID_A=$!
sleep 1   # A now holds the trade's row lock inside its open transaction
START=$(date +%s%N)
as_service -c "select c.close('$U', '$T', 110)" >"$TMP/b.out" 2>&1 || true
END=$(date +%s%N)
wait "$PID_A"
ELAPSED_MS=$(( (END - START) / 1000000 ))
grep -q '^OK 19.37001' "$TMP/a.out" && pass "lock: the first close settled (P&L 19.37001)" || fail "lock: first close did not settle: $(cat "$TMP/a.out")"
grep -q 'PAPER_TRADE_NOT_OPEN' "$TMP/b.out" && pass "lock: the second close was refused as already closed" || fail "lock: second close outcome: $(cat "$TMP/b.out")"
[ "$ELAPSED_MS" -ge 1200 ] && pass "lock: the second close was BLOCKED on the row lock (${ELAPSED_MS} ms), not racing past it" || fail "lock: second close returned after only ${ELAPSED_MS} ms: it did not wait for the lock"
expect "$(results "$T")" "1" "lock: exactly one result row"
expect "$(status "$T")" "CLOSED" "lock: the trade is CLOSED"
expect "$(ledger_ok "$U")" "t" "lock: the account was credited exactly once (ledger identity holds)"
expect "$(q -c "select cash_balance = 10000 - 200.3001 + 219.67011 from public.paper_accounts where user_id = '$U' and currency = 'USDT'")" "t" "lock: balance is exactly start - cost + one credit"

# ── B. Burst: 12 simultaneous closes of ONE trade => exactly one winner ──
U="$(newuser)"; T="$(q -c "set role service_role; select c.open('$U', 2, 100)" | tail -1)"
for i in $(seq 1 12); do as_service -c "select c.close('$U', '$T', 110)" >"$TMP/burst.$i" 2>&1 & done
wait
expect "$(cat "$TMP"/burst.* | grep -c '^OK')" "1" "burst: exactly one of 12 simultaneous closes succeeded"
expect "$(cat "$TMP"/burst.* | grep -c 'PAPER_TRADE_NOT_OPEN')" "11" "burst: the other 11 were refused as already closed"
expect "$(cat "$TMP"/burst.* | grep -ciE 'deadlock|duplicate key|could not serialize')" "0" "burst: no deadlock, unique-violation or serialisation error leaked out"
expect "$(results "$T")" "1" "burst: exactly one result row"
expect "$(ledger_ok "$U")" "t" "burst: credited exactly once"
rm -f "$TMP"/burst.*

# ── C. Mixed burst, one user: concurrent closes of different trades + concurrent opens + duplicate closes ──
U="$(newuser)"
TR=(); for i in 1 2 3 4 5 6; do TR+=("$(q -c "set role service_role; select c.open('$U', 1, 100)" | tail -1)"); done
for t in "${TR[@]}"; do
  as_service -c "select c.close('$U', '$t', 105)" >"$TMP/m.close.$t.1" 2>&1 &
  as_service -c "select c.close('$U', '$t', 105)" >"$TMP/m.close.$t.2" 2>&1 &   # a duplicate of the same close
done
for i in 1 2 3 4 5 6; do as_service -c "select c.open('$U', 1, 100)" >"$TMP/m.open.$i" 2>&1 & done
wait
expect "$(cat "$TMP"/m.* | grep -ciE 'deadlock')" "0" "mixed: no deadlock between concurrent opens and closes on one account"
for t in "${TR[@]}"; do
  expect "$(cat "$TMP/m.close.$t".* | grep -c '^OK')" "1" "mixed: trade ${t:0:8} settled exactly once despite a duplicate"
  expect "$(results "$t")" "1" "mixed: trade ${t:0:8} has one result"
done
expect "$(cat "$TMP"/m.open.* | grep -c -v '^$')" "6" "mixed: all 6 concurrent opens completed"
expect "$(cat "$TMP"/m.open.* | grep -ciE 'error|PAPER_')" "0" "mixed: no concurrent open failed"
expect "$(ledger_ok "$U")" "t" "mixed: the account ledger balances exactly after the burst"
expect "$(q -c "select cash_balance >= 0 from public.paper_accounts where user_id = '$U' and currency = 'USDT'")" "t" "mixed: cash never went negative"
rm -f "$TMP"/m.*

# ── D. Rollback survives a commit boundary: a failed close in its OWN transaction leaves nothing behind ──
U="$(newuser)"; T="$(q -c "set role service_role; select c.open('$U', 2, 100)" | tail -1)"
BEFORE="$(balance "$U")"
q -c "create trigger zz_boom before insert on public.paper_trade_results for each row execute function c.boom()" >/dev/null
as_service -c "select c.close('$U', '$T', 110)" >"$TMP/d.out" 2>&1 || true
grep -q 'BOOM' "$TMP/d.out" && pass "rollback: the injected failure (after the credit) aborted the close" || fail "rollback: expected the injected failure, got: $(cat "$TMP/d.out")"
# a brand-new session, after the failed transaction ended:
expect "$(q -c "select cash_balance = $BEFORE from public.paper_accounts where user_id = '$U' and currency = 'USDT'")" "t" "rollback: balance unchanged as seen from a NEW session"
expect "$(status "$T")" "OPEN" "rollback: trade still OPEN as seen from a NEW session"
expect "$(results "$T")" "0" "rollback: no result row survived"
q -c "drop trigger zz_boom on public.paper_trade_results" >/dev/null
as_service -c "select c.close('$U', '$T', 110)" >"$TMP/d2.out" 2>&1 || true
grep -q '^OK 19.37001' "$TMP/d2.out" && pass "rollback: once the fault clears, the same trade settles" || fail "rollback: retry failed: $(cat "$TMP/d2.out")"
expect "$(ledger_ok "$U")" "t" "rollback: the retry credited exactly once"

# ══ Phase 5C-7C-A: open-trade idempotency under REAL concurrency (separate psql sessions) ══
REL='dddddddd-0000-0000-0000-000000000002'
q >/dev/null <<'SQL'
insert into public.assets (id, market, symbol, name, asset_type, currency)
  values ('dddddddd-0000-0000-0000-000000000002', 'NSE', 'RELIANCE', 'Reliance Industries', 'EQUITY', 'INR') on conflict do nothing;

-- Like c.open, but with an explicit asset and key, returning 'OK <trade id> <replayed>'.
create function c.open_key(uid uuid, asset uuid, qty numeric, ref numeric, ikey text) returns text language plpgsql as $$
declare
  entry numeric := round(ref * 10005 / 10000, 8);
  notional numeric := round(entry * qty, 8);
  fee numeric := round(notional * 10 / 10000, 8);
  r jsonb;
begin
  r := public.open_paper_trade(uid, asset, 'BUY', qty, entry, fee, 10000, 'PAPER_SIM_V1', ref, 5, 10,
    'binance-public', now(), now(), false, ikey);
  return 'OK ' || (r -> 'trade' ->> 'id') || ' ' || (r ->> 'replayed');
end $$;
SQL
bal_is() { q -c "select cash_balance = $2 from public.paper_accounts where user_id = '$1' and currency = 'USDT'"; }
tcount() { q -c "select count(*) from public.paper_trades where user_id = '$1' and idempotency_key = '$2'"; }
tall()   { q -c "select count(*) from public.paper_trades where user_id = '$1'"; }

# ── E. Deterministic lock proof: a second same-key open WAITS for the first, then returns its receipt ──
U="$(newuser)"; K="conc-lock-key-$(date +%s%N)"
psql -v ON_ERROR_STOP=1 -q -t -A -d "$DB" >"$TMP/ea.out" 2>&1 <<SQL &
set role service_role;
begin;
select c.open_key('$U', '$BTC', 2, 100, '$K');
select pg_sleep(3);
commit;
SQL
PID_A=$!
sleep 1   # A now holds the key's lock inside its open transaction
START=$(date +%s%N)
as_service -c "select c.open_key('$U', '$BTC', 2, 100, '$K')" >"$TMP/eb.out" 2>&1 || true
END=$(date +%s%N)
wait "$PID_A"
ELAPSED_MS=$(( (END - START) / 1000000 ))
grep -q '^OK .* false$' "$TMP/ea.out" && pass "idem lock: the first open created the trade (replayed=false)" || fail "idem lock: first open outcome: $(cat "$TMP/ea.out")"
grep -q '^OK .* true$' "$TMP/eb.out" && pass "idem lock: the second same-key open returned the stored receipt (replayed=true)" || fail "idem lock: second open outcome: $(cat "$TMP/eb.out")"
[ "$(awk '/^OK/{print $2}' "$TMP/ea.out")" = "$(awk '/^OK/{print $2}' "$TMP/eb.out")" ] && pass "idem lock: both resolved to the SAME trade id" || fail "idem lock: trade ids differ"
[ "$ELAPSED_MS" -ge 1200 ] && pass "idem lock: the second open was BLOCKED on the key lock (${ELAPSED_MS} ms), not racing past it" || fail "idem lock: second open returned after only ${ELAPSED_MS} ms: it did not wait"
expect "$(tcount "$U" "$K")" "1" "idem lock: exactly one trade for the key"
expect "$(bal_is "$U" 9799.6999)" "t" "idem lock: cash debited exactly once (10000 - 200.3001)"
expect "$(ledger_ok "$U")" "t" "idem lock: ledger identity holds"

# ── F. Burst: 12 simultaneous opens with ONE key => one trade, one debit, one fee, one trade id ──
U="$(newuser)"; K="conc-burst-key-$(date +%s%N)"
for i in $(seq 1 12); do as_service -c "select c.open_key('$U', '$BTC', 2, 100, '$K')" >"$TMP/f.$i" 2>&1 & done
wait
expect "$(cat "$TMP"/f.* | grep -c '^OK')" "12" "idem burst: all 12 simultaneous same-key opens succeeded"
expect "$(cat "$TMP"/f.* | grep -c '^OK .* false$')" "1" "idem burst: exactly ONE of them created the trade"
expect "$(cat "$TMP"/f.* | grep -c '^OK .* true$')" "11" "idem burst: the other 11 were replays"
expect "$(cat "$TMP"/f.* | awk '/^OK/{print $2}' | sort -u | wc -l | tr -d ' ')" "1" "idem burst: every response points at the SAME trade id"
expect "$(cat "$TMP"/f.* | grep -ciE 'deadlock|duplicate key|could not serialize|ERROR')" "0" "idem burst: no deadlock, unique-violation or serialisation error leaked out"
expect "$(tcount "$U" "$K")" "1" "idem burst: exactly one trade row for the key"
expect "$(q -c "select sum(fees) = 0.2001 from public.paper_trades where user_id = '$U'")" "t" "idem burst: the fee was charged exactly once"
expect "$(bal_is "$U" 9799.6999)" "t" "idem burst: cash debited exactly once"
expect "$(ledger_ok "$U")" "t" "idem burst: ledger identity holds"
rm -f "$TMP"/f.*

# ── G. Same key, two ASSETS in two CURRENCIES (two different account locks), all at once ──
U="$(newuser)"; K="conc-xcur-key-$(date +%s%N)"
for i in $(seq 1 6); do as_service -c "select c.open_key('$U', '$BTC', 2, 100, '$K')" >"$TMP/g.btc.$i" 2>&1 & done
for i in $(seq 1 6); do as_service -c "select c.open_key('$U', '$REL', 2, 100, '$K')" >"$TMP/g.rel.$i" 2>&1 & done
wait
expect "$(tcount "$U" "$K")" "1" "idem cross-currency: exactly one trade for the key, whichever asset won"
expect "$(tall "$U")" "1" "idem cross-currency: no second position was created through the other account"
expect "$(cat "$TMP"/g.* | grep -ciE 'deadlock|duplicate key|could not serialize')" "0" "idem cross-currency: no deadlock or unique-violation leaked out"
expect "$(cat "$TMP"/g.* | grep '^ERROR' | grep -vc 'PAPER_IDEMPOTENCY_KEY_REUSED')" "0" "idem cross-currency: every loser failed with PAPER_IDEMPOTENCY_KEY_REUSED"
expect "$(( $(cat "$TMP"/g.* | grep -c '^OK') + $(cat "$TMP"/g.* | grep -c '^ERROR.*PAPER_IDEMPOTENCY_KEY_REUSED') ))" "12" "idem cross-currency: all 12 requests were accounted for (6 same-asset replays/creates + 6 refused)"
expect "$(cat "$TMP"/g.* | awk '/^OK/{print $2}' | sort -u | wc -l | tr -d ' ')" "1" "idem cross-currency: every success points at the same trade"
rm -f "$TMP"/g.*

# ── H. Different keys, identical parameters, all at once: all are separate intentional opens ──
U="$(newuser)"
for i in $(seq 1 8); do as_service -c "select c.open_key('$U', '$BTC', 1, 100, 'conc-diff-key-$i-$(date +%s%N)')" >"$TMP/h.$i" 2>&1 & done
wait
expect "$(cat "$TMP"/h.* | grep -c '^OK .* false$')" "8" "idem different keys: 8 different keys created 8 separate trades"
expect "$(tall "$U")" "8" "idem different keys: 8 trade rows"
expect "$(cat "$TMP"/h.* | grep -ciE 'deadlock|duplicate key|could not serialize|ERROR')" "0" "idem different keys: no error under contention"
expect "$(bal_is "$U" "(10000 - 8 * 100.15005)")" "t" "idem different keys: cash debited exactly 8 times"
expect "$(ledger_ok "$U")" "t" "idem different keys: ledger identity holds"
rm -f "$TMP"/h.*

# ── I. The same key for two users, concurrently: two independent operations ──
UA="$(newuser)"; UB="$(newuser)"; K="conc-users-key-$(date +%s%N)"
for i in $(seq 1 6); do
  as_service -c "select c.open_key('$UA', '$BTC', 2, 100, '$K')" >"$TMP/i.a.$i" 2>&1 &
  as_service -c "select c.open_key('$UB', '$BTC', 2, 100, '$K')" >"$TMP/i.b.$i" 2>&1 &
done
wait
expect "$(tcount "$UA" "$K")" "1" "idem users: user A has exactly one trade for the shared key"
expect "$(tcount "$UB" "$K")" "1" "idem users: user B has exactly one trade for the shared key"
expect "$(cat "$TMP"/i.a.* "$TMP"/i.b.* | awk '/^OK/{print $2}' | sort -u | wc -l | tr -d ' ')" "2" "idem users: two distinct trades in total, one per user"
expect "$(cat "$TMP"/i.a.* "$TMP"/i.b.* | grep -ciE 'deadlock|duplicate key|could not serialize|ERROR')" "0" "idem users: no cross-user interference or error"
expect "$(bal_is "$UA" 9799.6999)" "t" "idem users: A debited once"
expect "$(bal_is "$UB" 9799.6999)" "t" "idem users: B debited once"
rm -f "$TMP"/i.*

# ── J. Replays racing a close of the same trade: no deadlock, no double effect ──
U="$(newuser)"; K="conc-close-key-$(date +%s%N)"
T="$(as_service -c "select c.open_key('$U', '$BTC', 2, 100, '$K')" | awk '/^OK/{print $2}')"
for i in $(seq 1 6); do as_service -c "select c.open_key('$U', '$BTC', 2, 100, '$K')" >"$TMP/j.open.$i" 2>&1 & done
for i in 1 2 3; do as_service -c "select c.close('$U', '$T', 110)" >"$TMP/j.close.$i" 2>&1 & done
wait
expect "$(cat "$TMP"/j.* | grep -ciE 'deadlock|duplicate key|could not serialize')" "0" "idem+close: no deadlock between replayed opens and closes"
expect "$(cat "$TMP"/j.open.* | grep -c '^OK .* true$')" "6" "idem+close: all 6 racing opens resolved as replays"
expect "$(cat "$TMP"/j.close.* | grep -c '^OK')" "1" "idem+close: exactly one of 3 simultaneous closes settled"
expect "$(tall "$U")" "1" "idem+close: still exactly one trade"
expect "$(ledger_ok "$U")" "t" "idem+close: ledger identity holds"
rm -f "$TMP"/j.*

# ── K. Rollback survives a commit boundary: a failed open (after its debit + insert) does not poison the key ──
U="$(newuser)"; K="conc-boom-key-$(date +%s%N)"
as_service -c "select c.open_key('$U', '$BTC', 1, 100, 'conc-warmup-key-$(date +%s%N)')" >/dev/null
BEFORE="$(balance "$U")"; NBEFORE="$(tall "$U")"
q -c "create trigger zz_boom_open before insert on public.paper_trades for each row execute function c.boom()" >/dev/null
as_service -c "select c.open_key('$U', '$BTC', 2, 100, '$K')" >"$TMP/k.out" 2>&1 || true
grep -q 'BOOM' "$TMP/k.out" && pass "idem rollback: the injected failure (after the debit) aborted the open" || fail "idem rollback: expected the injected failure, got: $(cat "$TMP/k.out")"
expect "$(q -c "select cash_balance = $BEFORE from public.paper_accounts where user_id = '$U' and currency = 'USDT'")" "t" "idem rollback: balance unchanged as seen from a NEW session"
expect "$(tcount "$U" "$K")" "0" "idem rollback: no trade and no key survived"
expect "$(tall "$U")" "$NBEFORE" "idem rollback: trade count unchanged"
q -c "drop trigger zz_boom_open on public.paper_trades" >/dev/null
as_service -c "select c.open_key('$U', '$BTC', 2, 100, '$K')" >"$TMP/k2.out" 2>&1 || true
grep -q '^OK .* false$' "$TMP/k2.out" && pass "idem rollback: once the fault clears, the SAME key creates the trade" || fail "idem rollback: retry failed: $(cat "$TMP/k2.out")"
expect "$(tcount "$U" "$K")" "1" "idem rollback: exactly one trade after the retry"
expect "$(ledger_ok "$U")" "t" "idem rollback: the retry debited exactly once"

echo "Concurrency tests passed: $PASSES"
