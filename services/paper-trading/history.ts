/**
 * Closed-trade history. PAPER TRADING — SIMULATION ONLY, NO REAL MONEY.
 *
 * Read-only. Every figure is the exact decimal text STORED when the trade was opened and closed
 * (paper_trades + the immutable paper_trade_results row). Nothing is recomputed, so what the user
 * sees is the authoritative record. An unreadable amount fails the whole read rather than being
 * shown as zero. Accepts no client input.
 */
import { PAPER_SIMULATION_NOTICE, PAPER_TRADING_BANNER } from "@/config/paper-trading";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { formatScaled, formatSignedScaled, parseDecimalAmount, parseSignedDecimalAmount } from "./money";
import type { ClosedTradePage, PaperTradingDeps } from "./ports";
import { closedTradesInputSchema } from "./schemas";
import type { ClosedTradeHistory, ClosedTradeRecord } from "./types";

/** Most recent closed trades listed. The true total is always reported alongside. */
export const CLOSED_TRADE_HISTORY_LIMIT = 50;

const FAILED = "Could not load the paper trade history. Nothing was changed.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mustAmount(text: unknown, signed: boolean, what: string): string {
  const v = signed ? parseSignedDecimalAmount(text) : parseDecimalAmount(text);
  if (v === null) {
    logger.error("paper_history.unparsable_amount", { what });
    throw new AppError("INTERNAL", FAILED);
  }
  return signed ? formatSignedScaled(v) : formatScaled(v);
}

const optionalAmount = (text: string | null, what: string): string | null => (text === null ? null : mustAmount(text, false, what));

export async function getClosedPaperTrades(
  userId: string,
  rawInput: unknown,
  deps: PaperTradingDeps,
): Promise<ClosedTradeHistory> {
  if (typeof userId !== "string" || !UUID.test(userId)) throw new AppError("UNAUTHENTICATED", "Sign in to continue");
  if (!closedTradesInputSchema.safeParse(rawInput).success) {
    throw new AppError("VALIDATION", "A history request takes no input");
  }

  let page: ClosedTradePage;
  try {
    page = await deps.store.getClosedTrades(userId, CLOSED_TRADE_HISTORY_LIMIT);
  } catch (error) {
    logger.error("paper_history.read_failed", { error });
    throw new AppError("INTERNAL", FAILED, error);
  }
  if (page.rows.some((r) => r.userId !== userId)) {
    // A store that returned someone else's rows is a bug or an attack: expose nothing.
    logger.error("paper_history.ownership_violation", {});
    throw new AppError("INTERNAL", FAILED);
  }
  if (!Number.isInteger(page.totalCount) || page.totalCount < page.rows.length) {
    logger.error("paper_history.inconsistent_count", {});
    throw new AppError("INTERNAL", FAILED);
  }

  const trades: ClosedTradeRecord[] = page.rows.map((r) => ({
    tradeId: r.tradeId,
    assetId: r.asset.id,
    symbol: r.asset.symbol,
    market: r.asset.market,
    currency: r.asset.currency,
    side: r.side,
    quantity: mustAmount(r.quantity, false, "quantity"),
    entryPrice: mustAmount(r.entryPrice, false, "entry_price"),
    entryFee: mustAmount(r.entryFee, false, "entry fee"),
    entryCost: optionalAmount(r.entryCost, "cash_debited"),
    openedAt: r.openedAt,
    exitPrice: mustAmount(r.exitPrice, false, "exit_price"),
    exitFee: mustAmount(r.exitFee, false, "exit fee"),
    cashCredited: optionalAmount(r.cashCredited, "cash_credited"),
    realizedPnl: mustAmount(r.pnl, true, "pnl"),
    closedAt: r.closedAt,
  }));

  return {
    banner: PAPER_TRADING_BANNER,
    notice: PAPER_SIMULATION_NOTICE,
    trades,
    totalCount: page.totalCount,
    limit: CLOSED_TRADE_HISTORY_LIMIT,
    truncated: page.totalCount > trades.length,
  };
}
