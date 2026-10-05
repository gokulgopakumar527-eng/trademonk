/**
 * Paper-trading service. PAPER TRADING — NO REAL MONEY.
 *
 * Phase 5C-2 added opening a position; Phase 5C-3 closing one (with its realized P&L); Phase 5C-4 a
 * read-only portfolio calculation; Phase 5C-5 two read-only helpers for the UI (an open-cost estimate
 * and the closed-trade history). Analytics beyond these do not exist yet. Every dependency is injected so the
 * whole flow is testable with no network and no database.
 */
import {
  PAPER_SIMULATION_NOTICE,
  PAPER_TRADING_BANNER,
  type PaperSimulationConfig,
} from "@/config/paper-trading";
import { closePaperTrade } from "./close-trade";
import { getClosedPaperTrades } from "./history";
import { openPaperTrade } from "./open-trade";
import { previewOpenPaperTrade } from "./preview";
import { getPaperPortfolio } from "./portfolio";
import type { PaperTradingDeps } from "./ports";
import type { ClosedPaperTrade, ClosedTradeHistory, OpenedPaperTrade, OpenTradeEstimate, PaperPortfolio } from "./types";

export interface PaperSimulationAssumptions {
  banner: string;
  notice: string;
  config: Readonly<PaperSimulationConfig>;
}

export interface PaperTradingService {
  /** The labelled assumptions every simulated trade is priced under. Read-only. */
  getSimulationAssumptions(): PaperSimulationAssumptions;
  /**
   * Opens a simulated position for the VERIFIED user. `userId` must come from the authenticated
   * session; `rawInput` is the untrusted client payload and may contain only { assetId, side, quantity }.
   */
  openTrade(userId: string, rawInput: unknown): Promise<OpenedPaperTrade>;
  /**
   * Closes one of the VERIFIED user's OPEN positions at a server-observed price. `userId` must come
   * from the authenticated session; `rawInput` is the untrusted client payload and may contain
   * only { tradeId }. The exit price, fee, P&L and time are never accepted from the client.
   */
  closeTrade(userId: string, rawInput: unknown): Promise<ClosedPaperTrade>;
  /**
   * Read-only portfolio for the VERIFIED user: cash, open-position entry cost, realized and
   * unrealized P&L and equity per currency, from database records and gated market quotes.
   * Accepts no client input (any supplied field is rejected). See portfolio.ts for the definitions.
   */
  getPortfolio(userId: string, rawInput?: unknown): Promise<PaperPortfolio>;
  /**
   * Read-only ESTIMATE of opening a position (same strict input as openTrade). Writes nothing.
   * The real fill is re-quoted on open and may differ.
   */
  previewOpenTrade(userId: string, rawInput: unknown): Promise<OpenTradeEstimate>;
  /**
   * Read-only closed-trade history for the VERIFIED user, from stored records (newest first, capped,
   * with the true total). Accepts no client input.
   */
  getClosedTrades(userId: string, rawInput?: unknown): Promise<ClosedTradeHistory>;
}

export function createPaperTradingService(deps: PaperTradingDeps): PaperTradingService {
  return {
    getSimulationAssumptions: () => ({
      banner: PAPER_TRADING_BANNER,
      notice: PAPER_SIMULATION_NOTICE,
      config: deps.config,
    }),
    openTrade: (userId, rawInput) => openPaperTrade(userId, rawInput, deps),
    closeTrade: (userId, rawInput) => closePaperTrade(userId, rawInput, deps),
    getPortfolio: (userId, rawInput) => getPaperPortfolio(userId, rawInput, deps),
    previewOpenTrade: (userId, rawInput) => previewOpenPaperTrade(userId, rawInput, deps),
    getClosedTrades: (userId, rawInput) => getClosedPaperTrades(userId, rawInput, deps),
  };
}
