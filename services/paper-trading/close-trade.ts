/**
 * Closes a simulated paper-trading position. PAPER TRADING — SIMULATION ONLY, NO REAL MONEY.
 *
 * Flow:  verified user -> strict input { tradeId } -> the caller's own OPEN trade -> its asset ->
 *        market-data facade exit quote (gated) -> simulated exit (config-driven fixed-point) ->
 *        ONE atomic database call -> best-effort audit.
 *
 * The browser supplies only a trade id. The exit price, fee, slippage, P&L, timestamps, user
 * identity and cash are all produced here or in the database. Nothing in this file reaches a
 * provider, `fetch`, or the database directly.
 *
 * Accounting is the existing BUY/LONG-only model: a close is a simulated sell, slippage is adverse
 * (the fill is LOWER than the quote), and realized P&L = (gross proceeds - exit fee) - (entry
 * notional + entry fee). No short selling, margin or leverage is modelled.
 */
import { PAPER_TRADING_BANNER } from "@/config/paper-trading";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { PaperTradeRejectedError, type PaperTradeAnyRejectionReason } from "./errors";
import { realizedLongPnl, simulateLongExit } from "./execution";
import {
  formatScaled,
  formatSignedScaled,
  parseDecimalAmount,
  parseQuantity,
  priceToScaled,
  scaledToNumber,
  signedScaledToNumber,
} from "./money";
import type { PaperTradingDeps } from "./ports";
import { closePaperTradeInputSchema } from "./schemas";
import { isOpenablePaperSide, type ClosedPaperTrade } from "./types";

const REJECT_TEXT: Record<PaperTradeAnyRejectionReason, string> = {
  TRADE_NOT_FOUND: "That paper trade was not found.",
  TRADE_ALREADY_CLOSED: "That paper trade is already closed. Nothing was changed.",
  TRADE_NOT_CLOSABLE: "That paper trade cannot be settled by the simulator. Nothing was changed.",
  ASSET_NOT_FOUND: "That asset is no longer available for paper trading. The trade remains open.",
  ASSET_NOT_TRADABLE: "That instrument cannot be paper traded. The trade remains open.",
  SIDE_NOT_SUPPORTED: "Only BUY and LONG paper trades can be closed here. Nothing was changed.",
  INVALID_QUANTITY: "The recorded quantity is not valid. Nothing was changed.",
  QUOTE_UNAVAILABLE: "A live price is unavailable right now, so the paper trade was not closed. It remains open.",
  QUOTE_STALE: "The latest price is too old to close against, so the paper trade was not closed. It remains open.",
  QUOTE_NOT_LIVE: "Only a stored price is available right now, so the paper trade was not closed. It remains open.",
  MARKET_CLOSED: "This market is closed, so there is no live price. The paper trade was not closed and remains open.",
  MOCK_DATA_NOT_ALLOWED: "Only mock data is available, which is not allowed here. The paper trade remains open.",
  DATA_INCONSISTENT: "Market data was inconsistent, so the paper trade was not closed. It remains open.",
  INSUFFICIENT_PAPER_CASH: "Not enough paper cash. Nothing was changed.", // never produced by a close; keeps the map exhaustive
  IDEMPOTENCY_KEY_REUSED: "Not applicable here.", // never produced here; keeps the map exhaustive
};

const reject = (reason: PaperTradeAnyRejectionReason, detail?: Record<string, unknown>): never => {
  logger.warn("paper_trade.close_rejected", { reason, ...detail });
  throw new PaperTradeRejectedError(reason, REJECT_TEXT[reason]);
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function closePaperTrade(
  userId: string,
  rawInput: unknown,
  deps: PaperTradingDeps,
): Promise<ClosedPaperTrade> {
  // 0. Identity comes from the verified session, passed by the caller. Never from the input.
  if (typeof userId !== "string" || !UUID.test(userId)) {
    throw new AppError("UNAUTHENTICATED", "Sign in to continue");
  }

  // 1. Strict input: anything beyond { tradeId } is a validation error.
  const parsed = closePaperTradeInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new AppError("VALIDATION", parsed.error.issues[0]?.message ?? "Invalid request");
  }
  const { tradeId } = parsed.data;

  // 2. The trade must exist, belong to this user and still be OPEN. The lookup is owner-scoped, so
  //    someone else's trade looks exactly like a missing one. (The database re-checks all of this
  //    under a row lock: this read is an early exit, not the guard against concurrent closes.)
  let trade;
  try {
    trade = await deps.store.getTradeForClose(userId, tradeId);
  } catch (error) {
    logger.error("paper_trade.close_lookup_failed", { error, tradeId });
    throw new AppError("INTERNAL", "Could not close the paper trade. Nothing was changed.", error);
  }
  if (!trade || trade.userId !== userId || trade.tradeId !== tradeId) return reject("TRADE_NOT_FOUND", { tradeId });
  if (trade.status !== "OPEN") return reject("TRADE_ALREADY_CLOSED", { tradeId });
  if (!isOpenablePaperSide(trade.side)) return reject("SIDE_NOT_SUPPORTED", { tradeId, side: trade.side });
  if (trade.simVersion === null) return reject("TRADE_NOT_CLOSABLE", { tradeId });
  const quantity = parseQuantity(trade.quantity);
  const cashDebited = parseDecimalAmount(trade.cashDebited);
  if (quantity === null || cashDebited === null) return reject("DATA_INCONSISTENT", { tradeId });

  // 3. The asset, and the market's simulation assumptions from the centralised config.
  const asset = trade.asset;
  if (asset.id !== trade.assetId) return reject("DATA_INCONSISTENT", { tradeId });
  if (asset.kind === "INDEX") return reject("ASSET_NOT_TRADABLE", { tradeId, kind: asset.kind });
  const rates = deps.config.markets[asset.market];
  if (!rates) return reject("ASSET_NOT_TRADABLE", { tradeId, market: asset.market });

  // 4. Server-observed exit price, through the market-data facade only. Same gates as opening:
  //    unavailable, mock, stored, closed-market, stale, future-dated, wrong identity, bad price all
  //    reject BEFORE any write, so the trade and the account are untouched.
  const now = deps.now();
  const q = await deps.marketData.getQuote(asset);
  if (!q.ok) return reject("QUOTE_UNAVAILABLE", { code: q.error.code });
  if (q.data.isMock && !deps.allowMockData) return reject("MOCK_DATA_NOT_ALLOWED");
  if (q.servedFrom !== "PROVIDER") return reject("QUOTE_NOT_LIVE");
  if (q.freshness.status === "LAST_CLOSE") return reject("MARKET_CLOSED");
  if (q.freshness.status !== "FRESH") return reject("QUOTE_STALE");
  const age = now.getTime() - new Date(q.data.asOf).getTime();
  if (Number.isNaN(age) || age > deps.limits.maxQuoteAgeMs) return reject("QUOTE_STALE", { age });
  if (age < -deps.limits.maxQuoteFutureSkewMs) return reject("DATA_INCONSISTENT", { age });
  if (q.data.market !== asset.market || q.data.symbol !== asset.symbol || q.data.currency !== asset.currency) {
    return reject("DATA_INCONSISTENT", { tradeId });
  }
  const reference = priceToScaled(q.data.price);
  if (reference === null || q.data.price > deps.limits.maxPrice) return reject("DATA_INCONSISTENT", { tradeId });

  // 5. Simulated exit and realized P&L. Fixed-point, half-up rounding, centralised rates.
  const fill = simulateLongExit({ referencePrice: reference, quantity, rates });
  if (fill.executionPrice <= 0n || fill.grossProceeds <= 0n) return reject("DATA_INCONSISTENT", { tradeId });
  const pnl = realizedLongPnl({ cashCredited: fill.cashCredited, cashDebited });

  // 6. One atomic database call: lock trade, re-derive, credit account, write result, mark CLOSED.
  //    All or nothing; a repeated or concurrent close finds the trade CLOSED and is refused.
  let stored;
  try {
    stored = await deps.store.closeTrade({
      userId,
      tradeId,
      exitPrice: formatScaled(fill.executionPrice),
      fee: formatScaled(fill.fee),
      pnl: formatSignedScaled(pnl),
      simVersion: deps.config.version,
      referencePrice: formatScaled(fill.referencePrice),
      slippageBps: fill.appliedSlippageBps,
      feeBps: fill.appliedFeeBps,
      quote: { source: q.data.source, asOf: q.data.asOf, fetchedAt: q.data.fetchedAt, isMock: q.data.isMock },
    });
  } catch (error) {
    logger.error("paper_trade.close_failed", { error, tradeId });
    throw new AppError("INTERNAL", "Could not close the paper trade. Nothing was changed.", error);
  }
  if (!stored.ok) return reject(stored.reason, { tradeId });

  // 7. Audit is best-effort and happens after the commit: an audit failure must not turn a
  //    committed close into an error the user would retry.
  try {
    await deps.audit({
      actorId: userId,
      action: "paper_trade.closed",
      entityType: "paper_trade",
      entityId: stored.tradeId,
      metadata: {
        assetId: asset.id,
        side: trade.side,
        quantity: formatScaled(quantity),
        referencePrice: formatScaled(fill.referencePrice),
        exitPrice: formatScaled(fill.executionPrice),
        exitFee: formatScaled(fill.fee),
        realizedPnl: formatSignedScaled(pnl),
        simVersion: deps.config.version,
        quoteSource: q.data.source,
        quoteAsOf: q.data.asOf,
      },
    });
  } catch (error) {
    logger.error("paper_trade.audit_failed", { error, tradeId: stored.tradeId });
  }

  return {
    id: stored.tradeId,
    assetId: asset.id,
    side: trade.side,
    status: "CLOSED",
    quantity: scaledToNumber(quantity),
    referencePrice: scaledToNumber(fill.referencePrice),
    exitPrice: scaledToNumber(fill.executionPrice),
    grossProceeds: scaledToNumber(fill.grossProceeds),
    exitFee: scaledToNumber(fill.fee),
    cashCredited: scaledToNumber(fill.cashCredited),
    realizedPnl: signedScaledToNumber(pnl),
    currency: stored.currency,
    cashBalanceAfter: Number(stored.cashBalanceAfter),
    simulation: { version: deps.config.version, slippageBps: Number(fill.appliedSlippageBps), feeBps: Number(fill.appliedFeeBps) },
    quote: { source: q.data.source, asOf: q.data.asOf, fetchedAt: q.data.fetchedAt, isMock: q.data.isMock },
    closedAt: stored.closedAt,
    banner: PAPER_TRADING_BANNER,
  };
}
