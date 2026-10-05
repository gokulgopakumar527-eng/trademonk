/**
 * Read-only ESTIMATE of opening a simulated position. PAPER TRADING — SIMULATION ONLY.
 *
 * Flow:  verified user -> the same strict input as opening -> asset -> gated market-data quote ->
 *        the same simulated-fill arithmetic as opening -> an estimate. NOTHING is written, reserved
 *        or audited, so the browser can show "estimated cost" without calculating any price or fee
 *        itself. The real fill is re-quoted when the trade is opened and may differ.
 */
import { PAPER_SIMULATION_NOTICE, PAPER_TRADING_BANNER } from "@/config/paper-trading";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { PaperTradeRejectedError, type PaperTradeRejectionReason } from "./errors";
import { simulateLongEntry } from "./execution";
import { SCALE, formatScaled, scaledToNumber } from "./money";
import { assessQuoteForValuation } from "./portfolio";
import type { PaperTradingDeps } from "./ports";
import { previewPaperTradeInputSchema } from "./schemas";
import { isOpenablePaperSide, type OpenTradeEstimate } from "./types";

const TEXT: Record<PaperTradeRejectionReason, string> = {
  ASSET_NOT_FOUND: "That asset is not available for paper trading.",
  ASSET_NOT_TRADABLE: "That instrument cannot be paper traded directly.",
  SIDE_NOT_SUPPORTED: "Only BUY and LONG paper trades are supported right now.",
  INVALID_QUANTITY: "That quantity is not valid for this asset.",
  QUOTE_UNAVAILABLE: "A live price is unavailable right now, so no estimate can be shown.",
  QUOTE_STALE: "The latest price is too old to estimate against.",
  QUOTE_NOT_LIVE: "Only a stored price is available right now, so no estimate can be shown.",
  MARKET_CLOSED: "This market is closed, so there is no live price to estimate against.",
  MOCK_DATA_NOT_ALLOWED: "Only mock data is available, which is not allowed here.",
  DATA_INCONSISTENT: "Market data was inconsistent, so no estimate can be shown.",
  INSUFFICIENT_PAPER_CASH: "Not enough paper cash for this trade.", // never produced here; keeps the map exhaustive
  IDEMPOTENCY_KEY_REUSED: "Not applicable here.", // never produced here; keeps the map exhaustive
};

const reject = (reason: PaperTradeRejectionReason, detail?: Record<string, unknown>): never => {
  logger.warn("paper_trade.preview_rejected", { reason, ...detail });
  throw new PaperTradeRejectedError(reason, TEXT[reason]);
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function previewOpenPaperTrade(
  userId: string,
  rawInput: unknown,
  deps: PaperTradingDeps,
): Promise<OpenTradeEstimate> {
  if (typeof userId !== "string" || !UUID.test(userId)) {
    throw new AppError("UNAUTHENTICATED", "Sign in to continue");
  }
  const parsed = previewPaperTradeInputSchema.safeParse(rawInput);
  if (!parsed.success) throw new AppError("VALIDATION", parsed.error.issues[0]?.message ?? "Invalid request");
  const { assetId, side, quantity } = parsed.data;
  if (!isOpenablePaperSide(side)) return reject("SIDE_NOT_SUPPORTED", { side });

  let asset;
  try {
    asset = await deps.store.getAssetById(assetId);
  } catch (error) {
    logger.error("paper_trade.preview_failed", { error, assetId });
    throw new AppError("INTERNAL", "Could not prepare an estimate. Nothing was changed.", error);
  }
  if (!asset) return reject("ASSET_NOT_FOUND", { assetId });
  if (asset.kind === "INDEX") return reject("ASSET_NOT_TRADABLE", { assetId, kind: asset.kind });
  const rates = deps.config.markets[asset.market];
  const startingCash = (deps.config.startingCash as Record<string, number | undefined>)[asset.currency];
  if (!rates || startingCash === undefined) return reject("ASSET_NOT_TRADABLE", { assetId, currency: asset.currency });
  if (asset.kind !== "CRYPTO" && quantity % SCALE !== 0n) return reject("INVALID_QUANTITY", { assetId });
  if (scaledToNumber(quantity) > deps.limits.maxQuantity) return reject("INVALID_QUANTITY", { assetId });

  const now = deps.now();
  let view;
  try {
    view = await deps.marketData.getQuote(asset);
  } catch (error) {
    logger.warn("paper_trade.preview_quote_threw", { error, assetId });
    return reject("QUOTE_UNAVAILABLE", { assetId });
  }
  // The same gates, in the same order, as opening: an estimate is never shown for a price a trade would refuse.
  const a = assessQuoteForValuation(view, asset, now, deps);
  if (!a.ok) return reject(a.reason === "POSITION_NOT_VALUABLE" ? "DATA_INCONSISTENT" : a.reason, { assetId });

  const fill = simulateLongEntry({ referencePrice: a.price, quantity, rates });
  if (fill.notional <= 0n) return reject("INVALID_QUANTITY", { assetId });

  return {
    assetId,
    symbol: asset.symbol,
    side,
    quantity: formatScaled(quantity),
    currency: asset.currency,
    referencePrice: formatScaled(fill.referencePrice),
    estimatedFillPrice: formatScaled(fill.executionPrice),
    estimatedNotional: formatScaled(fill.notional),
    estimatedFee: formatScaled(fill.fee),
    estimatedTotalCost: formatScaled(fill.cashRequired),
    simulation: { version: deps.config.version, slippageBps: Number(fill.appliedSlippageBps), feeBps: Number(fill.appliedFeeBps) },
    quote: a.quote,
    estimatedAt: now.toISOString(),
    banner: PAPER_TRADING_BANNER,
    notice: PAPER_SIMULATION_NOTICE,
  };
}
