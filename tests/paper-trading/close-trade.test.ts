import { describe, expect, it } from "vitest";
import { PAPER_SIMULATION, parsePaperSimulationConfig } from "@/config/paper-trading";
import { AppError } from "@/lib/errors";
import { simulateLongExit, realizedLongPnl } from "@/services/paper-trading/execution";
import { PaperTradeRejectedError } from "@/services/paper-trading/errors";
import { formatSignedScaled, parseQuantity, priceToScaled } from "@/services/paper-trading/money";
import {
  ALICE, BOB, BTC, BTC_ID, NIFTY, RELIANCE, RELIANCE_ID, errorView, freshView, fmt8, quote,
} from "./open-helpers";
import { NSE_QUOTE, NOW, makeCloseCtx, type CloseCtx } from "./close-helpers";

const rejected = async (p: Promise<unknown>) => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(PaperTradeRejectedError);
  return (e as PaperTradeRejectedError).reason;
};
const balance = (c: CloseCtx, user = ALICE, cur = "USDT") => c.fs.state.accounts.get(`${user}:${cur}`)!.balance;
const tradeOf = (c: CloseCtx, id: string) => c.fs.state.trades.find((t) => t.id === id)!;

/** Nothing about the trade or the account changed, and the close never reached the database call. */
const untouchedBy = (c: CloseCtx, id: string, before: bigint) => {
  expect(tradeOf(c, id).status).toBe("OPEN");
  expect(balance(c)).toBe(before);
  expect(c.fs.state.results).toHaveLength(0);
  expect(c.fs.closeCalls).toHaveLength(0);
  expect(c.auditCalls.filter((a) => (a as { action: string }).action === "paper_trade.closed")).toHaveLength(0);
};

// Expected figures below were derived independently with Decimal arithmetic (half-up, 8 dp):
// BTC 2 @ 100, entry 5 bp slippage + 10 bp fee => entry 100.05, notional 200.10, fee 0.2001, cost 200.3001.
describe("close paper trade: realized P&L", () => {
  it("a profitable close: exits below the quote (adverse slippage), charges an exit fee, credits the account", async () => {
    const c = makeCloseCtx();
    const id = await c.openBtc();
    c.setPrice(110);
    const r = await c.service.closeTrade(ALICE, { tradeId: id });
    expect(r).toMatchObject({
      id, assetId: BTC_ID, side: "BUY", status: "CLOSED", quantity: 2,
      referencePrice: 110, exitPrice: 109.945, grossProceeds: 219.89, exitFee: 0.21989,
      cashCredited: 219.67011, realizedPnl: 19.37001, currency: "USDT", cashBalanceAfter: 10019.37001,
      simulation: { version: "PAPER_SIM_V1", slippageBps: 5, feeBps: 10 },
      closedAt: NOW.toISOString(), banner: "PAPER TRADING — NO REAL MONEY",
    });
    expect(r.exitPrice).toBeLessThan(r.referencePrice); // adverse for a sell
    expect(tradeOf(c, id).status).toBe("CLOSED");
    expect(c.fs.state.results).toHaveLength(1);
    expect(balance(c)).toBe(1_001_937_001_000n);
  });

  it("a losing close: P&L is negative and the account is credited less than it was debited", async () => {
    const c = makeCloseCtx();
    const id = await c.openBtc();
    c.setPrice(90);
    const r = await c.service.closeTrade(ALICE, { tradeId: id });
    expect(r).toMatchObject({ exitPrice: 89.955, grossProceeds: 179.91, exitFee: 0.17991, cashCredited: 179.73009, realizedPnl: -20.57001, cashBalanceAfter: 9979.42999 });
    expect(r.realizedPnl).toBeLessThan(0);
    expect(balance(c)).toBe(997_942_999_000n);
  });

  it("an unchanged market price still loses the round-trip friction (slippage + both fees): -0.60", async () => {
    const c = makeCloseCtx();
    const id = await c.openBtc();
    const r = await c.service.closeTrade(ALICE, { tradeId: id }); // quote still 100
    expect(r).toMatchObject({ exitPrice: 99.95, exitFee: 0.1999, cashCredited: 199.7001, realizedPnl: -0.6, cashBalanceAfter: 9999.4 });
  });

  it("the account identity holds: balance = starting cash + realized P&L (nothing is created or lost)", async () => {
    const c = makeCloseCtx();
    const a = await c.openBtc();
    c.setPrice(110);
    const ra = await c.service.closeTrade(ALICE, { tradeId: a });
    c.setPrice(100);
    const b = await c.openBtc(ALICE, 1);
    c.setPrice(90);
    const rb = await c.service.closeTrade(ALICE, { tradeId: b });
    const pnlUnits = c.fs.state.results.reduce((s, x) => s + x.pnlUnits, 0n);
    expect(balance(c)).toBe(1_000_000_000_000n + pnlUnits);
    expect(ra.realizedPnl + rb.realizedPnl).toBeCloseTo(19.37001 + -10.285005, 8);
  });

  it("an NSE equity closes in INR under NSE's own assumptions", async () => {
    const c = makeCloseCtx();
    c.setQuote(freshView(NSE_QUOTE(2500.5)));
    const id = (await c.service.openTrade(ALICE, { assetId: RELIANCE_ID, side: "LONG", quantity: 3 })).id;
    c.setQuote(freshView(NSE_QUOTE(2600.5)));
    const r = await c.service.closeTrade(ALICE, { tradeId: id });
    expect(r).toMatchObject({
      side: "LONG", currency: "INR", exitPrice: 2599.19975, grossProceeds: 7797.59925, exitFee: 3.89879963,
      cashCredited: 7793.70045037, realizedPnl: 284.69707499, cashBalanceAfter: 1000284.69707499,
    });
  });

  it("the exit uses the INJECTED config (rates and version), not hard-coded values", async () => {
    const custom = parsePaperSimulationConfig({
      version: "TEST_SIM", startingCash: { INR: 1000, USDT: 500 },
      markets: { CRYPTO: { feeBps: 100, slippageBps: 200 }, NSE: { feeBps: 0, slippageBps: 0 }, BSE: { feeBps: 0, slippageBps: 0 } },
    });
    const c = makeCloseCtx({ deps: { config: custom } });
    const id = await c.openBtc(ALICE, 1); // entry 102, fee 1.02, cost 103.02
    const r = await c.service.closeTrade(ALICE, { tradeId: id });
    expect(r).toMatchObject({ exitPrice: 98, grossProceeds: 98, exitFee: 0.98, cashCredited: 97.02, realizedPnl: -6, cashBalanceAfter: 494, simulation: { version: "TEST_SIM", slippageBps: 200, feeBps: 100 } });
    expect(c.fs.closeCalls[0]).toMatchObject({ simVersion: "TEST_SIM", slippageBps: "200.000", feeBps: "100.000" });
  });

  it("passes the store exact decimal strings (signed P&L included) and the exit-quote provenance", async () => {
    const c = makeCloseCtx();
    const id = await c.openBtc();
    c.setQuote(freshView(quote({ price: 90, source: "binance-public", asOf: "2026-10-01T09:59:55.000Z", fetchedAt: "2026-10-01T09:59:56.000Z" })));
    await c.service.closeTrade(ALICE, { tradeId: id });
    expect(c.fs.closeCalls).toEqual([{
      userId: ALICE, tradeId: id, exitPrice: "89.95500000", fee: "0.17991000", pnl: "-20.57001000",
      simVersion: "PAPER_SIM_V1", referencePrice: "90.00000000", slippageBps: "5.000", feeBps: "10.000",
      quote: { source: "binance-public", asOf: "2026-10-01T09:59:55.000Z", fetchedAt: "2026-10-01T09:59:56.000Z", isMock: false },
    }]);
  });

  it("the recorded result carries the EXIT fee only; the entry fee stays on the entry record", async () => {
    const c = makeCloseCtx();
    const id = await c.openBtc();
    c.setPrice(110);
    await c.service.closeTrade(ALICE, { tradeId: id });
    expect(c.fs.state.results[0]!.fee).toBe("0.21989000");
    expect(tradeOf(c, id).fee).toBe("0.20010000"); // entry fee, untouched
  });
});

describe("simulateLongExit / realizedLongPnl (pure fixed-point)", () => {
  const rates = PAPER_SIMULATION.markets.CRYPTO;
  const exit = (price: number, qty: number | string) =>
    simulateLongExit({ referencePrice: priceToScaled(price)!, quantity: parseQuantity(qty)!, rates });

  it("slippage is adverse for a sell: the fill is never above the reference price", () => {
    for (const price of [0.00000123, 1, 99.99, 67321.55, 250_000]) {
      const f = exit(price, 1);
      expect(f.executionPrice).toBeLessThanOrEqual(f.referencePrice);
    }
  });
  it("rounds half-up exactly: 100.01 x 3 -> price 99.95999500, gross 299.87998500, fee 0.29987999", () => {
    const f = exit(100.01, 3);
    expect([f.executionPrice, f.grossProceeds, f.fee, f.cashCredited].map((x) => fmt8(x))).toEqual([
      "99.95999500", "299.87998500", "0.29987999", "299.58010501",
    ]);
  });
  it("cashCredited = gross - fee, and P&L is a signed integer difference (no float drift)", () => {
    const f = exit(110, 2);
    expect(f.cashCredited).toBe(f.grossProceeds - f.fee);
    const pnl = realizedLongPnl({ cashCredited: f.cashCredited, cashDebited: 20_030_010_000n });
    expect(formatSignedScaled(pnl)).toBe("19.37001000");
    expect(formatSignedScaled(realizedLongPnl({ cashCredited: 1n, cashDebited: 2n }))).toBe("-0.00000001");
    expect(formatSignedScaled(0n)).toBe("0.00000000");
  });
  it("refuses a slippage of 100% or more (it would price the exit at zero or below)", () => {
    expect(() => simulateLongExit({ referencePrice: 1n, quantity: 1n, rates: { feeBps: 0, slippageBps: 10_000 } })).toThrow(RangeError);
  });
});

describe("close paper trade: authentication", () => {
  it.each(["", "   ", "not-a-uuid", "undefined", "1; drop table paper_trades"])("rejects an unauthenticated/invalid user id %j", async (uid) => {
    const c = makeCloseCtx();
    const id = await c.openBtc();
    c.quoteCalls.length = 0;
    await expect(c.service.closeTrade(uid, { tradeId: id })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(c.fs.lookups).toHaveLength(0);
    expect(c.quoteCalls).toHaveLength(0);
    expect(c.fs.closeCalls).toHaveLength(0);
    expect(tradeOf(c, id).status).toBe("OPEN");
  });
  it.each([undefined, null, 42, {}])("rejects a non-string user id (%j)", async (uid) => {
    const c = makeCloseCtx();
    const id = await c.openBtc();
    await expect(c.service.closeTrade(uid as unknown as string, { tradeId: id })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(c.fs.closeCalls).toHaveLength(0);
  });
});

describe("close paper trade: the client cannot supply server-controlled fields", () => {
  it.each([
    ["exit price", { exitPrice: 1e9 }], ["exit_price", { exit_price: 1e9 }], ["price", { price: 1e9 }],
    ["executionPrice", { executionPrice: 1e9 }], ["referencePrice", { referencePrice: 1e9 }],
    ["fee", { fee: 0 }], ["fees", { fees: 0 }], ["exitFee", { exitFee: 0 }], ["feeBps", { feeBps: 0 }],
    ["slippage", { slippage: 0 }], ["slippageBps", { slippageBps: 0 }],
    ["pnl", { pnl: 1e9 }], ["realizedPnl", { realizedPnl: 1e9 }], ["cashCredited", { cashCredited: 1e9 }],
    ["timestamp", { timestamp: "2020-01-01T00:00:00Z" }], ["closedAt", { closedAt: "2020-01-01T00:00:00Z" }],
    ["closed_at", { closed_at: "2020-01-01T00:00:00Z" }], ["openedAt", { openedAt: "2020-01-01T00:00:00Z" }],
    ["userId", { userId: BOB }], ["user_id", { user_id: BOB }], ["accountId", { accountId: BOB }],
    ["status", { status: "CLOSED" }], ["side", { side: "SHORT" }], ["quantity", { quantity: 1 }],
    ["assetId", { assetId: BTC_ID }], ["cash", { cash: 1e9 }], ["balance", { balance: 1e9 }],
    ["quote", { quote: { price: 1e9 } }], ["partial close fraction", { fraction: 0.5 }],
  ])("rejects a supplied %s and changes nothing", async (_n, extra) => {
    const c = makeCloseCtx();
    const id = await c.openBtc();
    const before = balance(c);
    c.quoteCalls.length = 0;
    await expect(c.service.closeTrade(ALICE, { tradeId: id, ...extra })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(c.fs.lookups).toHaveLength(0); // rejected before ANY I/O
    expect(c.quoteCalls).toHaveLength(0);
    untouchedBy(c, id, before);
  });

  it.each([null, undefined, "x", 5, [], [{}]])("rejects a non-object payload %j", async (payload) => {
    const c = makeCloseCtx();
    const id = await c.openBtc();
    await expect(c.service.closeTrade(ALICE, payload)).rejects.toMatchObject({ code: "VALIDATION" });
    expect(c.fs.lookups).toHaveLength(0);
    expect(tradeOf(c, id).status).toBe("OPEN");
  });

  it.each([{}, { tradeId: "nope" }, { tradeId: 7 }, { tradeId: null }, { tradeId: "" }])("rejects a missing/invalid trade id %j", async (input) => {
    const c = makeCloseCtx();
    await c.openBtc();
    await expect(c.service.closeTrade(ALICE, input)).rejects.toMatchObject({ code: "VALIDATION" });
    expect(c.fs.lookups).toHaveLength(0);
    expect(c.quoteCalls.length).toBe(1); // only the earlier open's quote
  });

  it("the exit price comes from the server's quote, never from anything in the payload", async () => {
    const c = makeCloseCtx();
    const id = await c.openBtc();
    c.setPrice(110);
    const r = await c.service.closeTrade(ALICE, { tradeId: id });
    expect(r.referencePrice).toBe(110);
    expect(c.quoteCalls.at(-1)).toEqual(BTC);
  });
});

describe("close paper trade: ownership and status", () => {
  it("another user's trade is refused exactly like a missing one, with no quote fetched and nothing changed", async () => {
    const c = makeCloseCtx();
    const alices = await c.openBtc(ALICE);
    await c.openBtc(BOB);
    const aliceBalance = balance(c, ALICE);
    const bobBalance = balance(c, BOB);
    c.quoteCalls.length = 0;

    const cross = await c.service.closeTrade(BOB, { tradeId: alices }).then(() => null, (e: unknown) => e as PaperTradeRejectedError);
    const missing = await c.service.closeTrade(BOB, { tradeId: "eeeeeeee-0000-4000-8000-000000000009" }).then(() => null, (e: unknown) => e as PaperTradeRejectedError);
    expect(cross).toBeInstanceOf(PaperTradeRejectedError);
    expect(cross!.reason).toBe("TRADE_NOT_FOUND");
    expect(missing!.reason).toBe("TRADE_NOT_FOUND");
    expect(cross!.message).toBe(missing!.message); // no existence oracle
    expect(c.fs.lookups).toEqual([{ userId: BOB, tradeId: alices }, { userId: BOB, tradeId: "eeeeeeee-0000-4000-8000-000000000009" }]); // always scoped to the session user
    expect(c.quoteCalls).toHaveLength(0);
    expect(c.fs.closeCalls).toHaveLength(0);
    expect(tradeOf(c, alices).status).toBe("OPEN");
    expect(balance(c, ALICE)).toBe(aliceBalance);
    expect(balance(c, BOB)).toBe(bobBalance);
    expect(c.fs.state.results).toHaveLength(0);
  });

  it("a user can close their own trade without touching anyone else's account", async () => {
    const c = makeCloseCtx();
    const a = await c.openBtc(ALICE);
    await c.openBtc(BOB);
    const bobBefore = balance(c, BOB);
    c.setPrice(110);
    await c.service.closeTrade(ALICE, { tradeId: a });
    expect(balance(c, BOB)).toBe(bobBefore);
    expect(c.fs.state.trades.filter((t) => t.userId === BOB).every((t) => t.status === "OPEN")).toBe(true);
  });

  it("an already-closed trade is refused before any price is fetched, and nothing changes", async () => {
    const c = makeCloseCtx();
    const id = await c.openBtc();
    c.setPrice(110);
    await c.service.closeTrade(ALICE, { tradeId: id });
    const after = balance(c);
    c.quoteCalls.length = 0;
    c.auditCalls.length = 0;
    expect(await rejected(c.service.closeTrade(ALICE, { tradeId: id }))).toBe("TRADE_ALREADY_CLOSED");
    expect(c.quoteCalls).toHaveLength(0);
    expect(c.fs.closeCalls).toHaveLength(1); // only the first close ever reached the database call
    expect(balance(c)).toBe(after);
    expect(c.fs.state.results).toHaveLength(1);
    expect(c.auditCalls).toHaveLength(0);
  });

  it("repeating the same close five times credits the account exactly once", async () => {
    const c = makeCloseCtx();
    const id = await c.openBtc();
    c.setPrice(110);
    const outcomes = [];
    for (let i = 0; i < 5; i++) outcomes.push(await c.service.closeTrade(ALICE, { tradeId: id }).then(() => "ok", (e: PaperTradeRejectedError) => e.reason));
    expect(outcomes).toEqual(["ok", "TRADE_ALREADY_CLOSED", "TRADE_ALREADY_CLOSED", "TRADE_ALREADY_CLOSED", "TRADE_ALREADY_CLOSED"]);
    expect(balance(c)).toBe(1_001_937_001_000n);
    expect(c.fs.state.results).toHaveLength(1);
  });

  it.each([
    ["a pre-accounting row (no recorded execution)", { simVersion: null }, "TRADE_NOT_CLOSABLE"],
    ["a SELL record", { side: "SELL" as const }, "SIDE_NOT_SUPPORTED"],
    ["a SHORT record", { side: "SHORT" as const }, "SIDE_NOT_SUPPORTED"],
    ["an unreadable quantity", { quantity: "1e3" }, "DATA_INCONSISTENT"],
    ["a missing recorded cost", { cashDebited: null }, "DATA_INCONSISTENT"],
  ])("refuses %s without pricing or changing anything", async (_n, patch, reason) => {
    const c = makeCloseCtx();
    const id = await c.openBtc();
    const before = balance(c);
    const real = c.fs.store.getTradeForClose;
    c.fs.store.getTradeForClose = async (u, t) => { const x = await real(u, t); return x && { ...x, ...patch }; };
    c.quoteCalls.length = 0;
    expect(await rejected(c.service.closeTrade(ALICE, { tradeId: id }))).toBe(reason);
    expect(c.quoteCalls).toHaveLength(0);
    untouchedBy(c, id, before);
  });

  it("refuses a lookup that returns someone else's row (defence in depth) and a mismatched asset", async () => {
    const c = makeCloseCtx();
    const id = await c.openBtc();
    const real = c.fs.store.getTradeForClose;
    c.fs.store.getTradeForClose = async (u, t) => { const x = await real(u, t); return x && { ...x, userId: BOB }; };
    expect(await rejected(c.service.closeTrade(ALICE, { tradeId: id }))).toBe("TRADE_NOT_FOUND");
    c.fs.store.getTradeForClose = async (u, t) => { const x = await real(u, t); return x && { ...x, asset: RELIANCE }; };
    expect(await rejected(c.service.closeTrade(ALICE, { tradeId: id }))).toBe("DATA_INCONSISTENT");
    expect(c.fs.closeCalls).toHaveLength(0);
  });

  it("will not close a position on an index instrument", async () => {
    const c = makeCloseCtx();
    const id = await c.openBtc();
    const real = c.fs.store.getTradeForClose;
    c.fs.store.getTradeForClose = async (u, t) => { const x = await real(u, t); return x && { ...x, assetId: NIFTY.id, asset: NIFTY }; };
    expect(await rejected(c.service.closeTrade(ALICE, { tradeId: id }))).toBe("ASSET_NOT_TRADABLE");
    expect(c.fs.closeCalls).toHaveLength(0);
  });
});

describe("close paper trade: exit quote gating (trade and account stay untouched)", () => {
  const view = (over: object) => ({ ok: true as const, servedFrom: "PROVIDER" as const, freshness: { status: "FRESH" as const, ageMs: 0, label: "" }, data: quote({ price: 110 }), ...over });
  const attempt = async (setup: (c: CloseCtx) => void, opts: Parameters<typeof makeCloseCtx>[0] = {}) => {
    const c = makeCloseCtx(opts);
    const id = await c.openBtc();
    const before = balance(c);
    setup(c);
    c.auditCalls.length = 0;
    const reason = await rejected(c.service.closeTrade(ALICE, { tradeId: id }));
    untouchedBy(c, id, before);
    return reason;
  };

  it("rejects when the quote is unavailable, and maps to PROVIDER_UNAVAILABLE", async () => {
    expect(await attempt((c) => c.setQuote(errorView()))).toBe("QUOTE_UNAVAILABLE");
    const c = makeCloseCtx();
    const id = await c.openBtc();
    c.setQuote(errorView());
    await expect(c.service.closeTrade(ALICE, { tradeId: id })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });
  it("rejects a quote the facade flags STALE", async () => {
    expect(await attempt((c) => c.setQuote(view({ freshness: { status: "STALE", ageMs: 9e9, label: "" } })))).toBe("QUOTE_STALE");
  });
  it("rejects a quote older than the configured max age even if the facade says FRESH", async () => {
    expect(await attempt((c) => c.setQuote(view({ data: quote({ asOf: new Date(NOW.getTime() - 5 * 60_000).toISOString() }) })))).toBe("QUOTE_STALE");
  });
  it("accepts a quote exactly at the age limit and rejects one millisecond beyond it", async () => {
    const at = (ms: number) => view({ data: quote({ price: 110, asOf: new Date(NOW.getTime() - ms).toISOString() }) });
    const ok = makeCloseCtx();
    const id = await ok.openBtc();
    ok.setQuote(at(120_000));
    await expect(ok.service.closeTrade(ALICE, { tradeId: id })).resolves.toMatchObject({ status: "CLOSED" });
    expect(await attempt((c) => c.setQuote(at(120_001)))).toBe("QUOTE_STALE");
  });
  it("rejects a quote stamped in the future", async () => {
    expect(await attempt((c) => c.setQuote(view({ data: quote({ asOf: new Date(NOW.getTime() + 10 * 60_000).toISOString() }) })))).toBe("DATA_INCONSISTENT");
  });
  it("rejects a stored (non-live) quote and a closed market", async () => {
    expect(await attempt((c) => c.setQuote(view({ servedFrom: "STORE" })))).toBe("QUOTE_NOT_LIVE");
    expect(await attempt((c) => c.setQuote(view({ freshness: { status: "LAST_CLOSE", ageMs: 1, label: "" } })))).toBe("MARKET_CLOSED");
  });
  it("rejects mock data outside development, and allows it (recorded as mock) only when permitted", async () => {
    const mock = freshView(quote({ price: 110, isMock: true, source: "mock" }));
    expect(await attempt((c) => c.setQuote(mock))).toBe("MOCK_DATA_NOT_ALLOWED");
    const dev = makeCloseCtx({ deps: { allowMockData: true } });
    const id = await dev.openBtc();
    dev.setQuote(mock);
    const r = await dev.service.closeTrade(ALICE, { tradeId: id });
    expect(r.quote).toMatchObject({ isMock: true, source: "mock" }); // recorded, never hidden
    expect(dev.fs.closeCalls[0]!.quote.isMock).toBe(true);
  });
  it.each([
    ["wrong symbol", { symbol: "ETH" }], ["wrong market", { market: "NSE" as const }], ["wrong currency", { currency: "INR" }],
    ["zero price", { price: 0 }], ["negative price", { price: -5 }], ["NaN price", { price: NaN }], ["absurd price", { price: 5e9 }],
  ])("rejects an inconsistent quote: %s", async (_n, over) => {
    expect(await attempt((c) => c.setQuote(freshView(quote(over))))).toBe("DATA_INCONSISTENT");
  });
  it("gets the exit price only through the injected market-data facade, once per close", async () => {
    const c = makeCloseCtx();
    const id = await c.openBtc();
    c.quoteCalls.length = 0;
    await c.service.closeTrade(ALICE, { tradeId: id });
    expect(c.quoteCalls).toEqual([BTC]);
  });
  it("rejection messages tell the user the trade remains open", async () => {
    const c = makeCloseCtx();
    const id = await c.openBtc();
    c.setQuote(errorView());
    const e = await c.service.closeTrade(ALICE, { tradeId: id }).then(() => null, (x: PaperTradeRejectedError) => x);
    expect(e!.message).toMatch(/remains open/i);
  });
});

describe("close paper trade: audit", () => {
  it("writes one audit record after the commit, with the exit provenance and signed P&L", async () => {
    const c = makeCloseCtx();
    const id = await c.openBtc();
    c.setPrice(90);
    await c.service.closeTrade(ALICE, { tradeId: id });
    const closes = c.auditCalls.filter((a) => (a as { action: string }).action === "paper_trade.closed");
    expect(closes).toEqual([expect.objectContaining({
      actorId: ALICE, action: "paper_trade.closed", entityType: "paper_trade", entityId: id,
      metadata: expect.objectContaining({ exitPrice: "89.95500000", exitFee: "0.17991000", realizedPnl: "-20.57001000", simVersion: "PAPER_SIM_V1" }),
    })]);
  });
  it("never fails (or reverses) a committed close if auditing fails", async () => {
    const c = makeCloseCtx({ deps: { audit: async () => { throw new Error("audit down"); } } });
    const id = await c.openBtc();
    c.setPrice(110);
    await expect(c.service.closeTrade(ALICE, { tradeId: id })).resolves.toMatchObject({ status: "CLOSED" });
    expect(tradeOf(c, id).status).toBe("CLOSED");
    expect(balance(c)).toBe(1_001_937_001_000n);
  });
  it("records nothing for a rejected close", async () => {
    const c = makeCloseCtx();
    const id = await c.openBtc();
    c.auditCalls.length = 0;
    c.setQuote(errorView());
    await rejected(c.service.closeTrade(ALICE, { tradeId: id }));
    expect(c.auditCalls).toHaveLength(0);
  });
});

describe("close paper trade: repeated and concurrent requests", () => {
  it("two simultaneous closes of one trade: exactly one succeeds, the loser is refused, cash is credited once", async () => {
    const c = makeCloseCtx();
    const id = await c.openBtc();
    c.setPrice(110);
    const settled = await Promise.allSettled([c.service.closeTrade(ALICE, { tradeId: id }), c.service.closeTrade(ALICE, { tradeId: id })]);
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    const lost = settled.find((s) => s.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(PaperTradeRejectedError);
    expect(lost.reason.reason).toBe("TRADE_ALREADY_CLOSED");
    expect(c.fs.closeCalls).toHaveLength(2); // both passed the early read and raced to the lock: the lock decided
    expect(c.fs.state.results).toHaveLength(1);
    expect(balance(c)).toBe(1_001_937_001_000n);
    expect(c.auditCalls.filter((a) => (a as { action: string }).action === "paper_trade.closed")).toHaveLength(1);
  });

  it("ten simultaneous closes of one trade still produce exactly one result and one credit", async () => {
    const c = makeCloseCtx();
    const id = await c.openBtc();
    c.setPrice(110);
    const settled = await Promise.allSettled(Array.from({ length: 10 }, () => c.service.closeTrade(ALICE, { tradeId: id })));
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((s) => s.status === "rejected" && (s.reason as PaperTradeRejectedError).reason === "TRADE_ALREADY_CLOSED")).toHaveLength(9);
    expect(c.fs.state.results).toHaveLength(1);
    expect(balance(c)).toBe(1_001_937_001_000n);
  });

  it("simultaneous closes of DIFFERENT trades both settle, and the balance reflects both", async () => {
    const c = makeCloseCtx();
    const a = await c.openBtc(ALICE, 2);
    const b = await c.openBtc(ALICE, 1);
    c.setPrice(110);
    const [ra, rb] = await Promise.all([c.service.closeTrade(ALICE, { tradeId: a }), c.service.closeTrade(ALICE, { tradeId: b })]);
    expect(ra.status).toBe("CLOSED");
    expect(rb.status).toBe("CLOSED");
    expect(c.fs.state.results).toHaveLength(2);
    const pnl = c.fs.state.results.reduce((s, x) => s + x.pnlUnits, 0n);
    expect(balance(c)).toBe(1_000_000_000_000n + pnl);
  });

  it("two users closing at once never affect each other's balance", async () => {
    const c = makeCloseCtx();
    const a = await c.openBtc(ALICE);
    const b = await c.openBtc(BOB);
    c.setPrice(110);
    await Promise.all([c.service.closeTrade(ALICE, { tradeId: a }), c.service.closeTrade(BOB, { tradeId: b })]);
    expect(balance(c, ALICE)).toBe(balance(c, BOB));
    expect(balance(c, ALICE)).toBe(1_001_937_001_000n);
  });
});

describe("close paper trade: atomic failure behaviour", () => {
  it.each(["after-credit", "after-result"] as const)("a database failure %s rolls back credit, result and status; no internals leak", async (stage) => {
    const c = makeCloseCtx({ storeOpts: { failClose: stage } });
    const id = await c.openBtc();
    const before = balance(c);
    c.setPrice(110);
    const err = await c.service.closeTrade(ALICE, { tradeId: id }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("INTERNAL");
    expect((err as AppError).message).not.toMatch(/close failed|sql|postgres/i);
    expect(tradeOf(c, id).status).toBe("OPEN");
    expect(balance(c)).toBe(before);
    expect(c.fs.state.results).toHaveLength(0);
    expect(c.auditCalls.filter((a) => (a as { action: string }).action === "paper_trade.closed")).toHaveLength(0);
  });

  it("after a failed close the trade is still closable, and the retry credits exactly once", async () => {
    const c = makeCloseCtx({ storeOpts: { failClose: "after-result" } });
    const id = await c.openBtc();
    c.setPrice(110);
    await expect(c.service.closeTrade(ALICE, { tradeId: id })).rejects.toMatchObject({ code: "INTERNAL" });
    c.storeOpts.failClose = undefined;
    await expect(c.service.closeTrade(ALICE, { tradeId: id })).resolves.toMatchObject({ realizedPnl: 19.37001 });
    expect(balance(c)).toBe(1_001_937_001_000n);
    expect(c.fs.state.results).toHaveLength(1);
  });

  it("a failed lookup is reported as INTERNAL and changes nothing", async () => {
    const c = makeCloseCtx();
    const id = await c.openBtc();
    const before = balance(c);
    c.fs.store.getTradeForClose = async () => { throw new Error("connection string postgres://secret"); };
    const err = await c.service.closeTrade(ALICE, { tradeId: id }).then(() => null, (e: unknown) => e as AppError);
    expect(err!.code).toBe("INTERNAL");
    expect(err!.message).not.toMatch(/postgres|secret/i);
    untouchedBy(c, id, before);
  });

  it.each(["TRADE_NOT_FOUND", "TRADE_ALREADY_CLOSED", "TRADE_NOT_CLOSABLE"] as const)("a business rejection from the database (%s) is a typed rejection, not a crash, and writes no audit", async (reason) => {
    const c = makeCloseCtx();
    const id = await c.openBtc();
    c.auditCalls.length = 0;
    c.fs.store.closeTrade = async () => ({ ok: false as const, reason });
    expect(await rejected(c.service.closeTrade(ALICE, { tradeId: id }))).toBe(reason);
    expect(c.auditCalls).toHaveLength(0);
  });

  it("the database refuses a figure that disagrees with its own re-derivation (defence against a buggy or tampered caller)", async () => {
    const c = makeCloseCtx();
    const id = await c.openBtc();
    c.setPrice(110);
    const real = c.fs.store.closeTrade;
    c.fs.store.closeTrade = (p) => real({ ...p, pnl: "1000000.00000000" }); // an inflated P&L
    const before = balance(c);
    await expect(c.service.closeTrade(ALICE, { tradeId: id })).rejects.toMatchObject({ code: "INTERNAL" });
    expect(balance(c)).toBe(before);
    expect(tradeOf(c, id).status).toBe("OPEN");
    expect(c.fs.state.results).toHaveLength(0);
  });
});

describe("close paper trade: the immutable entry record is preserved", () => {
  it("closing changes only the trade's status; every entry field is byte-for-byte what was opened", async () => {
    const c = makeCloseCtx();
    const id = await c.openBtc();
    const entryOf = (t: object) => Object.fromEntries(Object.entries(t).filter(([k]) => k !== "status"));
    const entryBefore = entryOf(structuredClone(tradeOf(c, id)));
    c.setPrice(110);
    await c.service.closeTrade(ALICE, { tradeId: id });
    const entryAfter = entryOf(tradeOf(c, id));
    expect(entryAfter).toEqual(entryBefore);
    expect(tradeOf(c, id).status).toBe("CLOSED");
    expect(entryAfter).toMatchObject({ entryPrice: "100.05000000", fee: "0.20010000", quantity: "2.00000000", referencePrice: "100.00000000" });
  });

  it("the store call can carry only exit data: it has no field that could rewrite entry price, quantity, fee or time", async () => {
    const c = makeCloseCtx();
    const id = await c.openBtc();
    await c.service.closeTrade(ALICE, { tradeId: id });
    expect(Object.keys(c.fs.closeCalls[0]!).sort()).toEqual(
      ["exitPrice", "fee", "feeBps", "pnl", "quote", "referencePrice", "simVersion", "slippageBps", "tradeId", "userId"],
    );
  });

  it("the original entry values can be read back from the closed trade and reproduce the P&L", async () => {
    const c = makeCloseCtx();
    const id = await c.openBtc();
    c.setPrice(110);
    const r = await c.service.closeTrade(ALICE, { tradeId: id });
    const t = tradeOf(c, id);
    const cost = Number(fmt8(t.cashDebited));
    expect(cost).toBe(200.3001);
    expect(r.cashCredited - cost).toBeCloseTo(r.realizedPnl, 8);
  });
});

describe("close paper trade: labelling and scope", () => {
  it("is labelled simulation-only and exposes no real-money, short, margin or partial-close surface", async () => {
    const c = makeCloseCtx();
    const id = await c.openBtc();
    const r = await c.service.closeTrade(ALICE, { tradeId: id });
    expect(r.banner).toBe("PAPER TRADING — NO REAL MONEY");
    expect(r.simulation.version).toBe(PAPER_SIMULATION.version);
    expect(Object.keys(c.service).sort()).toEqual(["closeTrade", "getClosedTrades", "getPortfolio", "getSimulationAssumptions", "openTrade", "previewOpenTrade"]);
  });
});
