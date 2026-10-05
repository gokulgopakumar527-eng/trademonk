import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import { createPaperTradingService } from "@/services/paper-trading/paper-trading-service";
import { ALICE, BOB, BTC_ID, makeDeps } from "./open-helpers";

const requireUser = vi.hoisted(() => vi.fn());
const checkRateLimit = vi.hoisted(() => vi.fn());
const getService = vi.hoisted(() => vi.fn());

vi.mock("@/services/profiles/profile-service", () => ({ requireUser }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit,
  RATE_LIMITS: { paperTradeOpen: { action: "paper_trade.open", limit: 60, windowSeconds: 3600 } },
}));
vi.mock("@/services/paper-trading", async () => {
  const { PaperTradeRejectedError } = await import("@/services/paper-trading/errors");
  return { getPaperTradingService: getService, PaperTradeRejectedError };
});

import { openPaperTradeAction } from "@/features/paper-trading/actions";

const valid = { assetId: BTC_ID, side: "BUY", quantity: 2 };

describe("openPaperTradeAction", () => {
  let ctx: ReturnType<typeof makeDeps>;
  beforeEach(() => {
    vi.clearAllMocks();
    ctx = makeDeps();
    getService.mockReturnValue(createPaperTradingService(ctx.deps)); // REAL service, fake I/O
    requireUser.mockResolvedValue({ id: ALICE });
    checkRateLimit.mockResolvedValue(true);
  });

  it("rejects an unauthenticated request without touching the service, market data or store", async () => {
    requireUser.mockRejectedValue(new AppError("UNAUTHENTICATED", "Sign in to continue"));
    const res = await openPaperTradeAction(valid);
    expect(res).toEqual({ ok: false, error: "Your session has expired. Sign in again." });
    expect(getService).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(ctx.quoteCalls).toHaveLength(0);
    expect(ctx.fs.calls).toHaveLength(0);
  });

  it("opens the trade for the SESSION user, and rate-limits per that user", async () => {
    const res = await openPaperTradeAction(valid);
    expect(res).toMatchObject({ ok: true, trade: { status: "OPEN", entryPrice: 100.05, banner: "PAPER TRADING — NO REAL MONEY" } });
    expect(ctx.fs.calls.map((c) => c.userId)).toEqual([ALICE]);
    expect(checkRateLimit).toHaveBeenCalledWith(expect.objectContaining({ action: "paper_trade.open" }), ALICE);
  });

  it("cannot be used to trade as another user: a spoofed user id is refused and nothing is created", async () => {
    requireUser.mockResolvedValue({ id: BOB });
    for (const spoof of [{ userId: ALICE }, { user_id: ALICE }, { accountId: ALICE }]) {
      const res = await openPaperTradeAction({ ...valid, ...spoof });
      expect(res.ok).toBe(false);
    }
    expect(ctx.fs.calls).toHaveLength(0);
    expect(ctx.fs.state.trades).toHaveLength(0);
  });

  it.each([{ price: 1 }, { entryPrice: 1 }, { fee: 0 }, { fees: 0 }, { slippage: 0 }, { openedAt: "2020-01-01" }, { cash: 1e9 }, { balance: 1e9 }])(
    "refuses a client-supplied server field %j end to end",
    async (extra) => {
      const res = await openPaperTradeAction({ ...valid, ...extra });
      expect(res.ok).toBe(false);
      expect(ctx.fs.calls).toHaveLength(0);
      expect(ctx.quoteCalls).toHaveLength(0);
    },
  );

  it("does not call the service when rate limited", async () => {
    checkRateLimit.mockResolvedValue(false);
    expect(await openPaperTradeAction(valid)).toMatchObject({ ok: false, reason: "RATE_LIMITED" });
    expect(getService).not.toHaveBeenCalled();
  });

  it("turns a rejection (insufficient paper cash) into a typed, user-safe failure", async () => {
    const res = await openPaperTradeAction({ ...valid, quantity: 100 });
    expect(res).toMatchObject({ ok: false, reason: "INSUFFICIENT_PAPER_CASH" });
    expect(JSON.stringify(res)).not.toMatch(/postgres|supabase|stack/i);
    expect(ctx.fs.state.trades).toHaveLength(0);
  });

  it("never leaks the details of an unexpected failure", async () => {
    getService.mockReturnValue({ openTrade: async () => { throw new Error("connection string postgres://secret"); } });
    const res = await openPaperTradeAction(valid);
    expect(res).toEqual({ ok: false, error: "Something went wrong. Try again." });
  });
});
