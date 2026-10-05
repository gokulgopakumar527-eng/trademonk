import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PAPER_SIMULATION } from "@/config/paper-trading";
import { AppError } from "@/lib/errors";
import type { PortfolioSnapshot } from "@/services/paper-trading/ports";
import { parseSignedDecimalAmount } from "@/services/paper-trading/money";
import { ALICE, BOB, BTC, NOW, RELIANCE, errorView, freshView, quote } from "./open-helpers";
import { NSE_QUOTE, makeCloseCtx, type CloseCtx } from "./close-helpers";

const cur = (p: Awaited<ReturnType<CloseCtx["service"]["getPortfolio"]>>, c: string) => p.currencies.find((x) => x.currency === c)!;
const iso = (msBefore: number) => new Date(NOW.getTime() - msBefore).toISOString();
const code = async (p: Promise<unknown>) => ((await p.then(() => null, (e: unknown) => e)) as AppError | null)?.code;

// Figures derived independently (half-up, 8 dp): BTC 2 @ 100, 5 bp slippage + 10 bp fee
// => entry 100.05, notional 200.10, entry fee 0.2001, cost 200.3001. Cash 10000 -> 9799.6999.
describe("portfolio: empty and open positions", () => {
  it("an empty portfolio shows configured opening cash, no account yet, and zero (genuinely) everywhere", async () => {
    const c = makeCloseCtx();
    const p = await c.service.getPortfolio(ALICE);
    expect(p.banner).toBe("PAPER TRADING — NO REAL MONEY");
    expect(p.positions).toEqual([]);
    expect(p.unattributedRecords).toBe(0);
    expect(cur(p, "USDT")).toMatchObject({
      accountExists: false, startingCash: "10000.00000000", cashBalance: "10000.00000000", openPositionCount: 0,
      openPositionsEntryCost: "0.00000000", realizedPnl: "0.00000000", valuation: "COMPLETE", unrealizedPnl: "0.00000000",
      equity: "10000.00000000", bookValue: "10000.00000000", reconciliation: { status: "CONSISTENT", difference: "0.00000000" },
    });
    expect(cur(p, "INR").cashBalance).toBe("1000000.00000000");
    expect(c.quoteCalls).toHaveLength(0); // nothing to price, nothing fetched
  });

  it("an open position: cash already net of entry cost; equity counts the cost once", async () => {
    const c = makeCloseCtx();
    await c.openBtc(ALICE, 2);
    c.setPrice(110);
    const u = cur(await c.service.getPortfolio(ALICE), "USDT");
    expect(u).toMatchObject({
      accountExists: true, cashBalance: "9799.69990000", openPositionCount: 1, openPositionsEntryCost: "200.30010000",
      markValue: "220.00000000", unrealizedPnl: "19.69990000", equity: "10019.69990000", bookValue: "10000.00000000",
      realizedPnl: "0.00000000", closedTradeCount: 0, valuation: "COMPLETE", reconciliation: { status: "CONSISTENT" },
    });
    // exposure != equity: adding cost on top of cash would double count (10000 + 200.30 != 10000 + ...)
    expect(u.equity).not.toBe("10000.00000000");
    const pos = (await c.service.getPortfolio(ALICE)).positions[0]!;
    expect(pos.valuation).toMatchObject({ status: "VALUED", markPrice: "110.00000000", markValue: "220.00000000", unrealizedPnl: "19.69990000" });
    expect(pos.entryCost).toBe("200.30010000");
  });

  it("a losing mark: negative unrealized P&L, still no double-counted fee", async () => {
    const c = makeCloseCtx();
    await c.openBtc(ALICE, 2);
    c.setPrice(90);
    const u = cur(await c.service.getPortfolio(ALICE), "USDT");
    expect(u.unrealizedPnl).toBe("-20.30010000"); // 180 - 200.3001
    expect(u.equity).toBe("9979.69990000"); // 9799.6999 + 180
  });

  it("prices each distinct asset once even with several positions", async () => {
    const c = makeCloseCtx();
    await c.openBtc(ALICE, 1);
    await c.openBtc(ALICE, "0.5");
    await c.service.getPortfolio(ALICE);
    expect(c.quoteCalls.filter((a) => a.id === BTC.id).length).toBe(2 + 1); // two opens + ONE valuation
  });

  it("keeps INR and USDT separate: no cross-currency sum", async () => {
    const c = makeCloseCtx();
    await c.openBtc(ALICE, 1);
    c.setQuote(freshView(NSE_QUOTE(2500)));
    await c.service.openTrade(ALICE, { assetId: RELIANCE.id, side: "LONG", quantity: 3 });
    const p = await c.service.getPortfolio(ALICE);
    expect(cur(p, "USDT").openPositionCount).toBe(1);
    expect(cur(p, "INR").openPositionCount).toBe(1);
    expect(p.positions.map((x) => x.currency).sort()).toEqual(["INR", "USDT"]);
  });
});

describe("portfolio: closed trades and accounting consistency", () => {
  it("a profitable close: realized P&L equals the close result and the account reconciles", async () => {
    const c = makeCloseCtx();
    const id = await c.openBtc(ALICE, 2);
    c.setPrice(110);
    const closed = await c.service.closeTrade(ALICE, { tradeId: id });
    const u = cur(await c.service.getPortfolio(ALICE), "USDT");
    expect(closed.realizedPnl).toBe(19.37001);
    expect(u).toMatchObject({
      realizedPnl: "19.37001000", closedTradeCount: 1, openPositionCount: 0, openPositionsEntryCost: "0.00000000",
      unrealizedPnl: "0.00000000", cashBalance: "10019.37001000", equity: "10019.37001000",
      reconciliation: { status: "CONSISTENT", difference: "0.00000000" },
    });
  });

  it("a losing close: negative realized P&L, entry and exit fees each counted once", async () => {
    const c = makeCloseCtx();
    const id = await c.openBtc(ALICE, 2);
    c.setPrice(90);
    await c.service.closeTrade(ALICE, { tradeId: id });
    const u = cur(await c.service.getPortfolio(ALICE), "USDT");
    // exit 89.955 -> gross 179.91, fee 0.17991, credit 179.73009; pnl = 179.73009 - 200.3001
    expect(u.realizedPnl).toBe("-20.57001000");
    expect(u.cashBalance).toBe("9979.42999000");
    expect(u.reconciliation.status).toBe("CONSISTENT");
  });

  it("identity holds with a mix of closed and open positions: equity = start + realized + unrealized", async () => {
    const c = makeCloseCtx();
    const a = await c.openBtc(ALICE, 2);
    c.setPrice(110);
    await c.service.closeTrade(ALICE, { tradeId: a });
    await c.openBtc(ALICE, "0.33333333");
    c.setPrice(97.123456);
    const u = cur(await c.service.getPortfolio(ALICE), "USDT");
    const S = (s: string) => BigInt(s.replace(".", ""));
    expect(u.reconciliation.status).toBe("CONSISTENT");
    expect(S(u.equity!)).toBe(S(u.startingCash) + S(u.realizedPnl.replace("-", "")) * (u.realizedPnl.startsWith("-") ? -1n : 1n) + S(u.unrealizedPnl!.replace("-", "")) * (u.unrealizedPnl!.startsWith("-") ? -1n : 1n));
    expect(S(u.bookValue)).toBe(S(u.cashBalance) + S(u.openPositionsEntryCost));
  });

  it("rounding: a fractional quantity marks with half-up rounding on the 8-dp grid", async () => {
    const c = makeCloseCtx();
    await c.openBtc(ALICE, "0.00000003");
    c.setPrice(0.5); // 0.5 * 0.00000003 = 1.5e-8 -> rounds half-up to 2e-8
    const pos = (await c.service.getPortfolio(ALICE)).positions[0]!;
    expect(pos.valuation).toMatchObject({ status: "VALUED", markValue: "0.00000002" });
  });

  it("flags a mismatch instead of hiding it when the stored cash disagrees with the history", async () => {
    const c = makeCloseCtx();
    await c.openBtc(ALICE, 2);
    c.fs.state.accounts.get(`${ALICE}:USDT`)!.balance += 1n; // simulated corruption
    const u = cur(await c.service.getPortfolio(ALICE), "USDT");
    expect(u.reconciliation).toEqual({ status: "MISMATCH", difference: "0.00000001" });
  });
});

describe("portfolio: unavailable, stale, invalid, mock and mismatched quotes", () => {
  const open = async () => { const c = makeCloseCtx(); await c.openBtc(ALICE, 2); return c; };
  const expectUnvalued = async (c: CloseCtx, reason: string) => {
    const p = await c.service.getPortfolio(ALICE);
    const u = cur(p, "USDT");
    expect(p.positions[0]!.valuation).toEqual({ status: "UNVALUED", reason });
    expect(u).toMatchObject({ valuation: "INCOMPLETE", unvaluedPositionCount: 1, markValue: null, unrealizedPnl: null, equity: null });
    expect(u.bookValue).toBe("10000.00000000"); // still computable without quotes
    expect(u.reconciliation.status).toBe("CONSISTENT"); // cash/cost accounting needs no quote
    expect(u.cashBalance).toBe("9799.69990000");
  };

  it("unavailable quote -> QUOTE_UNAVAILABLE, never zero", async () => {
    const c = await open(); c.setQuote(errorView()); await expectUnvalued(c, "QUOTE_UNAVAILABLE");
  });
  it("a facade that throws -> QUOTE_UNAVAILABLE", async () => {
    const c = await open();
    c.deps.marketData.getQuote = async () => { throw new Error("boom"); };
    await expectUnvalued(c, "QUOTE_UNAVAILABLE");
  });
  it("stale by freshness status -> QUOTE_STALE", async () => {
    const c = await open();
    c.setQuote({ ...freshView(quote({ price: 110 })), freshness: { status: "STALE", ageMs: 9e6, label: "stale" } } as never);
    await expectUnvalued(c, "QUOTE_STALE");
  });
  it("stale by asOf age beyond the configured limit even if the facade says FRESH -> QUOTE_STALE", async () => {
    const c = await open(); c.setQuote(freshView(quote({ price: 110, asOf: iso(10 * 60_000) }))); await expectUnvalued(c, "QUOTE_STALE");
  });
  it("future-dated quote -> DATA_INCONSISTENT", async () => {
    const c = await open(); c.setQuote(freshView(quote({ price: 110, asOf: iso(-10 * 60_000) }))); await expectUnvalued(c, "DATA_INCONSISTENT");
  });
  it("mock quote is refused outside development -> MOCK_DATA_NOT_ALLOWED", async () => {
    const c = await open(); c.setQuote(freshView(quote({ price: 110, isMock: true }))); await expectUnvalued(c, "MOCK_DATA_NOT_ALLOWED");
  });
  it("mock quote is accepted only when mock data is allowed, and stays labelled", async () => {
    const c = makeCloseCtx({ deps: { allowMockData: true } });
    c.setQuote(freshView(quote({ price: 100, isMock: true })));
    await c.openBtc(ALICE, 2);
    const v = (await c.service.getPortfolio(ALICE)).positions[0]!.valuation;
    expect(v.status === "VALUED" && v.quote.isMock).toBe(true);
  });
  it("stored (non-provider) quote -> QUOTE_NOT_LIVE", async () => {
    const c = await open(); c.setQuote({ ...freshView(quote({ price: 110 })), servedFrom: "STORE" } as never); await expectUnvalued(c, "QUOTE_NOT_LIVE");
  });
  it("closed market (last close) -> MARKET_CLOSED", async () => {
    const c = await open();
    c.setQuote({ ...freshView(quote({ price: 110 })), freshness: { status: "LAST_CLOSE", ageMs: 1, label: "last close" } } as never);
    await expectUnvalued(c, "MARKET_CLOSED");
  });
  it("wrong symbol / market / currency -> DATA_INCONSISTENT", async () => {
    for (const over of [{ symbol: "ETH" }, { market: "NSE" as const }, { currency: "INR" }]) {
      const c = await open(); c.setQuote(freshView(quote({ price: 110, ...over }))); await expectUnvalued(c, "DATA_INCONSISTENT");
    }
  });
  it("invalid prices (0, negative, NaN, Infinity, absurd) -> DATA_INCONSISTENT, never valued", async () => {
    for (const price of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, 2e9]) {
      const c = await open(); c.setQuote(freshView(quote({ price }))); await expectUnvalued(c, "DATA_INCONSISTENT");
    }
  });
  it("one unpriced position makes that currency's totals null, while the other currency is unaffected", async () => {
    const c = makeCloseCtx();
    await c.openBtc(ALICE, 1);
    c.setQuote(freshView(NSE_QUOTE(2500)));
    await c.service.openTrade(ALICE, { assetId: RELIANCE.id, side: "BUY", quantity: 2 });
    c.deps.marketData.getQuote = async (a) => (a.id === BTC.id ? errorView() : freshView(NSE_QUOTE(2600)));
    const p = await c.service.getPortfolio(ALICE);
    expect(cur(p, "USDT")).toMatchObject({ valuation: "INCOMPLETE", equity: null });
    expect(cur(p, "INR")).toMatchObject({ valuation: "COMPLETE" });
    expect(cur(p, "INR").equity).not.toBeNull();
  });
});

describe("portfolio: authentication, ownership and client authority", () => {
  it("rejects a missing or malformed user id as UNAUTHENTICATED, before any read", async () => {
    const c = makeCloseCtx();
    let reads = 0;
    const real = c.deps.store.getPortfolioSnapshot;
    c.deps.store.getPortfolioSnapshot = (u) => { reads++; return real(u); };
    for (const bad of ["", "not-a-uuid", undefined as never, null as never, 7 as never]) expect(await code(c.service.getPortfolio(bad))).toBe("UNAUTHENTICATED");
    expect(reads).toBe(0);
  });
  it("accepts no client input: balances, prices, fees, P&L, user ids are VALIDATION errors", async () => {
    const c = makeCloseCtx();
    for (const bad of [{ userId: BOB }, { cashBalance: 1e9 }, { price: 1 }, { fee: 0 }, { pnl: 5 }, "x", 5, [], [1]]) {
      expect(await code(c.service.getPortfolio(ALICE, bad))).toBe("VALIDATION");
    }
    await expect(c.service.getPortfolio(ALICE, {})).resolves.toBeDefined();
    await expect(c.service.getPortfolio(ALICE, undefined)).resolves.toBeDefined();
  });
  it("one user's portfolio never includes another user's cash, positions or results", async () => {
    const c = makeCloseCtx();
    const a = await c.openBtc(ALICE, 2);
    c.setPrice(110);
    await c.service.closeTrade(ALICE, { tradeId: a });
    await c.openBtc(ALICE, 1);
    const bob = await c.service.getPortfolio(BOB);
    expect(bob.positions).toEqual([]);
    expect(cur(bob, "USDT")).toMatchObject({ accountExists: false, cashBalance: "10000.00000000", realizedPnl: "0.00000000", closedTradeCount: 0 });
    const alice = await c.service.getPortfolio(ALICE);
    expect(alice.positions).toHaveLength(1);
  });
  it("refuses outright (exposing nothing) if a store ever returns another user's rows", async () => {
    const c = makeCloseCtx();
    await c.openBtc(ALICE, 2);
    const leaky = async (): Promise<PortfolioSnapshot> => {
      const s = await makeLeak(c);
      return s;
    };
    c.deps.store.getPortfolioSnapshot = leaky;
    for (const kind of ["accounts", "openTrades", "results"] as const) {
      leakKind = kind;
      expect(await code(c.service.getPortfolio(ALICE))).toBe("INTERNAL");
    }
  });
  it("wraps a failing snapshot read as INTERNAL without leaking details", async () => {
    const c = makeCloseCtx();
    c.deps.store.getPortfolioSnapshot = async () => { throw new Error("secret connection string"); };
    const e = (await c.service.getPortfolio(ALICE).then(() => null, (x: unknown) => x)) as AppError;
    expect(e.code).toBe("INTERNAL");
    expect(e.message).not.toMatch(/secret/);
  });
  it("is read-only: no open, close, audit or account change", async () => {
    const c = makeCloseCtx();
    await c.openBtc(ALICE, 2);
    const before = JSON.stringify([...c.fs.state.accounts], (_, v) => (typeof v === "bigint" ? v.toString() : v));
    const audits = c.auditCalls.length;
    await c.service.getPortfolio(ALICE);
    expect(JSON.stringify([...c.fs.state.accounts], (_, v) => (typeof v === "bigint" ? v.toString() : v))).toBe(before);
    expect(c.auditCalls).toHaveLength(audits);
    expect(c.fs.state.trades).toHaveLength(1);
  });
});

describe("portfolio: unusable stored records are surfaced, not guessed", () => {
  const withSnapshot = async (mutate: (s: PortfolioSnapshot) => void) => {
    const c = makeCloseCtx();
    await c.openBtc(ALICE, 2);
    const real = c.deps.store.getPortfolioSnapshot;
    c.deps.store.getPortfolioSnapshot = async (u) => { const s = await real(u); mutate(s); return s; };
    return c;
  };
  it("a pre-accounting open trade (no recorded cost) is UNVALUED/POSITION_NOT_VALUABLE and the identity is not claimed", async () => {
    const c = await withSnapshot((s) => { s.openTrades[0]!.cashDebited = null; s.openTrades[0]!.simVersion = null; });
    const p = await c.service.getPortfolio(ALICE);
    expect(p.positions[0]!.valuation).toEqual({ status: "UNVALUED", reason: "POSITION_NOT_VALUABLE" });
    expect(cur(p, "USDT")).toMatchObject({ equity: null, reconciliation: { status: "INCOMPLETE_RECORDS", difference: null } });
  });
  it("an unsupported side is not valued", async () => {
    const c = await withSnapshot((s) => { s.openTrades[0]!.side = "SHORT"; });
    expect((await c.service.getPortfolio(ALICE)).positions[0]!.valuation).toEqual({ status: "UNVALUED", reason: "POSITION_NOT_VALUABLE" });
  });
  it("a trade pointing at the wrong or a missing account is flagged INCOMPLETE_RECORDS", async () => {
    const c = await withSnapshot((s) => { s.openTrades[0]!.accountId = null; });
    expect(cur(await c.service.getPortfolio(ALICE), "USDT").reconciliation.status).toBe("INCOMPLETE_RECORDS");
  });
  it("a result with no attributable account is counted as unattributed", async () => {
    const c = makeCloseCtx();
    const id = await c.openBtc(ALICE, 2);
    await c.service.closeTrade(ALICE, { tradeId: id });
    const real = c.deps.store.getPortfolioSnapshot;
    c.deps.store.getPortfolioSnapshot = async (u) => { const s = await real(u); s.results[0]!.accountId = null; return s; };
    expect((await c.service.getPortfolio(ALICE)).unattributedRecords).toBe(1);
  });
  it("unparsable stored amounts fail loudly (INTERNAL), never as zero", async () => {
    for (const mutate of [
      (s: PortfolioSnapshot) => { s.accounts[0]!.cashBalance = "1e3"; },
      (s: PortfolioSnapshot) => { s.accounts[0]!.startingCash = "abc"; },
    ]) {
      const c = await withSnapshot(mutate);
      expect(await code(c.service.getPortfolio(ALICE))).toBe("INTERNAL");
    }
    const c = makeCloseCtx();
    const id = await c.openBtc(ALICE, 2);
    await c.service.closeTrade(ALICE, { tradeId: id });
    const real = c.deps.store.getPortfolioSnapshot;
    c.deps.store.getPortfolioSnapshot = async (u) => { const s = await real(u); s.results[0]!.pnl = "NaN"; return s; };
    expect(await code(c.service.getPortfolio(ALICE))).toBe("INTERNAL");
  });
});

describe("parseSignedDecimalAmount", () => {
  it("parses signed exact decimals and rejects everything else", () => {
    expect(parseSignedDecimalAmount("-19.37001")).toBe(-1_937_001_000n);
    expect(parseSignedDecimalAmount("19.37001")).toBe(1_937_001_000n);
    expect(parseSignedDecimalAmount("0")).toBe(0n);
    for (const bad of ["+1", "1e3", "--1", "-", "", "NaN", "1.123456789", null, 5, undefined]) expect(parseSignedDecimalAmount(bad)).toBeNull();
  });
  it("uses the configured starting cash for an account that does not exist yet", () => {
    expect(PAPER_SIMULATION.startingCash.USDT).toBe(10_000);
  });
});

// helper state for the leak test (module-scoped so the store closure can read it)
let leakKind: "accounts" | "openTrades" | "results" = "accounts";
async function makeLeak(c: CloseCtx): Promise<PortfolioSnapshot> {
  // Build Alice's real snapshot, then smuggle in one row belonging to Bob.
  const real = makeCloseCtx();
  await real.openBtc(ALICE, 2);
  const id = await real.openBtc(ALICE, 1);
  await real.service.closeTrade(ALICE, { tradeId: id });
  const s = await real.fs.store.getPortfolioSnapshot(ALICE);
  void c;
  if (leakKind === "accounts") s.accounts.push({ ...s.accounts[0]!, userId: BOB });
  if (leakKind === "openTrades") s.openTrades.push({ ...s.openTrades[0]!, userId: BOB });
  if (leakKind === "results") s.results.push({ ...s.results[0]!, userId: BOB });
  return s;
}

describe("portfolio: static guards", () => {
  const src = readFileSync(path.resolve(__dirname, "../../services/paper-trading/portfolio.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  it("does no floating-point arithmetic on money", () => {
    expect(src).not.toMatch(/parseFloat|\bNumber\(|Math\.|\bparseInt\(/);
  });
  it("is read-only: no writes, RPCs, network or database access", () => {
    expect(src).not.toMatch(/\.rpc\(|\.insert\(|\.update\(|\.delete\(|\.upsert\(|\bfetch\(|createSupabase|lib\/supabase|deps\.audit|\.openTrade\(|\.closeTrade\(/);
  });
});
