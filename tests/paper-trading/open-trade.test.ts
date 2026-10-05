import { describe, expect, it } from "vitest";
import { PAPER_SIMULATION, parsePaperSimulationConfig } from "@/config/paper-trading";
import { AppError } from "@/lib/errors";
import { PaperTradeRejectedError } from "@/services/paper-trading/errors";
import { createPaperTradingService } from "@/services/paper-trading/paper-trading-service";
import {
  ALICE, BOB, BTC, BTC_ID, KEY, NIFTY_ID, nextKey, NOW, RELIANCE_ID, errorView, fakeStore, freshView, makeDeps, quote,
} from "./open-helpers";

const open = (userId: string, input: unknown, over: Parameters<typeof makeDeps>[0] = {}) => {
  const ctx = makeDeps(over);
  return { ctx, run: () => createPaperTradingService(ctx.deps).openTrade(userId, input) };
};
const valid = { assetId: BTC_ID, side: "BUY", quantity: 2, idempotencyKey: KEY };
const rejected = async (p: Promise<unknown>) => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(PaperTradeRejectedError);
  return (e as PaperTradeRejectedError).reason;
};
/** Nothing was created, debited or audited (the store may still have been asked and refused). */
const noEffect = (c: ReturnType<typeof makeDeps>) => {
  expect(c.fs.state.trades).toHaveLength(0);
  expect(c.fs.state.accounts.size).toBe(0);
  expect(c.auditCalls).toHaveLength(0);
};
/** Stronger: the request never even reached the store (rejected before any I/O). */
const untouched = (c: ReturnType<typeof makeDeps>) => {
  expect(c.fs.calls).toHaveLength(0);
  noEffect(c);
};

describe("open paper trade: authentication", () => {
  it.each(["", "   ", "not-a-uuid", "undefined", "1; drop table paper_trades"])("rejects an unauthenticated/invalid user id %j", async (id) => {
    const { ctx, run } = open(id, valid);
    await expect(run()).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(ctx.quoteCalls).toHaveLength(0);
    untouched(ctx);
  });
  it.each([undefined, null, 42, {}])("rejects a non-string user id (%j)", async (id) => {
    const { ctx, run } = open(id as unknown as string, valid);
    await expect(run()).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    untouched(ctx);
  });
});

describe("open paper trade: the client cannot supply server-controlled fields", () => {
  it.each([
    ["user id", { userId: BOB }],
    ["user_id", { user_id: BOB }],
    ["execution price", { price: 1 }],
    ["entry price", { entryPrice: 1 }],
    ["entry_price", { entry_price: 1 }],
    ["execution price (alt name)", { executionPrice: 1 }],
    ["reference price", { referencePrice: 1 }],
    ["fees", { fees: 0 }],
    ["fee", { fee: 0 }],
    ["feeBps", { feeBps: 0 }],
    ["slippage", { slippage: 0 }],
    ["slippageBps", { slippageBps: 0 }],
    ["timestamp", { timestamp: "2020-01-01T00:00:00Z" }],
    ["openedAt", { openedAt: "2020-01-01T00:00:00Z" }],
    ["opened_at", { opened_at: "2020-01-01T00:00:00Z" }],
    ["executedAt", { executedAt: "2020-01-01T00:00:00Z" }],
    ["cash", { cash: 1e9 }],
    ["balance", { balance: 1e9 }],
    ["cashBalance", { cashBalance: 1e9 }],
    ["startingCash", { startingCash: 1e12 }],
    ["pnl", { pnl: 1e6 }],
    ["status", { status: "CLOSED" }],
    ["account id", { accountId: ALICE }],
    ["stop loss", { stopLoss: 1 }],
    ["quote", { quote: { price: 1 } }],
  ])("rejects a supplied %s and does nothing", async (_n, extra) => {
    const { ctx, run } = open(ALICE, { ...valid, ...extra });
    await expect(run()).rejects.toMatchObject({ code: "VALIDATION" });
    expect(ctx.quoteCalls).toHaveLength(0);
    untouched(ctx);
  });

  it("uses the verified session user for the trade even when the payload names someone else", async () => {
    const { ctx, run } = open(BOB, { ...valid, userId: ALICE });
    await expect(run()).rejects.toMatchObject({ code: "VALIDATION" });
    untouched(ctx);
    const ok = open(BOB, valid);
    await ok.run();
    expect(ok.ctx.fs.calls.map((c) => c.userId)).toEqual([BOB]);
  });

  it.each([null, undefined, "x", 5, [], [valid]])("rejects a non-object payload %j", async (payload) => {
    const { ctx, run } = open(ALICE, payload);
    await expect(run()).rejects.toMatchObject({ code: "VALIDATION" });
    untouched(ctx);
  });
});

describe("open paper trade: input validation", () => {
  it.each([
    ["missing asset", { side: "BUY", quantity: 1 }],
    ["bad asset id", { assetId: "nope", side: "BUY", quantity: 1 }],
    ["missing side", { assetId: BTC_ID, quantity: 1 }],
    ["unknown side", { assetId: BTC_ID, side: "HODL", quantity: 1 }],
    ["lowercase side", { assetId: BTC_ID, side: "buy", quantity: 1 }],
    ["missing quantity", { assetId: BTC_ID, side: "BUY" }],
    ["zero quantity", { assetId: BTC_ID, side: "BUY", quantity: 0 }],
    ["negative quantity", { assetId: BTC_ID, side: "BUY", quantity: -1 }],
    ["NaN quantity", { assetId: BTC_ID, side: "BUY", quantity: NaN }],
    ["Infinity quantity", { assetId: BTC_ID, side: "BUY", quantity: Infinity }],
    ["text quantity", { assetId: BTC_ID, side: "BUY", quantity: "lots" }],
    ["9-decimal quantity", { assetId: BTC_ID, side: "BUY", quantity: "0.123456789" }],
    ["exponent quantity", { assetId: BTC_ID, side: "BUY", quantity: "1e3" }],
  ])("rejects %s before any market data is fetched", async (_n, input) => {
    const { ctx, run } = open(ALICE, input);
    await expect(run()).rejects.toMatchObject({ code: "VALIDATION" });
    expect(ctx.quoteCalls).toHaveLength(0);
    untouched(ctx);
  });

  it("rejects SELL and SHORT (no margin/borrow accounting is invented) before fetching a price", async () => {
    for (const side of ["SELL", "SHORT"]) {
      const { ctx, run } = open(ALICE, { ...valid, side });
      expect(await rejected(run())).toBe("SIDE_NOT_SUPPORTED");
      expect(ctx.quoteCalls).toHaveLength(0);
      untouched(ctx);
    }
  });

  it("rejects an unknown asset and a direct index instrument", async () => {
    const a = open(ALICE, { ...valid, assetId: "eeeeeeee-0000-4000-8000-000000000009" });
    expect(await rejected(a.run())).toBe("ASSET_NOT_FOUND");
    expect(a.ctx.quoteCalls).toHaveLength(0);
    const i = open(ALICE, { ...valid, assetId: NIFTY_ID });
    expect(await rejected(i.run())).toBe("ASSET_NOT_TRADABLE");
    expect(i.ctx.quoteCalls).toHaveLength(0);
    untouched(a.ctx); untouched(i.ctx);
  });

  it("equities trade in whole units; crypto may be fractional", async () => {
    const eq = open(ALICE, { assetId: RELIANCE_ID, side: "BUY", quantity: 1.5, idempotencyKey: KEY }, { quoteView: freshView(quote({ market: "NSE", symbol: "RELIANCE", currency: "INR", price: 2500 })) });
    expect(await rejected(eq.run())).toBe("INVALID_QUANTITY");
    untouched(eq.ctx);
    const cr = open(ALICE, { ...valid, quantity: "0.00000001" });
    expect((await cr.run()).quantity).toBe(0.00000001);
  });

  it("enforces the configured maximum quantity", async () => {
    const { ctx, run } = open(ALICE, { ...valid, quantity: 2_000_000_000 });
    expect(await rejected(run())).toBe("INVALID_QUANTITY");
    untouched(ctx);
  });
});

describe("open paper trade: market data gating (nothing is created or debited)", () => {
  const stale = (over: object) => ({ ok: true as const, servedFrom: "PROVIDER" as const, freshness: { status: "FRESH" as const, ageMs: 0, label: "" }, data: quote(), ...over });

  it("rejects when the quote is unavailable", async () => {
    const { ctx, run } = open(ALICE, valid, { quoteView: errorView() });
    expect(await rejected(run())).toBe("QUOTE_UNAVAILABLE");
    expect(ctx.quoteCalls).toHaveLength(1);
    untouched(ctx);
  });
  it("maps data-unavailable rejections to the existing PROVIDER_UNAVAILABLE error code", async () => {
    const { run } = open(ALICE, valid, { quoteView: errorView() });
    await expect(run()).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });
  it("rejects a quote the facade flags STALE", async () => {
    const { ctx, run } = open(ALICE, valid, { quoteView: stale({ freshness: { status: "STALE", ageMs: 9e9, label: "" } }) });
    expect(await rejected(run())).toBe("QUOTE_STALE");
    untouched(ctx);
  });
  it("rejects a quote older than the configured max age even if the facade says FRESH", async () => {
    const old = quote({ asOf: new Date(NOW.getTime() - 5 * 60_000).toISOString() });
    const { ctx, run } = open(ALICE, valid, { quoteView: stale({ data: old }) });
    expect(await rejected(run())).toBe("QUOTE_STALE");
    untouched(ctx);
  });
  it("accepts a quote exactly at the age limit and rejects one millisecond beyond it", async () => {
    const at = (ms: number) => stale({ data: quote({ asOf: new Date(NOW.getTime() - ms).toISOString() }) });
    await expect(open(ALICE, valid, { quoteView: at(120_000) }).run()).resolves.toBeDefined();
    expect(await rejected(open(ALICE, valid, { quoteView: at(120_001) }).run())).toBe("QUOTE_STALE");
  });
  it("rejects a quote stamped in the future", async () => {
    const future = quote({ asOf: new Date(NOW.getTime() + 10 * 60_000).toISOString() });
    const { ctx, run } = open(ALICE, valid, { quoteView: stale({ data: future }) });
    expect(await rejected(run())).toBe("DATA_INCONSISTENT");
    untouched(ctx);
  });
  it("rejects a stored (non-live) quote and a closed market", async () => {
    const a = open(ALICE, valid, { quoteView: stale({ servedFrom: "STORE" }) });
    expect(await rejected(a.run())).toBe("QUOTE_NOT_LIVE");
    const b = open(ALICE, valid, { quoteView: stale({ freshness: { status: "LAST_CLOSE", ageMs: 1, label: "" } }) });
    expect(await rejected(b.run())).toBe("MARKET_CLOSED");
    untouched(a.ctx); untouched(b.ctx);
  });
  it("rejects mock data outside development, and allows it only when explicitly permitted", async () => {
    const mock = freshView(quote({ isMock: true, source: "mock" }));
    const prod = open(ALICE, valid, { quoteView: mock, allowMockData: false });
    expect(await rejected(prod.run())).toBe("MOCK_DATA_NOT_ALLOWED");
    untouched(prod.ctx);
    const dev = open(ALICE, valid, { quoteView: mock, allowMockData: true });
    const res = await dev.run();
    expect(res.quote.isMock).toBe(true); // recorded, never hidden
  });
  it.each([
    ["wrong symbol", { symbol: "ETH" }],
    ["wrong market", { market: "NSE" as const }],
    ["wrong currency", { currency: "INR" }],
    ["zero price", { price: 0 }],
    ["negative price", { price: -5 }],
    ["NaN price", { price: NaN }],
    ["absurd price", { price: 5e9 }],
  ])("rejects an inconsistent quote: %s", async (_n, over) => {
    const { ctx, run } = open(ALICE, valid, { quoteView: freshView(quote(over)) });
    expect(await rejected(run())).toBe("DATA_INCONSISTENT");
    untouched(ctx);
  });
  it("gets prices only through the injected market-data facade, once per trade", async () => {
    const { ctx, run } = open(ALICE, valid);
    await run();
    expect(ctx.quoteCalls).toEqual([BTC]);
  });
});

describe("open paper trade: a valid trade", () => {
  it("fills at a server-computed price with config-driven slippage and fee", async () => {
    const { ctx, run } = open(ALICE, valid);
    const t = await run();
    expect(t).toMatchObject({
      assetId: BTC_ID, side: "BUY", status: "OPEN", quantity: 2,
      referencePrice: 100, entryPrice: 100.05, notional: 200.1, fee: 0.2001, cashDebited: 200.3001,
      currency: "USDT", cashBalanceAfter: 9799.6999,
      simulation: { version: "PAPER_SIM_V1", slippageBps: 5, feeBps: 10 },
      openedAt: NOW.toISOString(), banner: "PAPER TRADING — NO REAL MONEY",
    });
    expect(t.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(ctx.fs.state.trades).toHaveLength(1);
  });

  it("passes the store exact decimal strings and the quote provenance, with identity from the session", async () => {
    const q = quote({ source: "binance-public", asOf: "2026-10-01T09:59:55.000Z", fetchedAt: "2026-10-01T09:59:56.000Z" });
    const { ctx, run } = open(ALICE, { ...valid, side: "LONG", quantity: "2" }, { quoteView: freshView(q) });
    await run();
    expect(ctx.fs.calls).toEqual([{
      userId: ALICE, assetId: BTC_ID, side: "LONG", quantity: "2.00000000",
      entryPrice: "100.05000000", fee: "0.20010000", startingCash: "10000",
      simVersion: "PAPER_SIM_V1", referencePrice: "100.00000000", slippageBps: "5.000", feeBps: "10.000",
      quote: { source: "binance-public", asOf: "2026-10-01T09:59:55.000Z", fetchedAt: "2026-10-01T09:59:56.000Z", isMock: false },
      idempotencyKey: KEY,
    }]);
  });

  it("the execution price is the server's, not the quote price and not anything the client could say", async () => {
    const { run } = open(ALICE, valid);
    const t = await run();
    expect(t.entryPrice).not.toBe(100);
    expect(t.entryPrice).toBe(t.referencePrice * 1.0005);
  });

  it("uses the injected simulation config, not hard-coded values", async () => {
    const custom = parsePaperSimulationConfig({
      version: "TEST_SIM", startingCash: { INR: 1000, USDT: 500 },
      markets: { CRYPTO: { feeBps: 100, slippageBps: 200 }, NSE: { feeBps: 0, slippageBps: 0 }, BSE: { feeBps: 0, slippageBps: 0 } },
    });
    const { ctx, run } = open(ALICE, { ...valid, quantity: 1 }, { config: custom });
    const t = await run();
    expect(t).toMatchObject({ entryPrice: 102, fee: 1.02, cashDebited: 103.02, cashBalanceAfter: 396.98, simulation: { version: "TEST_SIM", slippageBps: 200, feeBps: 100 } });
    expect(ctx.fs.calls[0]!.startingCash).toBe("500");
  });

  it("opens an NSE equity in INR under its own market's assumptions", async () => {
    const { run } = open(ALICE, { assetId: RELIANCE_ID, side: "BUY", quantity: 3, idempotencyKey: KEY }, { quoteView: freshView(quote({ market: "NSE", symbol: "RELIANCE", currency: "INR", price: 2500.5 })) });
    expect(await run()).toMatchObject({ currency: "INR", entryPrice: 2501.75025, notional: 7505.25075, fee: 3.75262538, cashBalanceAfter: 1_000_000 - 7509.00337538 });
  });

  it("writes one audit record after the commit and never fails the trade if auditing fails", async () => {
    const { ctx, run } = open(ALICE, valid);
    const t = await run();
    expect(ctx.auditCalls).toEqual([expect.objectContaining({ actorId: ALICE, action: "paper_trade.opened", entityType: "paper_trade", entityId: t.id })]);
    const broken = open(ALICE, valid, { audit: async () => { throw new Error("audit down"); } });
    await expect(broken.run()).resolves.toMatchObject({ status: "OPEN" });
    expect(broken.ctx.fs.state.trades).toHaveLength(1);
  });

  it("a second trade draws on the reduced balance", async () => {
    const ctx = makeDeps();
    const svc = createPaperTradingService(ctx.deps);
    await svc.openTrade(ALICE, valid);
    const second = await svc.openTrade(ALICE, { ...valid, idempotencyKey: nextKey() }); // a NEW intent
    expect(second.cashBalanceAfter).toBeCloseTo(10000 - 2 * 200.3001, 8);
  });
});

describe("open paper trade: paper cash", () => {
  it("rejects an unaffordable trade (fees included) and leaves everything untouched", async () => {
    const { ctx, run } = open(ALICE, { ...valid, quantity: 100 }); // 100 * 100.05 + fee > 10,000
    expect(await rejected(run())).toBe("INSUFFICIENT_PAPER_CASH");
    expect(ctx.fs.state.trades).toHaveLength(0);
    expect(ctx.fs.state.accounts.size).toBe(0);
    expect(ctx.auditCalls).toHaveLength(0);
  });

  it("the fee counts: a trade whose notional fits but notional + fee does not is rejected", async () => {
    // notional 9,999.50 would fit in 10,000; the 0.1% fee (~10) pushes it over.
    const cfg = parsePaperSimulationConfig({
      version: "T", startingCash: { INR: 1000, USDT: 10_000 },
      markets: { CRYPTO: { feeBps: 10, slippageBps: 0 }, NSE: { feeBps: 0, slippageBps: 0 }, BSE: { feeBps: 0, slippageBps: 0 } },
    });
    const { ctx, run } = open(ALICE, { ...valid, quantity: 99.995 }, { config: cfg });
    expect(await rejected(run())).toBe("INSUFFICIENT_PAPER_CASH");
    noEffect(ctx);
  });

  it("allows spending exactly the balance but not one unit (1e-8) more", async () => {
    const cfg = parsePaperSimulationConfig({
      version: "T", startingCash: { INR: 1000, USDT: 200.3001 },
      markets: { CRYPTO: { feeBps: 10, slippageBps: 5 }, NSE: { feeBps: 0, slippageBps: 0 }, BSE: { feeBps: 0, slippageBps: 0 } },
    });
    const exact = open(ALICE, valid, { config: cfg });
    expect(await exact.run()).toMatchObject({ cashDebited: 200.3001, cashBalanceAfter: 0 });
    const over = open(ALICE, { ...valid, quantity: "2.00000001" }, { config: cfg });
    expect(await rejected(over.run())).toBe("INSUFFICIENT_PAPER_CASH");
    noEffect(over.ctx);
  });

  it("there is no input that creates money: cash comes only from the server-side config", async () => {
    const { ctx, run } = open(ALICE, { ...valid, quantity: 100, cash: 1e12, balance: 1e12, startingCash: 1e12, deposit: 1e12 });
    await expect(run()).rejects.toMatchObject({ code: "VALIDATION" });
    untouched(ctx);
    const ok = open(ALICE, valid);
    await ok.run();
    expect(ok.ctx.fs.calls[0]!.startingCash).toBe(String(PAPER_SIMULATION.startingCash.USDT));
  });
});

describe("open paper trade: users are isolated", () => {
  it("each user has their own account; one user's trades never touch another's cash", async () => {
    const ctx = makeDeps();
    const svc = createPaperTradingService(ctx.deps);
    await svc.openTrade(ALICE, valid);
    const bob = await svc.openTrade(BOB, valid);
    expect(bob.cashBalanceAfter).toBe(9799.6999); // untouched starting cash minus only Bob's own cost
    expect(ctx.fs.state.accounts.get(`${ALICE}:USDT`)!.balance).toBe(979_969_990_000n);
    expect(ctx.fs.state.trades.map((t) => t.userId)).toEqual([ALICE, BOB]);
  });

  it("a failed or rejected attempt by one user cannot affect another user's balance", async () => {
    const ctx = makeDeps();
    const svc = createPaperTradingService(ctx.deps);
    await svc.openTrade(ALICE, valid);
    const before = ctx.fs.state.accounts.get(`${ALICE}:USDT`)!.balance;
    await expect(svc.openTrade(BOB, { ...valid, quantity: 100 })).rejects.toBeInstanceOf(PaperTradeRejectedError);
    await expect(svc.openTrade(BOB, { ...valid, userId: ALICE })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(ctx.fs.state.accounts.get(`${ALICE}:USDT`)!.balance).toBe(before);
    expect(ctx.fs.state.trades.filter((t) => t.userId === ALICE)).toHaveLength(1);
    expect(ctx.fs.state.trades.filter((t) => t.userId === BOB)).toHaveLength(0);
  });

  it("the service exposes no method that accepts a different user's account or trade", () => {
    const s = createPaperTradingService(makeDeps().deps);
    // 5C-5 added two READ-ONLY helpers for the UI: an open-cost estimate and the closed-trade history.
    expect(Object.keys(s).sort()).toEqual(["closeTrade", "getClosedTrades", "getPortfolio", "getSimulationAssumptions", "openTrade", "previewOpenTrade"]);
    expect(s.previewOpenTrade.length).toBe(2); // (verified userId, untrusted input): no account id, no price
    expect(s.getClosedTrades.length).toBe(2); // (verified userId, input that must be empty)
    expect(s.openTrade.length).toBe(2); // (verified userId, untrusted input): no account id, no price
    expect(s.closeTrade.length).toBe(2); // (verified userId, untrusted { tradeId }): no price, fee or P&L
  });
});

describe("open paper trade: atomic failure behaviour", () => {
  it("if the database call fails, nothing is debited, created or audited, and no internals leak", async () => {
    const failing = fakeStore([BTC], { failInsert: true });
    const { ctx, run } = open(ALICE, valid, { store: failing.store });
    const err = await run().then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("INTERNAL");
    expect((err as AppError).message).not.toMatch(/insert failed|sql|postgres/i);
    expect(failing.state.trades).toHaveLength(0);
    expect(failing.state.accounts.size).toBe(0); // the debit was rolled back with the failed insert
    expect(ctx.auditCalls).toHaveLength(0);
  });

  it("a failure after earlier successes leaves the earlier balance exactly as it was", async () => {
    let fail = false;
    const base = fakeStore([BTC]);
    const store = { ...base.store, openTrade: async (p: Parameters<typeof base.store.openTrade>[0]) => { if (fail) throw new Error("boom"); return base.store.openTrade(p); } };
    const ctx = makeDeps({ store });
    const svc = createPaperTradingService(ctx.deps);
    await svc.openTrade(ALICE, valid);
    const balance = base.state.accounts.get(`${ALICE}:USDT`)!.balance;
    fail = true;
    await expect(svc.openTrade(ALICE, valid)).rejects.toMatchObject({ code: "INTERNAL" });
    expect(base.state.accounts.get(`${ALICE}:USDT`)!.balance).toBe(balance);
    expect(base.state.trades).toHaveLength(1);
  });

  it("a business rejection from the store (asset vanished) is reported as a rejection, not a crash", async () => {
    const base = fakeStore([BTC]);
    const store = { ...base.store, openTrade: async () => ({ ok: false as const, reason: "ASSET_NOT_FOUND" as const }) };
    const { run } = open(ALICE, valid, { store });
    expect(await rejected(run())).toBe("ASSET_NOT_FOUND");
  });
});

describe("simulation labelling", () => {
  it("every result carries the simulation-only banner and records the assumptions version", async () => {
    const t = await open(ALICE, valid).run();
    expect(t.banner).toBe("PAPER TRADING — NO REAL MONEY");
    expect(t.simulation.version).toBe(PAPER_SIMULATION.version);
  });
});
