# Paper-trading staging smoke test (Phase 5C-7B, extended for idempotency in Phase 5C-7C-C)

PAPER TRADING — NO REAL MONEY. Simulation only. This procedure never places a real order.

## Status — read this first

| Layer                                                                                                    | Status                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit/contract tests with a faked client (`pnpm test`)                                                    | Local only. **Not** Supabase verification.                                                                                                                                                                                                                                                                                                                               |
| `pnpm test:db` (plain PostgreSQL + a hand-written Supabase stub)                                         | Local only. **Not** Supabase or PostgREST verification.                                                                                                                                                                                                                                                                                                                  |
| One-off local PostgREST probe (Phase 5C-7B, PostgREST 12.2.3 over plain PostgreSQL 16)                   | Local only. Exercised the real `SupabasePaperTradingStore` request/response shapes. **Not** Supabase verification.                                                                                                                                                                                                                                                       |
| `pnpm smoke:staging` against a real Supabase **staging** project (project `uvxbxxmttjbalhksngir`)        | **Run 2026-10-05, run id `smoke-20261005053122-e38fd6`: 20 passed, 0 failed, 0 blocked** (P1–P3, W0, C1–C15, X1), reported by the operator from their own terminal. Scope: the store, RPCs, grants, RLS and immutability using fixed test quotes (`isMock=true`) and `--quantity 0.05`. Not covered: server actions, the UI, live market-data quotes, Vercel deployment. |
| `pnpm test:db` with migration 9 (Phase 5C-7C-A: 9 migrations on local PostgreSQL 16 + the Supabase stub) | Local only. Run for 5C-7C-C: 476 SQL assertions and 81 concurrency assertions passed. **Not** Supabase or PostgREST verification.                                                                                                                                                                                                                                        |
| `pnpm smoke:staging` **with the idempotency checks** (Phase 5C-7C-C: G0, P1–P4, W0, C1–C15, I0–I9, X1)   | **NOT RUN against staging yet.** The code, the helper logic and the script's safety properties are covered by offline tests only (`tests/staging-smoke-idempotency.test.ts`). Record the real result here after the operator runs it from their authorized machine. The 20/20 run above predates migration 9 and does not validate it.                                   |

## Prerequisites (all must exist before the live run)

1. A **dedicated Supabase staging project** with migrations 1–9 applied (`supabase db push` against staging only; confirm the CLI is linked to the staging ref first) and assets seeded, including `CRYPTO:BTC` and `CRYPTO:ETH`:
   `pnpm seed:assets --project-ref <staging-ref>`. Migration 9 (`20261005000009_paper_trade_open_idempotency.sql`) must be applied BEFORE the script is run: it removes the key-less `open_paper_trade`, so an older database fails P2–P4 by design. The read-only preflight below proves it is applied.
2. The staging project's URL, anon key and service-role key, supplied through your shell or secret manager, or a git-ignored `.env.staging.local`.
   Never paste them into chat, tickets, logs, scripts or the repo.
3. The refs of **both** projects, declared so the script can prove it is not pointed at production.

| Variable                          | Value                                                   |
| --------------------------------- | ------------------------------------------------------- |
| `APP_ENV`                         | exactly `staging`                                       |
| `NEXT_PUBLIC_APP_URL`             | any valid URL (the staging URL is fine)                 |
| `NEXT_PUBLIC_SUPABASE_URL`        | `https://<staging-ref>.supabase.co`                     |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY`   | staging anon / publishable key                          |
| `SUPABASE_SERVICE_ROLE_KEY`       | staging service-role / secret key (server-side only)    |
| `STAGING_SUPABASE_PROJECT_REF`    | `<staging-ref>`                                         |
| `PRODUCTION_SUPABASE_PROJECT_REF` | `<production-ref>` (declared only so it can be refused) |
| `SMOKE_TEST_EMAIL_DOMAIN`         | optional, default `example.com`                         |

## Running it

```bash
# 1. Read-only preflight (no writes of any kind)
pnpm smoke:staging --project-ref <staging-ref>

# 2. Full write run: creates 2 disposable users and 9 simulated paper trades in STAGING (plus audit rows)
pnpm smoke:staging --project-ref <staging-ref> --confirm-writes WRITE-TO-STAGING:<staging-ref>
```

Optional: `--market`, `--symbol` (default `CRYPTO` / `BTC`), `--quantity`, `--entry-price`, `--exit-price` (exact decimals, ≤ 8 dp),
`--artifacts-dir`. These tune the C-series only; the I-series always uses `CRYPTO:BTC` / `CRYPTO:ETH` with fixed test prices.
Exit codes: `0` no check failed, `1` a check failed, `2` refused / prerequisites missing. A `BLOCKED` check did not run to a verdict:
it does not fail the exit code, but the phase is **not validated** until nothing is blocked.

Output is one line per check, `[PASS]`, `[FAIL]` or `[BLOCKED]` followed by the id and name, then a footer:

```text
Passed: X
Failed: Y
Blocked: Z
```

A check that did not execute is never printed as `[PASS]`. A network or Supabase error is a `[FAIL]`, not a pass.

On Windows (PowerShell) the simplest route is a git-ignored `.env.staging.local` in the repo root, which the package script loads
automatically; otherwise set variables with `$env:NAME = "..."` for the session. Never paste values into chat or commit them.

## What stops it

It refuses (exit 2, nothing read or written) unless **all** of these hold: `APP_ENV` is exactly `staging`; `VERCEL_ENV` is not
`production`; the URL is `https://<ref>.supabase.co` (self-hosted and local URLs are refused); the URL ref equals
`STAGING_SUPABASE_PROJECT_REF` and `--project-ref`; `PRODUCTION_SUPABASE_PROJECT_REF` is declared and different; JWT-shaped
keys carry the matching project `ref` and the right role; and, for writes, `--confirm-writes` equals `WRITE-TO-STAGING:<ref>`.
Supabase projects do not describe their own environment, so "staging" is an operator declaration that must be consistent
everywhere; the script cannot detect a staging project that is really production under a different ref.
Messages name variables and refs only — never key values.

## Checks

Guard (both modes): G0 declared staging project, never production (the guard itself runs before anything else and refuses with exit 2).

Preflight (both modes): P1 asset present · P2 `::text` casts readable on all three tables, including `idempotency_key` and
`cash_balance_after` (so **migration 9 is applied**) · P3 the 16-argument `open_paper_trade` and `close_paper_trade` exist for
`service_role` (probe is rejected before any write) · P4 the key-less 15-argument `open_paper_trade` is gone (PostgREST reports an
unknown function; a business error from it would mean a bypass overload survived). If P4 fails right after pushing the migration with a
schema-cache message, reload the PostgREST schema cache and re-run.

Write run (numbers in brackets are the Phase 5C-7B brief's list): W0 users + sign-in · C1 [4] empty snapshot · C2 [5,1,2] open ·
C3 [1] stored decimals exact · C4 [4] snapshot after open · C5 [3] owner-scoped trade lookup · C6 [9] cross-user reads via store and
RLS (with a positive control) · C7 [9] other user cannot close · C8 [10] anon/authenticated cannot call the RPCs · C9 [10] no direct
table writes · C10 [6,7] close · C11 [7] final status/fees/exit/P&L/balance · C12 [4] snapshot + history read-back · C13 [8] second
close refused · C14 [8] two concurrent closes settle once (its second open uses a NEW key) · C15 immutability even for `service_role` ·
I0–I9 idempotency lifecycle (below) · X1 disable test users.

Phase 5C-7C-C also tightened existing checks: C2 asserts `replayed=false`; C3 asserts the stored `idempotency_key` and
`cash_balance_after`; C8 calls the 16-argument RPC with a FRESH key (a privilege hole would really create a trade) and then asserts
no trade carries it.

Idempotency lifecycle checks (user A; user B for the scope check). They drive the REAL paper-trading service, store and
`open_paper_trade()`; only the quote source is a stub (fixed test prices, `isMock=true`), and the audit writer is the real one. Every
check reads the before/after state from the database itself.

| Id      | What it proves                                                                                                                                                                                                                  |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I0      | BTC and ETH are active USDT assets and user A can fund the run (otherwise **BLOCKED**, not failed).                                                                                                                             |
| I1      | First open: `replayed=false`, exactly one new trade, balance debited once by the exact cost, `idempotency_key` and `cash_balance_after` stored, one audit row.                                                                  |
| I2      | Same-key replay, re-quoted at a different price: `replayed=true`, same trade id, the ORIGINAL receipt (price, cost, balance, time), no second trade, debit or audit row.                                                        |
| I3a/b/c | Same key with a different asset (ETH) / side (BUY→LONG) / quantity: rejected as `IDEMPOTENCY_KEY_REUSED` (application code `VALIDATION`), message free of database text, no trade, no debit, original trade still owns the key. |
| I4      | New key = new intent: a different trade, debited once; the first key still belongs to the first trade.                                                                                                                          |
| I5      | Concurrent duplicates (2 simultaneous requests, 3 rounds, distinct keys): exactly one original plus one replay, one trade, one debit, one audit row.                                                                            |
| I6      | Failure safety: an oversized open is refused (insufficient paper cash) leaving no key, trade, debit or audit row; the same key then opens normally with `replayed=false`.                                                       |
| I7      | Key scope is per user: user B reuses user A's key and gets a separate trade and debit; A is untouched; two users hold the key.                                                                                                  |
| I8a     | RLS: each user reads only their own keyed trades (with a positive control).                                                                                                                                                     |
| I8b     | `authenticated` and `anon` cannot insert `paper_trades` or write `idempotency_key` / `cash_balance_after`.                                                                                                                      |
| I8c     | `service_role` cannot change `idempotency_key` or `cash_balance_after` either (immutability trigger).                                                                                                                           |
| I9      | Replay after the trade is closed (store level): the original receipt balance is returned, nothing new is created.                                                                                                               |

Amounts are compared as exact decimals (so `10000` equals `10000.00000000`). Test quotes are fixed values labelled
`staging-smoke:<runId>` with `isMock=true`; no market data is used. The script passes `allowMockData` to the service only after the
guard and the dry-run exit, so it can never apply to a read-only run.

## Artifacts and cleanup

Every run writes `smoke-artifacts/<runId>.json` (git-ignored; user ids, trade ids, result ids, check outcomes; **no secrets or
passwords**). A full write run also leaves `paper_trade.opened` rows in `audit_logs` (append-only) for the test users' trades. Test users are emailed-as `trademonk-smoke-<runId>-a|b@<domain>`.

Cleanup is deliberately minimal: the **only** action is disabling (banning) the two users this run created, after confirming the
email prefix and `smoke_run` metadata. Trades, results and accounts are immutable financial records and are **not** deleted, and no
constraint is relaxed. Deleting a test user would cascade-delete its records, so it is not done. If staging must be reset, reset
the whole staging project deliberately — never production.

## Reading a failure

A FAIL with `permission denied` on an expected operation means a grant/migration problem in staging; a FAIL on C8/C9 means a client
privilege boundary is open and must be fixed before anything else. Paste the check ids and messages (not keys) when reporting.
Do not weaken a check to get a pass.

## Open-trade idempotency (Phases 5C-7C-A, -B and -C)

**7C-A, database** (`20261005000009_paper_trade_open_idempotency.sql`). `paper_trades` gains `idempotency_key` (16–128 chars of
`A-Za-z0-9._-`) and `cash_balance_after`, written together or not at all, both immutable for every role. A partial unique index on
`(user_id, idempotency_key)` is the database-level guarantee. `open_paper_trade` gains a 16th argument and the 15-argument signature is
dropped, so no key-less path exists. It takes a transaction-scoped advisory lock on (user, key), looks the key up, and either replays
the stored receipt or runs the normal open. Execution is `service_role` only.

**7C-B, application.** The key is required by a strict input schema. The store maps `PAPER_IDEMPOTENCY_KEY_REUSED` to
`IDEMPOTENCY_KEY_REUSED`; the service returns the STORED receipt on a replay and writes no second audit entry. The UI keeps one key per
trade intent and starts a new one when asset, side or quantity change.

**7C-C, staging validation** is this procedure: apply migration 9 to staging only, run the preflight (P2/P4 prove it is applied), then
the full write run.

### Key lifecycle

One trade intent = one key. A client generates it once and reuses it for every retry of that same intent (double click, network
failure, timeout). A genuinely new trade needs a NEW key. The key is stored with the trade and, because trades are immutable and never
deleted, it stays bound to that trade permanently and never expires. It is scoped per user: two users may use the same key
independently. An open that fails (for example insufficient cash) rolls back completely and does not reserve its key.

### Replay semantics

Same user + same key + same asset, side and quantity returns the original receipt with `replayed=true`: the original entry price, cost,
`cash_balance_after` and time, not a fresh quote. It debits nothing, inserts nothing and writes no audit entry. The price is
deliberately not compared, because a legitimate retry re-quotes. The returned trade is the current row, so its status may by then be
`CLOSED`; the entry fields and receipt balance are the original immutable values.

### Conflict semantics

The same key with a different asset, side or quantity is refused as `IDEMPOTENCY_KEY_REUSED` (application code `VALIDATION`) with a safe
message and no database text; nothing is created, debited or changed. Only BUY and LONG can be opened, so the side conflict is tested as
BUY→LONG; SELL and SHORT are refused earlier as `SIDE_NOT_SUPPORTED` and never reach the key logic.

### Concurrent duplicates

Simultaneous requests with the same (user, key) serialise on the advisory lock: exactly one creates the trade and the rest resolve as
replays. The unique index is the backstop if the lock were ever bypassed.

### Known limitations

- The staging checks have **not been run** until an operator runs them from an authorized environment and records the result above.
  Nothing in the repository or the offline tests substitutes for that run.
- The smoke test covers the service, store, RPC, grants and RLS with stub quotes. It does not cover the server action, the UI, live
  market-data quotes or a Vercel deployment.
- Failure safety on staging uses a business refusal (insufficient cash) raised inside the transaction. Faults injected mid-transaction
  (after the debit) are exercised only by the local `pnpm test:db` suite.
- Staging concurrency is two simultaneous requests from one process, three rounds. It is evidence, not proof; the local suite uses
  12-way bursts.
- Audit writes are best-effort and happen after the commit, so a trade can exist without an audit row if that write fails; a replay will
  not add one.
- Test trades, their audit rows and the cash they hold remain in staging by design (immutable records).
- Paper trading only: no real money, broker or exchange, and no SELL/SHORT modelling.
