"use server";

import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { getPaperTradingService, PaperTradeRejectedError } from "@/services/paper-trading";
import { requireUser } from "@/services/profiles/profile-service";
import type { ClosePaperTradeResult, OpenPaperTradeResult, PreviewPaperTradeResult } from "./state";

/**
 * Opens a simulated paper trade for the signed-in user. PAPER TRADING — SIMULATION ONLY.
 * Accepts only { assetId, side, quantity }. The user id comes from the verified session; the
 * execution price, fee, slippage, timestamps and cash are produced by the server and database, and
 * any extra field is rejected by the strict schema inside the service.
 */
export async function openPaperTradeAction(input: unknown): Promise<OpenPaperTradeResult> {
  try {
    const user = await requireUser();
    if (!(await checkRateLimit(RATE_LIMITS.paperTradeOpen, user.id))) {
      return { ok: false, error: "Too many paper trades. Try again later.", reason: "RATE_LIMITED" };
    }
    return { ok: true, trade: await getPaperTradingService().openTrade(user.id, input) };
  } catch (err) {
    if (err instanceof PaperTradeRejectedError) return { ok: false, error: err.message, reason: err.reason };
    if (err instanceof AppError) {
      if (err.code === "UNAUTHENTICATED") return { ok: false, error: "Your session has expired. Sign in again." };
      if (err.code === "VALIDATION" || err.code === "NOT_FOUND") return { ok: false, error: err.message };
      if (err.code === "INTERNAL") return { ok: false, error: err.message };
    }
    logger.error("paper_trade.action_failed", { error: err });
    return { ok: false, error: "Something went wrong. Try again." };
  }
}

/**
 * Closes one of the signed-in user's simulated paper trades. PAPER TRADING — SIMULATION ONLY.
 * Accepts only { tradeId }. The user id comes from the verified session; the exit price, fee,
 * slippage, P&L and timestamps are produced by the server and database, and any extra field
 * (including a client-supplied price, fee, P&L or time) is rejected by the strict schema inside the
 * service.
 */
export async function closePaperTradeAction(input: unknown): Promise<ClosePaperTradeResult> {
  try {
    const user = await requireUser();
    if (!(await checkRateLimit(RATE_LIMITS.paperTradeClose, user.id))) {
      return { ok: false, error: "Too many paper trades. Try again later.", reason: "RATE_LIMITED" };
    }
    return { ok: true, trade: await getPaperTradingService().closeTrade(user.id, input) };
  } catch (err) {
    if (err instanceof PaperTradeRejectedError) return { ok: false, error: err.message, reason: err.reason };
    if (err instanceof AppError) {
      if (err.code === "UNAUTHENTICATED") return { ok: false, error: "Your session has expired. Sign in again." };
      if (err.code === "VALIDATION" || err.code === "NOT_FOUND") return { ok: false, error: err.message };
      if (err.code === "INTERNAL") return { ok: false, error: err.message };
    }
    logger.error("paper_trade.close_action_failed", { error: err });
    return { ok: false, error: "Something went wrong. Try again." };
  }
}

/**
 * Read-only ESTIMATE of opening a simulated trade. PAPER TRADING — SIMULATION ONLY.
 * Accepts only { assetId, side, quantity }; the user id comes from the verified session and the
 * price, slippage and fee are produced by the server. Writes nothing. The real fill is re-quoted
 * when the trade is opened and may differ.
 */
export async function previewPaperTradeAction(input: unknown): Promise<PreviewPaperTradeResult> {
  try {
    const user = await requireUser();
    if (!(await checkRateLimit(RATE_LIMITS.paperTradePreview, user.id))) {
      return { ok: false, error: "Too many estimates. Try again shortly.", reason: "RATE_LIMITED" };
    }
    return { ok: true, estimate: await getPaperTradingService().previewOpenTrade(user.id, input) };
  } catch (err) {
    if (err instanceof PaperTradeRejectedError) return { ok: false, error: err.message, reason: err.reason };
    if (err instanceof AppError) {
      if (err.code === "UNAUTHENTICATED") return { ok: false, error: "Your session has expired. Sign in again." };
      if (err.code === "VALIDATION" || err.code === "NOT_FOUND" || err.code === "INTERNAL") return { ok: false, error: err.message };
    }
    logger.error("paper_trade.preview_action_failed", { error: err });
    return { ok: false, error: "Something went wrong. Try again." };
  }
}
