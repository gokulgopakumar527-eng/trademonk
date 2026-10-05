/**
 * Opt-in STAGING smoke test for the paper-trading Supabase/PostgREST integration (Phase 5C-7B).
 * PAPER TRADING — SIMULATION ONLY, NO REAL MONEY. See docs/staging-smoke-test.md.
 *
 *   pnpm smoke:staging --project-ref <ref>                                           # read-only preflight
 *   pnpm smoke:staging --project-ref <ref> --confirm-writes WRITE-TO-STAGING:<ref>   # full write run
 *
 * It refuses to run unless the target is provably the declared STAGING project (see
 * scripts/lib/staging-smoke-guard.ts). The write run creates two disposable test users and a few
 * simulated paper trades through the REAL store (SupabasePaperTradingStore) and the REAL
 * PostgREST/RPC path, then checks the results, ownership scoping, privilege boundaries and
 * double-close protection. It uses fixed, clearly-labelled TEST prices (quote source
 * "staging-smoke:<runId>", isMock=true), never live market data and never live-money execution.
 *
 * Cleanup: financial records are immutable and are NEVER deleted. The only cleanup is disabling
 * (banning) the test users this run created. Every created id is written to
 * smoke-artifacts/<runId>.json (no secrets) so test data stays identifiable.
 *
 * Run through the package script: it enables the `react-server` condition that `server-only` needs.
 * Exit codes: 0 all checks passed, 1 at least one check FAILED, 2 refused / prerequisites missing.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { PAPER_SIMULATION } from "../config/paper-trading";
import {
  realizedLongPnl,
  simulateLongEntry,
  simulateLongExit,
} from "../services/paper-trading/execution";
import {
  formatScaled,
  formatSignedScaled,
  parseDecimalAmount,
  parseSignedDecimalAmount,
  type Scaled,
} from "../services/paper-trading/money";
import {
  argValue,
  evaluateSmokeGuard,
  isSmokeEmail,
  newRunId,
  smokeEmail,
} from "./lib/staging-smoke-guard";

type Outcome = "PASS" | "FAIL" | "BLOCKED";
interface CheckRecord {
  id: string;
  name: string;
  outcome: Outcome;
  detail?: string;
}
interface DbError {
  message: string;
  code?: string;
}
interface DbResult {
  data: unknown;
  error: DbError | null;
}

class Blocked extends Error {}

const secrets: string[] = [];
const redact = (text: string): string =>
  secrets.reduce((t, s) => (s.length >= 8 ? t.split(s).join("[redacted]") : t), text);

const checks: CheckRecord[] = [];
async function check(id: string, name: string, fn: () => Promise<string | void>): Promise<void> {
  let rec: CheckRecord;
  try {
    const detail = await fn();
    rec = { id, name, outcome: "PASS", ...(detail ? { detail } : {}) };
  } catch (error) {
    const msg = redact(error instanceof Error ? error.message : String(error));
    rec = { id, name, outcome: error instanceof Blocked ? "BLOCKED" : "FAIL", detail: msg };
  }
  checks.push(rec);
  console.log(
    `${rec.outcome.padEnd(7)} ${id}  ${name}${rec.detail ? `\n          ${rec.detail}` : ""}`,
  );
}

function need<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null)
    throw new Blocked(`blocked: ${what} is not available (an earlier step failed)`);
  return value;
}
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}
/** Numeric equality on exact decimal text (the database keeps column scale, e.g. "10000" vs "10000.00000000"). */
function sameAmount(actual: unknown, expected: Scaled, what: string): void {
  const parsed = parseSignedDecimalAmount(actual);
  assert(parsed !== null, `${what}: not an exact decimal string (got ${JSON.stringify(actual)})`);
  assert(
    parsed === expected,
    `${what}: expected ${formatSignedScaled(expected)}, got ${String(actual)}`,
  );
}
function scaledFromNumber(n: number, what: string): Scaled {
  const s = parseDecimalAmount(n.toFixed(8));
  assert(s !== null, `${what} is outside the supported range`);
  return s;
}

async function main(): Promise<number> {
  const guard = evaluateSmokeGuard({ env: process.env, argv: process.argv.slice(2) });
  if (!guard.ok) {
    console.error("Refusing to run the staging smoke test:");
    for (const p of guard.problems) console.error(`  - ${p}`);
    console.error("See docs/staging-smoke-test.md. Nothing was read or written.");
    return 2;
  }
  const { projectRef, mode } = guard.target;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  secrets.push(process.env.SUPABASE_SERVICE_ROLE_KEY!, anonKey);

  const runId = newRunId(new Date(), randomBytes(4).toString("hex"));
  const emailDomain = process.env.SMOKE_TEST_EMAIL_DOMAIN || "example.com";
  const market = argValue(process.argv, "market") ?? "CRYPTO";
  const symbol = argValue(process.argv, "symbol") ?? "BTC";
  const qty = parseDecimalAmount(argValue(process.argv, "quantity") ?? "0.12345678");
  const entryRef = parseDecimalAmount(argValue(process.argv, "entry-price") ?? "61234.56789012");
  const exitRef = parseDecimalAmount(argValue(process.argv, "exit-price") ?? "61500.00000001");
  if (!qty || !entryRef || !exitRef || qty <= 0n || entryRef <= 0n || exitRef <= 0n) {
    console.error(
      "--quantity, --entry-price and --exit-price must be positive decimals with at most 8 decimal places.",
    );
    return 2;
  }

  console.log(`TradeMonk paper-trading STAGING smoke test — PAPER TRADING, NO REAL MONEY`);
  console.log(`project: ${projectRef}   mode: ${mode}   run: ${runId}\n`);

  const { createSupabaseAdminClient } = await import("../lib/supabase/admin");
  const { SupabasePaperTradingStore } = await import("../services/paper-trading/supabase-store");
  const admin = createSupabaseAdminClient();
  const store = new SupabasePaperTradingStore();
  const plainClient = (): SupabaseClient =>
    createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });

  const artifact: Record<string, unknown> = {
    note: "PAPER TRADING — NO REAL MONEY. Disposable staging smoke-test artifacts. Contains no secrets.",
    runId,
    projectRef,
    mode,
    startedAt: new Date().toISOString(),
    users: {} as Record<string, string>,
    tradeIds: [] as string[],
    resultIds: [] as string[],
  };
  const dir = argValue(process.argv, "artifacts-dir") ?? "smoke-artifacts";
  const artifactPath = path.join(dir, `${runId}.json`);
  const flush = (): void => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(artifactPath, JSON.stringify({ ...artifact, checks }, null, 2) + "\n");
  };

  // ── State shared between checks ──
  const ctx: {
    assetId?: string;
    currency?: string;
    startingCash?: Scaled;
    entry?: ReturnType<typeof simulateLongEntry>;
    exit?: ReturnType<typeof simulateLongExit>;
    userA?: string;
    userB?: string;
    clientA?: SupabaseClient;
    clientB?: SupabaseClient;
    tradeId?: string;
    accountId?: string;
    cashAfterOpen?: Scaled;
    cashAfterClose?: Scaled;
    pnl?: Scaled;
    closeParams?: Parameters<typeof store.closeTrade>[0];
    openParams?: Parameters<typeof store.openTrade>[0];
  } = {};
  const quote = {
    source: `staging-smoke:${runId}`,
    asOf: new Date().toISOString(),
    fetchedAt: new Date().toISOString(),
    isMock: true,
  };

  // ── Preflight (read-only; runs in both modes) ──
  await check("P1", "target asset exists and is active", async () => {
    const { data, error } = await admin
      .from("assets")
      .select("id, currency, market")
      .eq("market", market)
      .eq("symbol", symbol)
      .eq("is_active", true)
      .maybeSingle();
    if (error) throw new Error(`assets read failed: ${error.message}`);
    assert(
      data,
      `no active asset ${market}:${symbol} (seed with pnpm seed:assets --project-ref ${projectRef})`,
    );
    ctx.assetId = data.id as string;
    ctx.currency = data.currency as string;
    const cfg = PAPER_SIMULATION.markets[data.market as keyof typeof PAPER_SIMULATION.markets];
    const cash =
      PAPER_SIMULATION.startingCash[data.currency as keyof typeof PAPER_SIMULATION.startingCash];
    assert(
      cfg && cash !== undefined,
      `no paper-trading simulation config for ${market}/${String(data.currency)}`,
    );
    ctx.startingCash = scaledFromNumber(cash, "starting cash");
    ctx.entry = simulateLongEntry({ referencePrice: entryRef, quantity: qty, rates: cfg });
    ctx.exit = simulateLongExit({ referencePrice: exitRef, quantity: qty, rates: cfg });
    // The trades run one after another (each is closed before the next opens), so only ONE must fit,
    // with headroom for the round-trip fees/slippage that can leave the balance slightly below start.
    assert(
      (ctx.entry.cashRequired * 11n) / 10n <= ctx.startingCash,
      "a test trade (plus 10% headroom) would not fit in the starting cash; lower --quantity",
    );
    return `${market}:${symbol} (${String(data.currency)})`;
  });
  await check(
    "P2",
    "migrations 7/8 columns are readable through PostgREST (::text casts)",
    async () => {
      const a = await admin
        .from("paper_accounts")
        .select("starting_cash::text, cash_balance::text")
        .limit(1);
      const t = await admin
        .from("paper_trades")
        .select("quantity::text, cash_debited::text, notional::text")
        .limit(1);
      const r = await admin
        .from("paper_trade_results")
        .select("exit_price::text, fees::text, pnl::text, cash_credited::text")
        .limit(1);
      for (const [n, res] of [
        ["paper_accounts", a],
        ["paper_trades", t],
        ["paper_trade_results", r],
      ] as const) {
        if (res.error) throw new Error(`${n}: ${res.error.message}`);
      }
    },
  );
  await check(
    "P3",
    "open_paper_trade / close_paper_trade exist for service_role (probe is rejected before any write)",
    async () => {
      const o = await admin.rpc("open_paper_trade", {
        p_user_id: randomUUID(),
        p_asset_id: randomUUID(),
        p_side: "SELL",
        p_quantity: "1",
        p_entry_price: "1",
        p_fee: "0",
        p_starting_cash: "1",
        p_sim_version: "probe",
        p_reference_price: "1",
        p_slippage_bps: "0",
        p_fee_bps: "0",
        p_quote_source: "probe",
        p_quote_as_of: quote.asOf,
        p_quote_fetched_at: quote.fetchedAt,
        p_quote_is_mock: true,
      });
      assert(
        o.error?.message.includes("PAPER_INVALID_INPUT"),
        `open probe: expected PAPER_INVALID_INPUT, got ${o.error?.message ?? "success"}`,
      );
      const c = await admin.rpc("close_paper_trade", {
        p_user_id: randomUUID(),
        p_trade_id: randomUUID(),
        p_exit_price: "1",
        p_fee: "0",
        p_pnl: "0",
        p_sim_version: "probe",
        p_reference_price: "1",
        p_slippage_bps: "0",
        p_fee_bps: "0",
        p_quote_source: "probe",
        p_quote_as_of: quote.asOf,
        p_quote_fetched_at: quote.fetchedAt,
        p_quote_is_mock: true,
      });
      assert(
        c.error?.message.includes("PAPER_TRADE_NOT_FOUND"),
        `close probe: expected PAPER_TRADE_NOT_FOUND, got ${c.error?.message ?? "success"}`,
      );
    },
  );

  if (mode === "dry-run") {
    flush();
    summarise(
      artifactPath,
      "dry-run: no writes were performed. Re-run with --confirm-writes to execute the write checks.",
    );
    return checks.some((c) => c.outcome === "FAIL") ? 1 : 0;
  }

  // ── Write run ──
  const passwords = {
    a: randomBytes(24).toString("base64url"),
    b: randomBytes(24).toString("base64url"),
  };
  secrets.push(passwords.a, passwords.b);

  await check("W0", "create two disposable test users and sign in as each", async () => {
    for (const who of ["a", "b"] as const) {
      const email = smokeEmail(runId, who, emailDomain);
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password: passwords[who],
        email_confirm: true,
        user_metadata: { name: `TradeMonk smoke ${who.toUpperCase()}`, smoke_run: runId },
      });
      if (error || !data.user)
        throw new Error(`createUser ${who}: ${error?.message ?? "no user returned"}`);
      (artifact.users as Record<string, string>)[who] = data.user.id;
      flush();
      if (who === "a") ctx.userA = data.user.id;
      else ctx.userB = data.user.id;
      const client = plainClient();
      const signIn = await client.auth.signInWithPassword({ email, password: passwords[who] });
      if (signIn.error) throw new Error(`sign-in ${who}: ${signIn.error.message}`);
      if (who === "a") ctx.clientA = client;
      else ctx.clientB = client;
    }
    const { data } = await admin
      .from("profiles")
      .select("id")
      .in("id", [need(ctx.userA, "user A"), need(ctx.userB, "user B")]);
    assert(data?.length === 2, "the signup trigger did not create both profiles");
  });

  const userA = () => need(ctx.userA, "user A");
  const userB = () => need(ctx.userB, "user B");

  await check(
    "C1",
    "[4] portfolio snapshot of a brand-new user is empty (no account, trades or results)",
    async () => {
      for (const id of [userA(), userB()]) {
        const s = await store.getPortfolioSnapshot(id);
        assert(
          s.accounts.length === 0 && s.openTrades.length === 0 && s.results.length === 0,
          "expected an empty snapshot",
        );
      }
    },
  );

  await check(
    "C2",
    "[5,1,2] open a simulated trade: RPC args and payload parse; returned balance is exact",
    async () => {
      const e = need(ctx.entry, "entry simulation");
      const params = {
        userId: userA(),
        assetId: need(ctx.assetId, "asset"),
        side: "BUY" as const,
        quantity: formatScaled(qty),
        entryPrice: formatScaled(e.executionPrice),
        fee: formatScaled(e.fee),
        startingCash: formatScaled(need(ctx.startingCash, "starting cash")),
        simVersion: PAPER_SIMULATION.version,
        referencePrice: formatScaled(e.referencePrice),
        slippageBps: e.appliedSlippageBps,
        feeBps: e.appliedFeeBps,
        quote,
        // Minimal compile fix for the 16-argument RPC. Replay/conflict smoke checks belong to Phase 5C-7C-C.
        idempotencyKey: `smoke-${crypto.randomUUID()}`,
      };
      ctx.openParams = params;
      const res = await store.openTrade(params);
      assert(res.ok, `open was refused: ${res.ok ? "" : res.reason}`);
      ctx.tradeId = res.tradeId;
      (artifact.tradeIds as string[]).push(res.tradeId);
      flush();
      assert(!Number.isNaN(Date.parse(res.openedAt)), "openedAt is not a timestamp");
      assert(res.currency === ctx.currency, "currency mismatch");
      ctx.cashAfterOpen = need(ctx.startingCash, "starting cash") - e.cashRequired;
      sameAmount(res.cashBalanceAfter, ctx.cashAfterOpen, "cashBalanceAfter");
      return `trade ${res.tradeId}`;
    },
  );

  await check(
    "C3",
    "[1] stored entry record matches the exact expected decimals (::text)",
    async () => {
      const e = need(ctx.entry, "entry simulation");
      const { data, error } = await admin
        .from("paper_trades")
        .select(
          "status, side, quantity::text, entry_price::text, fees::text, notional::text, cash_debited::text, reference_price::text, sim_version, quote_is_mock, account_id",
        )
        .eq("id", need(ctx.tradeId, "trade"))
        .maybeSingle();
      if (error) throw new Error(error.message);
      assert(data, "trade row not found");
      assert(data.status === "OPEN" && data.side === "BUY", "unexpected status/side");
      sameAmount(data.quantity, qty, "quantity");
      sameAmount(data.entry_price, e.executionPrice, "entry_price");
      sameAmount(data.fees, e.fee, "entry fee");
      sameAmount(data.notional, e.notional, "notional");
      sameAmount(data.cash_debited, e.cashRequired, "cash_debited");
      sameAmount(data.reference_price, e.referencePrice, "reference_price");
      assert(
        data.quote_is_mock === true && data.sim_version === PAPER_SIMULATION.version,
        "provenance fields wrong",
      );
      ctx.accountId = data.account_id as string;
    },
  );

  await check(
    "C4",
    "[4,1] portfolio snapshot after open: owner-scoped, exact cash and open trade",
    async () => {
      const s = await store.getPortfolioSnapshot(userA());
      assert(
        s.accounts.length === 1 && s.accounts[0]!.userId === userA(),
        "expected exactly A's account",
      );
      sameAmount(
        s.accounts[0]!.cashBalance,
        need(ctx.cashAfterOpen, "cash after open"),
        "snapshot cash",
      );
      const t = s.openTrades.find((x) => x.tradeId === ctx.tradeId);
      assert(t && t.userId === userA(), "open trade missing from A's snapshot");
      sameAmount(t.quantity, qty, "snapshot quantity");
      sameAmount(t.cashDebited, need(ctx.entry, "entry").cashRequired, "snapshot cash_debited");
    },
  );

  await check(
    "C5",
    "[3] getTradeForClose is owner-scoped: A sees it with exact text values, B gets null",
    async () => {
      const a = await store.getTradeForClose(userA(), need(ctx.tradeId, "trade"));
      assert(a && a.status === "OPEN", "A cannot load their own open trade");
      sameAmount(a.quantity, qty, "candidate quantity");
      sameAmount(a.cashDebited, need(ctx.entry, "entry").cashRequired, "candidate cashDebited");
      assert((await store.getTradeForClose(userB(), a.tradeId)) === null, "B could load A's trade");
    },
  );

  await check(
    "C6",
    "[9] B cannot read A's data: store snapshot/history and RLS-scoped direct reads",
    async () => {
      const sb = await store.getPortfolioSnapshot(userB());
      assert(
        sb.accounts.length === 0 && sb.openTrades.length === 0,
        "B's snapshot contains A's rows",
      );
      const own = await need(ctx.clientA, "client A").from("paper_trades").select("id");
      assert(
        !own.error && own.data?.some((r) => r.id === ctx.tradeId),
        "RLS positive control failed: A cannot read their own trade",
      );
      for (const table of ["paper_trades", "paper_accounts", "paper_trade_results"] as const) {
        const r = await need(ctx.clientB, "client B").from(table).select("id");
        assert(!r.error, `${table}: ${r.error?.message}`);
        assert(
          (r.data ?? []).length === 0,
          `${table}: B can read ${(r.data ?? []).length} row(s) it does not own`,
        );
      }
    },
  );

  const stateIsUntouched = async (what: string): Promise<void> => {
    const { data: t } = await admin
      .from("paper_trades")
      .select("status, entry_price::text")
      .eq("id", need(ctx.tradeId, "trade"))
      .maybeSingle();
    const { data: a } = await admin
      .from("paper_accounts")
      .select("cash_balance::text")
      .eq("id", need(ctx.accountId, "account"))
      .maybeSingle();
    const { count } = await admin
      .from("paper_trade_results")
      .select("id", { count: "exact", head: true })
      .eq("paper_trade_id", need(ctx.tradeId, "trade"));
    assert(t?.status === "OPEN" && count === 0, `${what}: trade state changed`);
    sameAmount(t.entry_price, need(ctx.entry, "entry").executionPrice, `${what}: entry price`);
    sameAmount(a?.cash_balance, need(ctx.cashAfterOpen, "cash"), `${what}: cash balance`);
  };

  await check(
    "C7",
    "[9] B cannot close A's trade through the store; A's trade is untouched",
    async () => {
      const e = need(ctx.exit, "exit simulation");
      const params = {
        userId: userA(),
        tradeId: need(ctx.tradeId, "trade"),
        exitPrice: formatScaled(e.executionPrice),
        fee: formatScaled(e.fee),
        pnl: formatSignedScaled(
          realizedLongPnl({
            cashCredited: e.cashCredited,
            cashDebited: need(ctx.entry, "entry").cashRequired,
          }),
        ),
        simVersion: PAPER_SIMULATION.version,
        referencePrice: formatScaled(e.referencePrice),
        slippageBps: e.appliedSlippageBps,
        feeBps: e.appliedFeeBps,
        quote,
      };
      ctx.closeParams = params;
      const res = await store.closeTrade({ ...params, userId: userB() });
      assert(
        !res.ok && res.reason === "TRADE_NOT_FOUND",
        `expected TRADE_NOT_FOUND, got ${JSON.stringify(res)}`,
      );
      await stateIsUntouched("after B's attempt");
    },
  );

  const denied = (label: string, res: DbResult): void => {
    const rows = Array.isArray(res.data) ? res.data.length : res.data ? 1 : 0;
    assert(res.error || rows === 0, `${label}: was ALLOWED (affected ${rows} row(s))`);
  };

  await check(
    "C8",
    "[10] clients cannot execute privileged RPCs directly (anon and authenticated)",
    async () => {
      const open = need(ctx.openParams, "open params");
      const close = need(ctx.closeParams, "close params");
      const openArgs = {
        p_user_id: open.userId,
        p_asset_id: open.assetId,
        p_side: open.side,
        p_quantity: open.quantity,
        p_entry_price: open.entryPrice,
        p_fee: open.fee,
        p_starting_cash: open.startingCash,
        p_sim_version: open.simVersion,
        p_reference_price: open.referencePrice,
        p_slippage_bps: open.slippageBps,
        p_fee_bps: open.feeBps,
        p_quote_source: open.quote.source,
        p_quote_as_of: open.quote.asOf,
        p_quote_fetched_at: open.quote.fetchedAt,
        p_quote_is_mock: true,
      };
      const closeArgs = {
        p_user_id: close.userId,
        p_trade_id: close.tradeId,
        p_exit_price: close.exitPrice,
        p_fee: close.fee,
        p_pnl: close.pnl,
        p_sim_version: close.simVersion,
        p_reference_price: close.referencePrice,
        p_slippage_bps: close.slippageBps,
        p_fee_bps: close.feeBps,
        p_quote_source: close.quote.source,
        p_quote_as_of: close.quote.asOf,
        p_quote_fetched_at: close.quote.fetchedAt,
        p_quote_is_mock: true,
      };
      const clients: [string, SupabaseClient][] = [
        ["anon", plainClient()],
        ["authenticated A", need(ctx.clientA, "client A")],
      ];
      for (const [who, c] of clients) {
        for (const [fn, args] of [
          ["open_paper_trade", openArgs],
          ["close_paper_trade", closeArgs],
        ] as const) {
          const r = await c.rpc(fn, args);
          assert(r.error, `${who} executed ${fn}`);
        }
      }
      await stateIsUntouched("after direct RPC attempts");
    },
  );

  await check(
    "C9",
    "[10] clients cannot write the paper tables directly (insert/update/delete)",
    async () => {
      const a = need(ctx.clientA, "client A");
      const tradeId = need(ctx.tradeId, "trade");
      denied(
        "insert paper_trades",
        await a
          .from("paper_trades")
          .insert({
            user_id: userA(),
            asset_id: need(ctx.assetId, "asset"),
            side: "BUY",
            entry_price: 1,
            quantity: 1,
            status: "OPEN",
          })
          .select(),
      );
      denied(
        "update paper_accounts.cash_balance",
        await a
          .from("paper_accounts")
          .update({ cash_balance: 999999999 })
          .eq("id", need(ctx.accountId, "account"))
          .select(),
      );
      denied(
        "update paper_trades.entry_price",
        await a.from("paper_trades").update({ entry_price: 0.00000001 }).eq("id", tradeId).select(),
      );
      denied(
        "update paper_trades.status",
        await a.from("paper_trades").update({ status: "CLOSED" }).eq("id", tradeId).select(),
      );
      denied(
        "insert paper_trade_results",
        await a
          .from("paper_trade_results")
          .insert({
            paper_trade_id: tradeId,
            user_id: userA(),
            exit_price: 1,
            fees: 0,
            pnl: 1000000,
          })
          .select(),
      );
      denied(
        "delete paper_trades",
        await a.from("paper_trades").delete().eq("id", tradeId).select(),
      );
      await stateIsUntouched("after direct table-write attempts");
    },
  );

  await check(
    "C10",
    "[6,7] close the trade through the store; payload and balance are exact",
    async () => {
      const params = need(ctx.closeParams, "close params");
      const e = need(ctx.exit, "exit simulation");
      const res = await store.closeTrade(params);
      assert(res.ok, `close was refused: ${res.ok ? "" : res.reason}`);
      assert(res.tradeId === ctx.tradeId, "closed a different trade");
      ctx.pnl = realizedLongPnl({
        cashCredited: e.cashCredited,
        cashDebited: need(ctx.entry, "entry").cashRequired,
      });
      ctx.cashAfterClose = need(ctx.cashAfterOpen, "cash") + e.cashCredited;
      sameAmount(res.cashCredited, e.cashCredited, "cashCredited");
      sameAmount(res.pnl, ctx.pnl, "pnl");
      sameAmount(res.cashBalanceAfter, ctx.cashAfterClose, "cashBalanceAfter");
      return `realized P&L ${formatSignedScaled(ctx.pnl)} ${String(ctx.currency)}`;
    },
  );

  await check(
    "C11",
    "[7] stored final state: status, fees, exit price, P&L, one result row, account reconciles",
    async () => {
      const e = need(ctx.exit, "exit simulation");
      const entry = need(ctx.entry, "entry");
      const tradeId = need(ctx.tradeId, "trade");
      const { data: t } = await admin
        .from("paper_trades")
        .select("status, fees::text")
        .eq("id", tradeId)
        .maybeSingle();
      assert(t?.status === "CLOSED", `trade status is ${String(t?.status)}`);
      sameAmount(t.fees, entry.fee, "stored entry fee");
      const { data: rs, error } = await admin
        .from("paper_trade_results")
        .select(
          "id, exit_price::text, fees::text, pnl::text, cash_credited::text, reference_price::text, quote_is_mock",
        )
        .eq("paper_trade_id", tradeId);
      if (error) throw new Error(error.message);
      assert(rs?.length === 1, `expected exactly 1 result row, found ${rs?.length}`);
      const r = rs[0]!;
      (artifact.resultIds as string[]).push(r.id as string);
      flush();
      sameAmount(r.exit_price, e.executionPrice, "exit_price");
      sameAmount(r.fees, e.fee, "exit fee");
      sameAmount(r.pnl, need(ctx.pnl, "pnl"), "stored pnl");
      sameAmount(r.cash_credited, e.cashCredited, "cash_credited");
      assert(r.quote_is_mock === true, "result provenance wrong");
      const { data: acct } = await admin
        .from("paper_accounts")
        .select("starting_cash::text, cash_balance::text")
        .eq("id", need(ctx.accountId, "account"))
        .maybeSingle();
      sameAmount(acct?.cash_balance, need(ctx.cashAfterClose, "cash"), "final cash balance");
      sameAmount(
        acct?.cash_balance,
        need(ctx.startingCash, "starting") + need(ctx.pnl, "pnl"),
        "cash == starting cash + realized P&L (no open positions)",
      );
    },
  );

  await check(
    "C12",
    "[4] portfolio snapshot and closed-trade history read back the same exact values",
    async () => {
      const s = await store.getPortfolioSnapshot(userA());
      assert(
        s.openTrades.length === 0 && s.results.length === 1,
        "expected no open trades and one result",
      );
      sameAmount(s.results[0]!.pnl, need(ctx.pnl, "pnl"), "snapshot pnl");
      sameAmount(s.accounts[0]!.cashBalance, need(ctx.cashAfterClose, "cash"), "snapshot cash");
      const h = await store.getClosedTrades(userA(), 50);
      assert(h.totalCount === 1 && h.rows.length === 1, "expected one history row");
      const row = h.rows[0]!;
      const e = need(ctx.exit, "exit");
      const entry = need(ctx.entry, "entry");
      assert(row.tradeId === ctx.tradeId && row.userId === userA(), "history row identity wrong");
      sameAmount(row.entryPrice, entry.executionPrice, "history entry price");
      sameAmount(row.entryFee, entry.fee, "history entry fee");
      sameAmount(row.exitPrice, e.executionPrice, "history exit price");
      sameAmount(row.exitFee, e.fee, "history exit fee");
      sameAmount(row.pnl, need(ctx.pnl, "pnl"), "history pnl");
      sameAmount(row.cashCredited, e.cashCredited, "history cash credited");
      const hb = await store.getClosedTrades(userB(), 50);
      assert(hb.totalCount === 0 && hb.rows.length === 0, "B's history is not empty");
    },
  );

  await check(
    "C13",
    "[8] a second close of the same trade is refused and settles nothing",
    async () => {
      const res = await store.closeTrade(need(ctx.closeParams, "close params"));
      assert(
        !res.ok && res.reason === "TRADE_ALREADY_CLOSED",
        `expected TRADE_ALREADY_CLOSED, got ${JSON.stringify(res)}`,
      );
      const { count } = await admin
        .from("paper_trade_results")
        .select("id", { count: "exact", head: true })
        .eq("paper_trade_id", need(ctx.tradeId, "trade"));
      assert(count === 1, `result rows: ${count}`);
      const { data: acct } = await admin
        .from("paper_accounts")
        .select("cash_balance::text")
        .eq("id", need(ctx.accountId, "account"))
        .maybeSingle();
      sameAmount(acct?.cash_balance, need(ctx.cashAfterClose, "cash"), "cash after second close");
    },
  );

  await check("C14", "[8] two CONCURRENT closes of one trade settle it exactly once", async () => {
    const open = await store.openTrade({ ...need(ctx.openParams, "open params"), quote });
    assert(open.ok, `second open refused: ${open.ok ? "" : open.reason}`);
    (artifact.tradeIds as string[]).push(open.tradeId);
    flush();
    const params = { ...need(ctx.closeParams, "close params"), tradeId: open.tradeId };
    const [r1, r2] = await Promise.all([store.closeTrade(params), store.closeTrade(params)]);
    const oks = [r1, r2].filter((r) => r.ok).length;
    assert(
      oks === 1,
      `expected exactly one successful close, got ${oks}: ${JSON.stringify([r1, r2])}`,
    );
    const other = [r1, r2].find((r) => !r.ok);
    assert(
      other && !other.ok && other.reason === "TRADE_ALREADY_CLOSED",
      `loser should be TRADE_ALREADY_CLOSED: ${JSON.stringify(other)}`,
    );
    const { count } = await admin
      .from("paper_trade_results")
      .select("id", { count: "exact", head: true })
      .eq("paper_trade_id", open.tradeId);
    assert(count === 1, `result rows for the raced trade: ${count}`);
    const { data: acct } = await admin
      .from("paper_accounts")
      .select("cash_balance::text")
      .eq("id", need(ctx.accountId, "account"))
      .maybeSingle();
    // Both trades round-trip: cash == start + 2 x realized P&L.
    sameAmount(
      acct?.cash_balance,
      need(ctx.startingCash, "starting") + 2n * need(ctx.pnl, "pnl"),
      "cash after raced close",
    );
  });

  await check(
    "C15",
    "immutability holds through PostgREST even for the service role (attempts must be rejected)",
    async () => {
      const tradeId = need(ctx.tradeId, "trade");
      const r1 = await admin
        .from("paper_trade_results")
        .update({ pnl: 123456 })
        .eq("paper_trade_id", tradeId)
        .select();
      assert(r1.error, "a result row was updated");
      const r2 = await admin
        .from("paper_trades")
        .update({ entry_price: 1 })
        .eq("id", tradeId)
        .select();
      assert(r2.error, "a trade's entry price was updated");
      const r3 = await admin
        .from("paper_trades")
        .update({ status: "OPEN" })
        .eq("id", tradeId)
        .select();
      assert(r3.error, "a closed trade was reopened");
      const { data } = await admin
        .from("paper_trade_results")
        .select("pnl::text")
        .eq("paper_trade_id", tradeId)
        .maybeSingle();
      sameAmount(data?.pnl, need(ctx.pnl, "pnl"), "pnl after rejected updates");
    },
  );

  // ── Cleanup: disable ONLY the users this run created. Financial records are never deleted. ──
  await check("X1", "disable (ban) the disposable test users; records are kept", async () => {
    for (const id of [ctx.userA, ctx.userB]) {
      if (!id) continue;
      const { data, error } = await admin.auth.admin.getUserById(id);
      if (error || !data.user) throw new Error(`getUserById failed: ${error?.message}`);
      assert(
        isSmokeEmail(data.user.email) && data.user.user_metadata?.smoke_run === runId,
        "refusing to touch an account this run did not create",
      );
      const upd = await admin.auth.admin.updateUserById(id, { ban_duration: "876000h" });
      if (upd.error) throw new Error(`ban failed: ${upd.error.message}`);
    }
  });

  artifact.finishedAt = new Date().toISOString();
  flush();
  summarise(
    artifactPath,
    "Test trades and results remain in staging by design (immutable records). Identify them by the ids in the artifact file.",
  );
  return checks.some((c) => c.outcome === "FAIL") ? 1 : 0;
}

function summarise(artifactPath: string, note: string): void {
  const n = (o: Outcome) => checks.filter((c) => c.outcome === o).length;
  console.log(
    `\n${n("PASS")} passed, ${n("FAIL")} failed, ${n("BLOCKED")} blocked.  Artifact: ${artifactPath}`,
  );
  console.log(note);
  console.log(
    "This is a LIVE run against the declared staging project only if every check above ran against it; local PostgreSQL tests are not Supabase verification.",
  );
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(redact(error instanceof Error ? error.message : String(error)));
    process.exit(1);
  },
);
