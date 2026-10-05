# TradeMonk AI

AI-assisted market intelligence for Indian markets and crypto. **Phase 1: foundation.**
No market data, AI, alerts or payments exist yet; those routes are honest placeholders.

## Stack

Next.js 15 (App Router) · React 19 · TypeScript (strict) · Tailwind CSS 4 · Supabase (Postgres, Auth, RLS) · pnpm · Vitest

## Setup

```bash
corepack enable && pnpm install
cp .env.example .env.local       # then fill in the values
pnpm dev                         # http://localhost:3000
```

### Supabase

1. Use a **dedicated** Supabase project for TradeMonk (do not share one with another product).
2. Put the project URL, anon key and service-role key in `.env.local`.
3. Apply the migrations in `supabase/migrations/` in order, either with the CLI
   (`supabase link --project-ref <ref> && supabase db push`) or by running them in the SQL editor.
4. Auth → URL configuration: set Site URL to `NEXT_PUBLIC_APP_URL` and add `<APP_URL>/auth/callback` to the redirect allow-list.
5. To make yourself an admin (service role / SQL editor only; users cannot do this from the app):
   `update public.profiles set role = 'admin' where id = '<your auth user id>';`

## Scripts

| Command                                                     | What it does                                                                                                                                                                                                   |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm build` | The four gates run in CI                                                                                                                                                                                       |
| `pnpm smoke:staging`                                        | Opt-in smoke test of the paper-trading store against a real Supabase **staging** project. Read-only unless `--confirm-writes` is given. See `docs/staging-smoke-test.md`. |
| `pnpm test:db`                                              | Applies the migrations to a throwaway Postgres DB and runs the RLS + immutability SQL tests. Needs a Postgres server and superuser libpq env vars (`PGHOST`, `PGUSER`, ...). Never point it at a real project. |

## Architecture rules

`app → features → services → lib/types`. Services never import React. Server-only modules import `server-only`.
The browser gets only the anon key. The service-role client (`lib/supabase/admin.ts`) bypasses RLS and is used only for
rate limiting, audit logs and (later) evaluators and ingestion.

## Data integrity (predictions)

- `predictions`, `prediction_updates`, `prediction_results` and `audit_logs` are append-only via triggers that fire for **every** role, including `service_role`.
- `created_at`, `expires_at` and `content_hash` are set by a trigger; client values are ignored (and not grantable).
- Corrections are new `prediction_updates` rows with server-assigned versions; the original row never changes.
- A prediction with no `prediction_results` row is OPEN.

## Prediction engine (Phase 5A)

`services/predictions/` turns market data into an immutable, server-priced prediction:
market data facade -> indicators -> market structure -> `generatePrediction()` (pure) -> insert.

- **Server-side entry price.** The client sends only `{ assetId, timeframe }` (strict Zod schema; extra keys are
  rejected). The entry price is the quote from `getMarketDataService()`, refused when unavailable, stale (over
  2 minutes), served from the store, from a closed market, or mock outside development. Quote source, `asOf` and
  `fetchedAt` are stored with the row.
- **Signal agreement.** "N of 5 signals agree" counts the five votes the structure engine uses (swing structure,
  price vs EMA20, EMA20 vs EMA50, MACD histogram, RSI vs 50). A direction needs 4 of 5 and no triggered guard
  (conflicting breakout, RSI exhaustion). It is not a forecast and not a probability of any outcome.
- **NEUTRAL is not stored.** `prediction_direction` has only BULLISH/BEARISH, so a neutral read is returned as a
  rejection (`NO_DIRECTIONAL_SIGNAL`) and nothing is written.
- **Lifecycle** CREATED -> ACTIVE -> EXPIRED is derived from `created_at`/`expires_at` (there is no mutable status
  column). EXPIRED means the horizon elapsed; outcomes (WIN/LOSS/...) are Phase 5B.
- **Writes** use the service role because `authenticated` has no column privilege on the engine fields. The
  append-only triggers still apply. `content_hash` recipe v2 (migration 5) covers the entry price, quote provenance,
  engine version and frozen signal snapshot; `hash_version` says which recipe a row used.
- Engine constants live in `ENGINE_PARAMS` and are versioned by `ENGINE_VERSION`. Change either and bump the version.

## Unresolved decisions

See the Phase 1 report. Highlights: target Supabase project, account deletion vs. immutable history,
the paper-trade/prediction entry-price write path, and legal review of platform predictions.

## Prediction evaluator (Phase 5B)

`services/predictions/evaluator.ts` decides what happened to an expired engine prediction and writes one immutable
`prediction_results` row. Flow: due prediction -> eligibility -> already evaluated? stop -> server quote + closed candles
through `getMarketDataService()` -> pure rules (`evaluation-rules.ts`) -> insert.

- **Rule `TOUCH_WITHIN_HORIZON_V1`** uses the Phase 5A terms unchanged (direction, target, invalidation, horizon). Over
  closed candles fully inside `[created_at, expires_at]`, the first candle to reach a level decides: target first = `WIN`
  (CORRECT), invalidation first = `INVALIDATED` (INCORRECT), neither = `EXPIRED` (NO_CLEAR_RESULT). A single candle that
  reaches both levels is resolved as `INVALIDATED` and flagged `ambiguousWithinBar`. NEUTRAL is never stored (5A), so there
  is nothing to evaluate for it.
- **UNAVAILABLE is not stored.** Unavailable, stale, mock, inconsistent or incomplete data never becomes CORRECT or
  INCORRECT. The attempt is audited (`prediction.evaluation_deferred`), the prediction stays due, and discovery skips it
  for 15 minutes. A stored "unavailable" row would permanently block the real evaluation (one result per prediction).
- **Database-owned integrity (migration 6).** A trigger sets `closed_at` (the evaluation time), `created_at` and a
  `content_hash` that chains to the prediction's hash; it rejects results for manual predictions, unexpired predictions, or
  without an evaluation price and quote/candle provenance. Update/delete/truncate stay blocked for every role; API roles
  can only SELECT (RLS follows the parent prediction).
- **Idempotent.** Result lookup happens before any market call; `UNIQUE(prediction_id)` decides concurrent runs and the
  loser reports `ALREADY_EVALUATED`. Nothing is ever overwritten.
- **Lifecycle** is derived: CREATED -> ACTIVE -> EXPIRED -> EVALUATED (EVALUATED = a result row exists).
- **Triggering.** `GET|POST /api/cron/evaluate-predictions` requires `Authorization: Bearer $CRON_SECRET` (503 while unset,
  401 otherwise). It accepts only `?limit=` (1-100); it cannot name a prediction, price or time. Manual/dev path:
  `pnpm evaluate:predictions --project-ref <ref> [--limit N | --id <uuid>]` (runs only when `APP_ENV` is explicitly `development` or `staging`; refuses production and any unset/unknown value).
  Production cron is not configured yet; when it is, add a `vercel.json` cron for the route and set `CRON_SECRET`.


## Paper trading foundation (Phase 5C-1)

PAPER TRADING — NO REAL MONEY. Foundation only: no trade opening/closing, P&L, portfolio or UI yet (5C-2+).

- `config/paper-trading.ts` is the single home of the **simulation assumptions** (starting cash per currency, simulated
  fee and slippage in bps, per market). They are illustrative, not real brokerage/exchange/tax charges. Validated by
  Zod, deep-frozen, versioned (`PAPER_SIM_V1`).
- `services/paper-trading/` is the server-side boundary: Server Action/API -> Paper Trading Service -> Market Data
  Service. It has types mirroring the Phase 1 `paper_trades` / `paper_trade_results` tables, row validators, injected
  dependency ports and a read-only `getSimulationAssumptions()`. It never calls a provider and does no database writes.
- No migration: the Phase 1 RLS already gives users SELECT on their own rows and UPDATE of `stop_loss`/`take_profit`
  on OPEN trades only. Trade creation and closing are reserved for the server (service role) in 5C-2.
- Tests: `tests/paper-trading/*` (unit/static) and section 9 of `supabase/tests/rls_and_immutability.test.sql`
  (`pnpm test:db`, behavioural cross-user / INSERT / entry-price checks).
