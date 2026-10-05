# Paper-trading staging smoke test (Phase 5C-7B)

PAPER TRADING — NO REAL MONEY. Simulation only. This procedure never places a real order.

## Status — read this first

| Layer                                                                                             | Status                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit/contract tests with a faked client (`pnpm test`)                                             | Local only. **Not** Supabase verification.                                                                                                                                                                                                                                                                                                                               |
| `pnpm test:db` (plain PostgreSQL + a hand-written Supabase stub)                                  | Local only. **Not** Supabase or PostgREST verification.                                                                                                                                                                                                                                                                                                                  |
| One-off local PostgREST probe (Phase 5C-7B, PostgREST 12.2.3 over plain PostgreSQL 16)            | Local only. Exercised the real `SupabasePaperTradingStore` request/response shapes. **Not** Supabase verification.                                                                                                                                                                                                                                                       |
| `pnpm smoke:staging` against a real Supabase **staging** project (project `uvxbxxmttjbalhksngir`) | **Run 2026-10-05, run id `smoke-20261005053122-e38fd6`: 20 passed, 0 failed, 0 blocked** (P1–P3, W0, C1–C15, X1), reported by the operator from their own terminal. Scope: the store, RPCs, grants, RLS and immutability using fixed test quotes (`isMock=true`) and `--quantity 0.05`. Not covered: server actions, the UI, live market-data quotes, Vercel deployment. |

## Prerequisites (all must exist before the live run)

1. A **dedicated Supabase staging project** with migrations 1–8 applied (`supabase db push` against staging only) and assets seeded:
   `pnpm seed:assets --project-ref <staging-ref>`.
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

# 2. Full write run: creates 2 disposable users and 2 simulated paper trades in STAGING
pnpm smoke:staging --project-ref <staging-ref> --confirm-writes WRITE-TO-STAGING:<staging-ref>
```

Optional: `--market`, `--symbol` (default `CRYPTO` / `BTC`), `--quantity`, `--entry-price`, `--exit-price` (exact decimals, ≤ 8 dp),
`--artifacts-dir`. Exit codes: `0` all passed, `1` a check failed, `2` refused / prerequisites missing.

## What stops it

It refuses (exit 2, nothing read or written) unless **all** of these hold: `APP_ENV` is exactly `staging`; `VERCEL_ENV` is not
`production`; the URL is `https://<ref>.supabase.co` (self-hosted and local URLs are refused); the URL ref equals
`STAGING_SUPABASE_PROJECT_REF` and `--project-ref`; `PRODUCTION_SUPABASE_PROJECT_REF` is declared and different; JWT-shaped
keys carry the matching project `ref` and the right role; and, for writes, `--confirm-writes` equals `WRITE-TO-STAGING:<ref>`.
Supabase projects do not describe their own environment, so "staging" is an operator declaration that must be consistent
everywhere; the script cannot detect a staging project that is really production under a different ref.
Messages name variables and refs only — never key values.

## Checks

Preflight (both modes): P1 asset present · P2 `::text` casts readable on all three tables · P3 both RPCs exist for `service_role`
(probe is rejected before any write).

Write run (numbers in brackets are the Phase 5C-7B brief's list): W0 users + sign-in · C1 [4] empty snapshot · C2 [5,1,2] open ·
C3 [1] stored decimals exact · C4 [4] snapshot after open · C5 [3] owner-scoped trade lookup · C6 [9] cross-user reads via store and
RLS (with a positive control) · C7 [9] other user cannot close · C8 [10] anon/authenticated cannot call the RPCs · C9 [10] no direct
table writes · C10 [6,7] close · C11 [7] final status/fees/exit/P&L/balance · C12 [4] snapshot + history read-back · C13 [8] second
close refused · C14 [8] two concurrent closes settle once · C15 immutability even for `service_role` · X1 disable test users.

Amounts are compared as exact decimals (so `10000` equals `10000.00000000`). Test quotes are fixed values labelled
`staging-smoke:<runId>` with `isMock=true`; no market data is used.

## Artifacts and cleanup

Every run writes `smoke-artifacts/<runId>.json` (git-ignored; user ids, trade ids, result ids, check outcomes; **no secrets or
passwords**). Test users are emailed-as `trademonk-smoke-<runId>-a|b@<domain>`.

Cleanup is deliberately minimal: the **only** action is disabling (banning) the two users this run created, after confirming the
email prefix and `smoke_run` metadata. Trades, results and accounts are immutable financial records and are **not** deleted, and no
constraint is relaxed. Deleting a test user would cascade-delete its records, so it is not done. If staging must be reset, reset
the whole staging project deliberately — never production.

## Reading a failure

A FAIL with `permission denied` on an expected operation means a grant/migration problem in staging; a FAIL on C8/C9 means a client
privilege boundary is open and must be fixed before anything else. Paste the check ids and messages (not keys) when reporting.
Do not weaken a check to get a pass.
