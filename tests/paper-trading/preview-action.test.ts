import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import { ALICE, BOB, BTC_ID } from "./open-helpers";
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
    paperTradePreview: { action: "paper_trade.preview", limit: 120, windowSeconds: 600 },
  },
}));
vi.mock("@/services/paper-trading", async () => {
  const { PaperTradeRejectedError } = await import("@/services/paper-trading/errors");
  return { getPaperTradingService: getService, PaperTradeRejectedError };
});

import { previewPaperTradeAction } from "@/features/paper-trading/actions";

describe("previewPaperTradeAction", () => {
  let ctx: CloseCtx;
  beforeEach(() => {
    vi.clearAllMocks();
    ctx = makeCloseCtx();
    getService.mockReturnValue(ctx.service);
    requireUser.mockResolvedValue({ id: ALICE });
    checkRateLimit.mockResolvedValue(true);
  });
  const input = { assetId: BTC_ID, side: "BUY", quantity: "1" };

  it("rejects an unauthenticated request before touching the service, market data or rate limiter", async () => {
    requireUser.mockRejectedValue(new AppError("UNAUTHENTICATED", "Sign in to continue"));
    expect(await previewPaperTradeAction(input)).toEqual({ ok: false, error: "Your session has expired. Sign in again." });
    expect(getService).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(ctx.quoteCalls).toHaveLength(0);
  });

  it("returns a server-calculated estimate and rate-limits per SESSION user under its own bucket", async () => {
    const res = await previewPaperTradeAction(input);
    expect(res).toMatchObject({ ok: true, estimate: { symbol: "BTC", estimatedTotalCost: "100.15005000" } });
    expect(checkRateLimit).toHaveBeenCalledWith(expect.objectContaining({ action: "paper_trade.preview" }), ALICE);
  });

  it("stops when rate limited, before any quote is fetched", async () => {
    checkRateLimit.mockResolvedValue(false);
    expect(await previewPaperTradeAction(input)).toMatchObject({ ok: false, reason: "RATE_LIMITED" });
    expect(ctx.quoteCalls).toHaveLength(0);
  });

  it("uses the session identity even if the payload names someone else", async () => {
    requireUser.mockResolvedValue({ id: BOB });
    for (const spoof of [{ userId: ALICE }, { user_id: ALICE }]) {
      expect((await previewPaperTradeAction({ ...input, ...spoof })).ok).toBe(false);
    }
    expect(ctx.quoteCalls).toHaveLength(0);
  });

  it("surfaces a clear message for an unsupported side and never writes", async () => {
    const res = await previewPaperTradeAction({ ...input, side: "SHORT" });
    expect(res).toMatchObject({ ok: false, reason: "SIDE_NOT_SUPPORTED" });
    expect(ctx.fs.calls).toHaveLength(0);
    expect(ctx.fs.state.trades).toHaveLength(0);
  });

  it("hides unexpected failures behind a generic message", async () => {
    getService.mockImplementation(() => { throw new Error("db password leaked"); });
    const res = await previewPaperTradeAction(input);
    expect(res).toEqual({ ok: false, error: "Something went wrong. Try again." });
  });
});
