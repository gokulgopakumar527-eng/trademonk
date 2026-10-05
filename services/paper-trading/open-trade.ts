/**
 * Opens a simulated paper-trading position. PAPER TRADING — SIMULATION ONLY, NO REAL MONEY.
 *
 * Flow:  verified user -> strict input -> asset -> market-data facade quote (gated) ->
 *        simulated execution (config-driven fixed-point) -> ONE atomic database call.
 *
 * The browser supplies only { assetId, side, quantity, idempotencyKey }. The execution price, fee, slippage,
 * timestamps, user identity and cash are all produced here or in the database. Nothing in this file
 * reaches a provider, `fetch`, or the database directly.
 */
import { PAPER_TRADING_BANNER } from "@/config/paper-trading";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { PaperTradeRejectedError, type PaperTradeRejectionReason } from "./errors";
import { simulateLongEntry } from "./execution";
import { SCALE, formatScaled, priceToScaled, scaledToNumber } from "./money";
import type { PaperTradingDeps } from "./ports";
import { openPaperTradeInputSchema } from "./schemas";
import { isOpenablePaperSide, type OpenedPaperTrade } from "./types";

const REJECT_TEXT: Record<PaperTradeRejectionReason, string> = {
  ASSET_NOT_FOUND: "That asset is not available for paper trading.",
  ASSET_NOT_TRADABLE: "That instrument cannot be paper traded directly. No trade was opened.",
  SIDE_NOT_SUPPORTED:
    "Only BUY and LONG paper trades are supported right now. SELL and SHORT need margin accounting that is not modelled. No trade was opened.",
  INVALID_QUANTITY: "That quantity is not valid for this asset. No trade was opened.",
  QUOTE_UNAVAILABLE: "A live price is unavailable right now, so no paper trade was opened.",
  QUOTE_STALE: "The latest price is too old to trade against, so no paper trade was opened.",
  QUOTE_NOT_LIVE: "Only a stored price is available right now, so no paper trade was opened.",
  MARKET_CLOSED: "This market is closed, so there is no live price. No paper trade was opened.",
  MOCK_DATA_NOT_ALLOWED: "Only mock data is available, which is not allowed here. No paper trade was opened.",
  DATA_INCONSISTENT: "Market data was inconsistent, so no paper trade was opened.",
  INSUFFICIENT_PAPER_CASH: "Not enough paper cash for this trade (including simulated fees). No trade was opened.",
  IDEMPOTENCY_KEY_REUSED: "This request was already used for a different trade. Review the details and try again. No trade was opened.",
};

const reject = (reason: PaperTradeRejectionReason, detail?: Record<string, unknown>): never => {
  logger.warn("paper_trade.rejected", { reason, ...detail });
  throw new PaperTradeRejectedError(reason, REJECT_TEXT[reason]);
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function openPaperTrade(
  userId: string,
  rawInput: unknown,
  deps: PaperTradingDeps,
): Promise<OpenedPaperTrade> {
  // 0. Identity comes from the verified session, passed by the caller. Never from the input.
  if (typeof userId !== "string" || !UUID.test(userId)) {
    throw new AppError("UNAUTHENTICATED", "Sign in to continue");
  }

  // 1. Strict input: anything beyond { assetId, side, quantity, idempotencyKey } is a validation error.
  const parsed = openPaperTradeInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new AppError("VALIDATION", parsed.error.issues[0]?.message ?? "Invalid request");
  }
  const { assetId, side, quantity, idempotencyKey } = parsed.data;
  if (!isOpenablePaperSide(side)) return reject("SIDE_NOT_SUPPORTED", { side });

  // 2. The asset must exist and be tradable in the simulation.
  const asset = await deps.store.getAssetById(assetId);
  if (!asset) return reject("ASSET_NOT_FOUND", { assetId });
  if (asset.kind === "INDEX") return reject("ASSET_NOT_TRADABLE", { assetId, kind: asset.kind });
  const rates = deps.config.markets[asset.market];
  const startingCash = (deps.config.startingCash as Record<string, number | undefined>)[asset.currency];
  if (!rates || startingCash === undefined) return reject("ASSET_NOT_TRADABLE", { assetId, currency: asset.currency });
  // Crypto is fractional; listed equities and ETFs trade in whole units.
  if (asset.kind !== "CRYPTO" && quantity % SCALE !== 0n) return reject("INVALID_QUANTITY", { assetId });
  if (scaledToNumber(quantity) > deps.limits.maxQuantity) return reject("INVALID_QUANTITY", { assetId });

  // 3. Server-observed price, through the market-data facade only. Never accepted from a browser.
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
    return reject("DATA_INCONSISTENT", { assetId });
  }
  const reference = priceToScaled(q.data.price);
  if (reference === null || q.data.price > deps.limits.maxPrice) return reject("DATA_INCONSISTENT", { assetId });

  // 4. Simulated execution. Rates come from the centralised config; fixed-point, half-up rounding.
  const fill = simulateLongEntry({ referencePrice: reference, quantity, rates });
  if (fill.notional <= 0n) return reject("INVALID_QUANTITY", { assetId });

  // 5. One atomic database call: lock account, check cash, debit, insert. All or nothing.
  let stored;
  try {
    stored = await deps.store.openTrade({
      userId,
      assetId,
      side,
      quantity: formatScaled(quantity),
      entryPrice: formatScaled(fill.executionPrice),
      fee: formatScaled(fill.fee),
      startingCash: String(startingCash),
      simVersion: deps.config.version,
      referencePrice: formatScaled(fill.referencePrice),
      slippageBps: fill.appliedSlippageBps,
      feeBps: fill.appliedFeeBps,
      quote: { source: q.data.source, asOf: q.data.asOf, fetchedAt: q.data.fetchedAt, isMock: q.data.isMock },
      idempotencyKey,
    });
  } catch (error) {
    logger.error("paper_trade.open_failed", { error, assetId });
    throw new AppError("INTERNAL", "Could not open the paper trade. Nothing was changed.", error);
  }
  if (!stored.ok) return reject(stored.reason, { assetId });

  // 5b. Replay: this key already opened this exact trade. Return the STORED receipt - never the
  //     fill just computed from a fresh quote - and do nothing else: no second audit, no new debit.
  if (stored.replayed) {
    logger.info("paper_trade.open_replayed", { tradeId: stored.tradeId });
    const r = stored.stored;
    return {
      id: stored.tradeId,
      assetId: r.assetId,
      side,
      status: "OPEN",
      quantity: Number(r.quantity),
      referencePrice: Number(r.referencePrice),
      entryPrice: Number(r.entryPrice),
      notional: Number(r.notional),
      fee: Number(r.fee),
      cashDebited: Number(r.cashDebited),
      currency: stored.currency,
      cashBalanceAfter: Number(stored.cashBalanceAfter),
      simulation: { version: r.simVersion, slippageBps: Number(r.slippageBps), feeBps: Number(r.feeBps) },
      quote: r.quote,
      openedAt: stored.openedAt,
      replayed: true,
      banner: PAPER_TRADING_BANNER,
    };
  }

  // 6. Audit is best-effort and happens after the commit: an audit failure must not turn a
  //    committed trade into an error the user would retry (and double-open).
  try {
    await deps.audit({
      actorId: userId,
      action: "paper_trade.opened",
      entityType: "paper_trade",
      entityId: stored.tradeId,
      metadata: {
        assetId,
        side,
        quantity: formatScaled(quantity),
        referencePrice: formatScaled(fill.referencePrice),
        entryPrice: formatScaled(fill.executionPrice),
        fee: formatScaled(fill.fee),
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
    assetId,
    side,
    status: "OPEN",
    quantity: scaledToNumber(quantity),
    referencePrice: scaledToNumber(fill.referencePrice),
    entryPrice: scaledToNumber(fill.executionPrice),
    notional: scaledToNumber(fill.notional),
    fee: scaledToNumber(fill.fee),
    cashDebited: scaledToNumber(fill.cashRequired),
    currency: stored.currency,
    cashBalanceAfter: Number(stored.cashBalanceAfter),
    simulation: { version: deps.config.version, slippageBps: Number(fill.appliedSlippageBps), feeBps: Number(fill.appliedFeeBps) },
    quote: { source: q.data.source, asOf: q.data.asOf, fetchedAt: q.data.fetchedAt, isMock: q.data.isMock },
    openedAt: stored.openedAt,
    replayed: false,
    banner: PAPER_TRADING_BANNER,
  };
}
