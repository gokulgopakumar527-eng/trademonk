import "server-only";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { getPaperTradingService } from "@/services/paper-trading";
import { requireUser } from "@/services/profiles/profile-service";
import type { ClosedTradeHistory, LoadResult, PaperPortfolio } from "./state";

export interface PaperTradingPageData {
  portfolio: LoadResult<PaperPortfolio>;
  history: LoadResult<ClosedTradeHistory>;
}

async function load<T>(what: string, read: () => Promise<T>, fallback: string): Promise<LoadResult<T>> {
  try {
    return { ok: true, data: await read() };
  } catch (error) {
    if (error instanceof AppError && error.code === "UNAUTHENTICATED") throw error;
    logger.error("paper_trading.page_load_failed", { what, error });
    return { ok: false, message: error instanceof AppError && error.code === "INTERNAL" ? error.message : fallback };
  }
}

/**
 * Everything the paper-trading page shows, for the SESSION user only (the id is read from the
 * verified session here; the page and the browser never supply one). The two reads are independent:
 * a failure in one leaves the other displayable, and a failure never becomes a zero.
 * Throws UNAUTHENTICATED when there is no session so the page can redirect.
 */
export async function loadPaperTradingPage(): Promise<PaperTradingPageData> {
  const user = await requireUser();
  const service = getPaperTradingService();
  const [portfolio, history] = await Promise.all([
    load("portfolio", () => service.getPortfolio(user.id), "The portfolio could not be calculated right now."),
    load("history", () => service.getClosedTrades(user.id), "The trade history could not be loaded right now."),
  ]);
  return { portfolio, history };
}
