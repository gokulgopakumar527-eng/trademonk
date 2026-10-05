import { describe, expect, it } from "vitest";
import { PaperTradeRejectedError } from "@/services/paper-trading/errors";
import { createPaperTradingService } from "@/services/paper-trading/paper-trading-service";
import { ALICE, BTC_ID, NIFTY_ID, NOW, RELIANCE_ID, errorView, freshView, makeDeps, quote } from "./open-helpers";

const svc = (over: Parameters<typeof makeDeps>[0] = {}) => {
  const c = makeDeps(over);
  return { ...c, service: createPaperTradingService(c.deps) };
};
const iso = (msBefore: number) => new Date(NOW.getTime() - msBefore).toISOString();

describe("previewOpenTrade (read-only estimate)", () => {
  it("returns the same simulated fill the open flow would use, as exact decimal strings", async () => {
    const { service } = svc();
    const e = await service.previewOpenTrade(ALICE, { assetId: BTC_ID, side: "BUY", quantity: "2" });
    // quote 100, CRYPTO: 5 bps slippage -> 100.05; notional 200.10; fee 10 bps -> 0.2001
    expect(e).toMatchObject({
      symbol: "BTC", side: "BUY", currency: "USDT", quantity: "2.00000000",
      referencePrice: "100.00000000", estimatedFillPrice: "100.05000000",
      estimatedNotional: "200.10000000", estimatedFee: "0.20010000", estimatedTotalCost: "200.30010000",
      banner: "PAPER TRADING — NO REAL MONEY",
    });
    expect(e.simulation).toMatchObject({ slippageBps: 5, feeBps: 10 });
    expect(e.quote).toMatchObject({ source: "binance-public", isMock: false });
  });

  it("matches what openTrade actually charges for the same quote", async () => {
    const { service } = svc();
    const e = await service.previewOpenTrade(ALICE, { assetId: BTC_ID, side: "LONG", quantity: "0.5" });
    const t = await service.openTrade(ALICE, { assetId: BTC_ID, side: "LONG", quantity: "0.5" });
    expect(Number(e.estimatedTotalCost)).toBeCloseTo(t.cashDebited, 8);
    expect(Number(e.estimatedFillPrice)).toBeCloseTo(t.entryPrice, 8);
  });

  it("writes nothing: no store write, no audit, no account created", async () => {
    const { service, fs, auditCalls } = svc();
    await service.previewOpenTrade(ALICE, { assetId: BTC_ID, side: "BUY", quantity: "1" });
    expect(fs.calls).toHaveLength(0);
    expect(fs.state.trades).toHaveLength(0);
    expect(fs.state.accounts.size).toBe(0);
    expect(auditCalls).toHaveLength(0);
  });

  it.each([
    [{ userId: ALICE }], [{ price: 1 }], [{ fee: 0 }], [{ cash: 1e9 }], [{ user_id: ALICE }],
  ])("refuses client-supplied authority %j", async (extra) => {
    const { service, quoteCalls } = svc();
    await expect(service.previewOpenTrade(ALICE, { assetId: BTC_ID, side: "BUY", quantity: "1", ...extra })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(quoteCalls).toHaveLength(0);
  });

  it("refuses a non-UUID caller before anything is read", async () => {
    const { service, quoteCalls, fs } = svc();
    await expect(service.previewOpenTrade("alice", { assetId: BTC_ID, side: "BUY", quantity: "1" })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(quoteCalls).toHaveLength(0);
    expect(fs.calls).toHaveLength(0);
  });

  it.each(["SELL", "SHORT"])("refuses %s with SIDE_NOT_SUPPORTED", async (side) => {
    const { service } = svc();
    await expect(service.previewOpenTrade(ALICE, { assetId: BTC_ID, side, quantity: "1" })).rejects.toMatchObject({ reason: "SIDE_NOT_SUPPORTED" });
  });

  it("refuses an index, an unknown asset, and fractional equity units", async () => {
    const { service } = svc({ quoteView: freshView(quote({ market: "NSE", symbol: "RELIANCE", currency: "INR" })) });
    await expect(service.previewOpenTrade(ALICE, { assetId: NIFTY_ID, side: "BUY", quantity: "1" })).rejects.toMatchObject({ reason: "ASSET_NOT_TRADABLE" });
    await expect(service.previewOpenTrade(ALICE, { assetId: "dddddddd-0000-4000-8000-0000000000ff", side: "BUY", quantity: "1" })).rejects.toMatchObject({ reason: "ASSET_NOT_FOUND" });
    await expect(service.previewOpenTrade(ALICE, { assetId: RELIANCE_ID, side: "BUY", quantity: "1.5" })).rejects.toMatchObject({ reason: "INVALID_QUANTITY" });
  });

  it.each([
    ["unavailable", () => errorView(), "QUOTE_UNAVAILABLE"],
    ["stale by age", () => freshView(quote({ asOf: iso(10 * 60_000) })), "QUOTE_STALE"],
    ["mock outside development", () => freshView(quote({ isMock: true })), "MOCK_DATA_NOT_ALLOWED"],
    ["wrong symbol", () => freshView(quote({ symbol: "ETH" })), "DATA_INCONSISTENT"],
  ])("shows NO estimate for a %s quote", async (_n, view, reason) => {
    const { service } = svc({ quoteView: view() });
    const err = await service.previewOpenTrade(ALICE, { assetId: BTC_ID, side: "BUY", quantity: "1" }).catch((e) => e);
    expect(err).toBeInstanceOf(PaperTradeRejectedError);
    expect(err.reason).toBe(reason);
  });

  it("a quote that throws is reported as unavailable, not as an estimate", async () => {
    const { service } = svc({ marketData: { getQuote: async () => { throw new Error("boom"); } } });
    await expect(service.previewOpenTrade(ALICE, { assetId: BTC_ID, side: "BUY", quantity: "1" })).rejects.toMatchObject({ reason: "QUOTE_UNAVAILABLE" });
  });
});
