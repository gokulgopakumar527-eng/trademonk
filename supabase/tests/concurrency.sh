#!/usr/bin/env bash
# Real multi-session tests for close_paper_trade(): row-lock serialisation of repeated/concurrent
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

create function c.open(uid uuid, qty numeric, ref numeric) returns uuid language plpgsql as \$\$
declare
  entry numeric := round(ref * 10005 / 10000, 8);
  notional numeric := round(entry * qty, 8);
  fee numeric := round(notional * 10 / 10000, 8);
begin
  return (public.open_paper_trade(uid, '$BTC', 'BUY', qty, entry, fee, 10000, 'PAPER_SIM_V1', ref, 5, 10,
    'binance-public', now(), now(), false) -> 'trade' ->> 'id')::uuid;
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

echo "Concurrency tests passed: $PASSES"
