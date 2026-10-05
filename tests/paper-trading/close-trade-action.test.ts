import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import { ALICE, BOB, quote } from "./open-helpers";
import { makeCloseCtx, type CloseCtx } from "./close-helpers";

const requireUser = vi.hoisted(() => vi.fn());
const checkRateLimit = vi.hoisted(() => vi.fn());
const getService = vi.hoisted(() => vi.fn());

vi.mock("@/services/profiles/profile-service", () => ({ requireUser }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit,
  RATE_LIMITS: {
    paperTradeOpen: { action: "paper_trade.open", limit: 60, windowSeconds: 3600 },
    paperTradeClose: { action: "paper_trade.close", limit: 60, windowSeconds: 3600 },
  },
}));
vi.mock("@/services/paper-trading", async () => {
  const { PaperTradeRejectedError } = await import("@/services/paper-trading/errors");
  return { getPaperTradingService: getService, PaperTradeRejectedError };
});

import { closePaperTradeAction } from "@/features/paper-trading/actions";

describe("closePaperTradeAction", () => {
  let ctx: CloseCtx;
  let tradeId: string;
  beforeEach(async () => {
    vi.clearAllMocks();
    ctx = makeCloseCtx();
    getService.mockReturnValue(ctx.service); // REAL service, fake I/O
    requireUser.mockResolvedValue({ id: ALICE });
    checkRateLimit.mockResolvedValue(true);
    tradeId = await ctx.openBtc(ALICE);
    ctx.quoteCalls.length = 0;
    ctx.setPrice(110);
  });

  it("rejects an unauthenticated request without touching the service, market data or store", async () => {
    requireUser.mockRejectedValue(new AppError("UNAUTHENTICATED", "Sign in to continue"));
    const res = await closePaperTradeAction({ tradeId });
    expect(res).toEqual({ ok: false, error: "Your session has expired. Sign in again." });
    expect(getService).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(ctx.quoteCalls).toHaveLength(0);
    expect(ctx.fs.lookups).toHaveLength(0);
    expect(ctx.fs.closeCalls).toHaveLength(0);
  });

  it("closes the SESSION user's trade, and rate-limits per that user under its own bucket", async () => {
    const res = await closePaperTradeAction({ tradeId });
    expect(res).toMatchObject({
      ok: true,
      trade: { id: tradeId, status: "CLOSED", exitPrice: 109.945, realizedPnl: 19.37001, banner: "PAPER TRADING — NO REAL MONEY" },
    });
    expect(ctx.fs.closeCalls.map((c) => c.userId)).toEqual([ALICE]);
    expect(checkRateLimit).toHaveBeenCalledWith(expect.objectContaining({ action: "paper_trade.close" }), ALICE);
  });

  it("cannot be used to close another user's trade: refused as not found, nothing changes", async () => {
    requireUser.mockResolvedValue({ id: BOB });
    await ctx.openBtc(BOB);
    ctx.quoteCalls.length = 0;
    const res = await closePaperTradeAction({ tradeId });
    expect(res).toMatchObject({ ok: false, reason: "TRADE_NOT_FOUND" });
    expect(ctx.fs.lookups).toEqual([{ userId: BOB, tradeId }]);
    expect(ctx.fs.closeCalls).toHaveLength(0);
    expect(ctx.fs.state.trades.find((t) => t.id === tradeId)!.status).toBe("OPEN");
  });

  it("a spoofed user id in the payload is refused, even when it names the real owner", async () => {
    requireUser.mockResolvedValue({ id: BOB });
    for (const spoof of [{ userId: ALICE }, { user_id: ALICE }, { accountId: ALICE }]) {
      expect((await closePaperTradeAction({ tradeId, ...spoof })).ok).toBe(false);
    }
    expect(ctx.fs.lookups).toHaveLength(0);
    expect(ctx.fs.closeCalls).toHaveLength(0);
  });

  it.each([
    { exitPrice: 1e9 }, { price: 1e9 }, { fee: 0 }, { fees: 0 }, { pnl: 1e9 }, { realizedPnl: 1e9 },
    { closedAt: "2020-01-01" }, { timestamp: "2020-01-01" }, { slippage: 0 }, { status: "CLOSED" }, { balance: 1e9 },
  ])("refuses a client-supplied server field %j end to end", async (extra) => {
    const res = await closePaperTradeAction({ tradeId, ...extra });
    expect(res.ok).toBe(false);
    expect(ctx.fs.lookups).toHaveLength(0);
    expect(ctx.quoteCalls).toHaveLength(0);
    expect(ctx.fs.closeCalls).toHaveLength(0);
    expect(ctx.fs.state.results).toHaveLength(0);
  });

  it("does not call the service when rate limited", async () => {
    checkRateLimit.mockResolvedValue(false);
    expect(await closePaperTradeAction({ tradeId })).toMatchObject({ ok: false, reason: "RATE_LIMITED" });
    expect(getService).not.toHaveBeenCalled();
  });

  it("a second close of the same trade is a typed, user-safe refusal and credits nothing more", async () => {
    await closePaperTradeAction({ tradeId });
    const again = await closePaperTradeAction({ tradeId });
    expect(again).toMatchObject({ ok: false, reason: "TRADE_ALREADY_CLOSED" });
    expect(JSON.stringify(again)).not.toMatch(/postgres|supabase|stack/i);
    expect(ctx.fs.state.results).toHaveLength(1);
  });

  it("turns an unavailable or stale quote into a typed failure and leaves the trade open", async () => {
    ctx.setQuote({ ok: false, message: "Data unavailable", error: { code: "UPSTREAM_ERROR", message: "down", provider: "t", retryable: true } });
    expect(await closePaperTradeAction({ tradeId })).toMatchObject({ ok: false, reason: "QUOTE_UNAVAILABLE" });
    ctx.setQuote({ ok: true, data: quote({ price: 110 }), servedFrom: "PROVIDER", freshness: { status: "STALE", ageMs: 9e9, label: "" } });
    expect(await closePaperTradeAction({ tradeId })).toMatchObject({ ok: false, reason: "QUOTE_STALE" });
    expect(ctx.fs.state.trades.find((t) => t.id === tradeId)!.status).toBe("OPEN");
    expect(ctx.fs.state.results).toHaveLength(0);
  });

  it("never leaks the details of an unexpected failure", async () => {
    getService.mockReturnValue({ closeTrade: async () => { throw new Error("connection string postgres://secret"); } });
    expect(await closePaperTradeAction({ tradeId })).toEqual({ ok: false, error: "Something went wrong. Try again." });
  });

  it("a database failure surfaces only the safe INTERNAL message, with the trade left open", async () => {
    const failing = makeCloseCtx({ storeOpts: { failClose: "after-result" } });
    getService.mockReturnValue(failing.service);
    const id = await failing.openBtc(ALICE);
    failing.setPrice(110);
    const res = await closePaperTradeAction({ tradeId: id });
    expect(res).toEqual({ ok: false, error: "Could not close the paper trade. Nothing was changed." });
    expect(failing.fs.state.trades.find((t) => t.id === id)!.status).toBe("OPEN");
  });
});
