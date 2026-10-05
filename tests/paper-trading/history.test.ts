import { describe, expect, it } from "vitest";
import { createPaperTradingService } from "@/services/paper-trading/paper-trading-service";
import type { ClosedTradePage } from "@/services/paper-trading/ports";
import { ALICE, BOB, BTC } from "./open-helpers";
import { makeCloseCtx } from "./close-helpers";

describe("getClosedTrades (read-only history)", () => {
  it("returns stored entry, exit, fees and realized P&L for the owner only", async () => {
    const c = makeCloseCtx();
    const id = await c.openBtc(ALICE);
    c.setPrice(110);
    await c.service.closeTrade(ALICE, { tradeId: id });
    await c.openBtc(BOB);

    const mine = await c.service.getClosedTrades(ALICE);
    expect(mine.totalCount).toBe(1);
    expect(mine.truncated).toBe(false);
    expect(mine.trades[0]).toMatchObject({
      tradeId: id, symbol: "BTC", currency: "USDT", side: expect.stringMatching(/BUY|LONG/),
      exitPrice: "109.94500000", realizedPnl: "19.37001000",
    });
    expect(mine.banner).toBe("PAPER TRADING — NO REAL MONEY");
    expect((await c.service.getClosedTrades(BOB)).trades).toEqual([]);
  });

  it("the stored P&L equals cash credited minus entry cost (nothing is recomputed differently)", async () => {
    const c = makeCloseCtx();
    const id = await c.openBtc(ALICE);
    c.setPrice(90);
    await c.service.closeTrade(ALICE, { tradeId: id });
    const [t] = (await c.service.getClosedTrades(ALICE)).trades;
    expect(Number(t!.cashCredited) - Number(t!.entryCost)).toBeCloseTo(Number(t!.realizedPnl), 8);
    expect(t!.realizedPnl.startsWith("-")).toBe(true);
  });

  it("refuses any client input, including a user id", async () => {
    const c = makeCloseCtx();
    for (const bad of [{ userId: BOB }, { limit: 1 }, "x", 1]) {
      await expect(c.service.getClosedTrades(ALICE, bad)).rejects.toMatchObject({ code: "VALIDATION" });
    }
  });

  it("rejects a non-UUID caller", async () => {
    const c = makeCloseCtx();
    await expect(c.service.getClosedTrades("nope")).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  const row = (over: Partial<ClosedTradePage["rows"][number]> = {}): ClosedTradePage["rows"][number] => ({
    tradeId: "00000000-0000-4000-8000-000000000001", userId: ALICE, side: "BUY", quantity: "1.00000000",
    entryPrice: "100.00000000", entryFee: "0.10000000", entryCost: "100.10000000", openedAt: "2026-10-01T10:00:00Z",
    exitPrice: "110.00000000", exitFee: "0.11000000", cashCredited: "109.89000000", pnl: "9.79000000",
    closedAt: "2026-10-02T10:00:00Z", asset: BTC, ...over,
  });
  const withStore = (get: () => Promise<ClosedTradePage>) => {
    const c = makeCloseCtx();
    return createPaperTradingService({ ...c.deps, store: { ...c.deps.store, getClosedTrades: get } });
  };

  it("fails closed if the store returns someone else's row", async () => {
    const s = withStore(async () => ({ rows: [row({ userId: BOB })], totalCount: 1 }));
    await expect(s.getClosedTrades(ALICE)).rejects.toMatchObject({ code: "INTERNAL" });
  });

  it("fails rather than showing zero when a stored amount is unreadable", async () => {
    const s = withStore(async () => ({ rows: [row({ pnl: "NaN" })], totalCount: 1 }));
    await expect(s.getClosedTrades(ALICE)).rejects.toMatchObject({ code: "INTERNAL" });
  });

  it("reports truncation honestly with the true total", async () => {
    const s = withStore(async () => ({ rows: [row()], totalCount: 120 }));
    const h = await s.getClosedTrades(ALICE);
    expect(h).toMatchObject({ truncated: true, totalCount: 120, limit: 50 });
  });

  it("hides store error details", async () => {
    const s = withStore(async () => { throw new Error("secret connection string"); });
    const err = await s.getClosedTrades(ALICE).catch((e) => e);
    expect(err.code).toBe("INTERNAL");
    expect(err.message).not.toMatch(/secret/);
  });
});
