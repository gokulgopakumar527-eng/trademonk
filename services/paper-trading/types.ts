/**
 * Paper-trading domain types. The database enums and tables already exist (Phase 1); these
 * mirror them and add no new storage. A test keeps the enum lists in step with the migrations.
 *
 * PAPER TRADING — NO REAL MONEY. Nothing here represents a real order, fill or balance.
 */
export const PAPER_TRADE_SIDES = ["BUY", "SELL", "LONG", "SHORT"] as const;
export type PaperTradeSide = (typeof PAPER_TRADE_SIDES)[number];

export const PAPER_TRADE_STATUSES = ["OPEN", "CLOSED"] as const;
export type PaperTradeStatus = (typeof PAPER_TRADE_STATUSES)[number];

/** A simulated trade as stored in `paper_trades`. Money fields are plain numbers. */
export interface PaperTrade {
  id: string;
  userId: string;
  assetId: string;
  side: PaperTradeSide;
  /** Server-set at open time; users hold no write privilege on it. */
  entryPrice: number;
  quantity: number;
  stopLoss: number | null;
  takeProfit: number | null;
  fees: number;
  strategyTag: string | null;
  status: PaperTradeStatus;
  openedAt: string;
  createdAt: string;
  updatedAt: string;
}

/** The outcome of a closed simulated trade, as stored in `paper_trade_results`. One per trade. */
export interface PaperTradeResult {
  id: string;
  paperTradeId: string;
  userId: string;
  exitPrice: number;
  fees: number;
  pnl: number;
  closedAt: string;
}

/**
 * Sides a paper trade may be OPENED with. Only fully cash-funded long exposure is modelled:
 * SELL and SHORT would need margin and borrow accounting, which is intentionally not invented.
 * They remain valid enum values (the database type is unchanged) and are rejected with a clear
 * reason rather than approximated.
 */
export const OPENABLE_PAPER_SIDES = ["BUY", "LONG"] as const;
export type OpenablePaperSide = (typeof OPENABLE_PAPER_SIDES)[number];
export const isOpenablePaperSide = (side: PaperTradeSide): side is OpenablePaperSide =>
  (OPENABLE_PAPER_SIDES as readonly string[]).includes(side);

/** What a successful open returns. Everything here is server-derived; nothing is client-supplied. */
export interface OpenedPaperTrade {
  id: string;
  assetId: string;
  side: OpenablePaperSide;
  status: "OPEN";
  quantity: number;
  /** The market price the simulation started from, before slippage. */
  referencePrice: number;
  /** The simulated fill price (reference price plus adverse slippage). */
  entryPrice: number;
  notional: number;
  fee: number;
  /** notional + fee: exactly what left the simulated account. */
  cashDebited: number;
  currency: string;
  cashBalanceAfter: number;
  simulation: { version: string; slippageBps: number; feeBps: number };
  quote: { source: string; asOf: string; fetchedAt: string; isMock: boolean };
  openedAt: string;
  banner: string;
}

/**
 * What a successful close returns. Everything here is server- or database-derived; the client
 * supplied only a trade id. Amounts are plain numbers for display; the exact 8-dp values are what
 * was stored.
 */
export interface ClosedPaperTrade {
  id: string;
  assetId: string;
  side: OpenablePaperSide;
  status: "CLOSED";
  quantity: number;
  /** The market price the exit simulation started from, before slippage. */
  referencePrice: number;
  /** The simulated exit fill (reference price minus adverse slippage). */
  exitPrice: number;
  grossProceeds: number;
  /** The simulated EXIT fee only; the entry fee was charged when the trade opened. */
  exitFee: number;
  /** grossProceeds - exitFee: exactly what entered the simulated account. */
  cashCredited: number;
  /** cashCredited minus what the entry cost (entry notional + entry fee). May be negative. */
  realizedPnl: number;
  currency: string;
  cashBalanceAfter: number;
  simulation: { version: string; slippageBps: number; feeBps: number };
  quote: { source: string; asOf: string; fetchedAt: string; isMock: boolean };
  closedAt: string;
  banner: string;
}

/**
 * Why an open position could not be marked to market. A position is never valued at zero, at its
 * cost, or at a stale price to fill the gap: it is reported UNVALUED with one of these reasons.
 * The first six mirror the gates the open and close flows apply to a quote.
 */
export type PortfolioValuationReason =
  | "QUOTE_UNAVAILABLE"
  | "QUOTE_STALE"
  | "QUOTE_NOT_LIVE"
  | "MARKET_CLOSED"
  | "MOCK_DATA_NOT_ALLOWED"
  | "DATA_INCONSISTENT"
  /** Unsupported side, a row that predates execution accounting, or an instrument the simulator cannot price. */
  | "POSITION_NOT_VALUABLE";

export interface PortfolioQuoteProvenance {
  source: string;
  asOf: string;
  fetchedAt: string;
  isMock: boolean;
}

/** One open position. Every amount is an exact 8-dp decimal string, never a float. */
export interface PortfolioPosition {
  tradeId: string;
  assetId: string;
  symbol: string;
  market: string;
  currency: string;
  side: PaperTradeSide;
  quantity: string;
  /** Entry notional + entry fee, as recorded when the trade opened (cash already left the account). Null if unrecorded. */
  entryCost: string | null;
  openedAt: string;
  valuation:
    | {
        status: "VALUED";
        /** The validated quote price (no slippage, no exit fee). */
        markPrice: string;
        /** round(markPrice * quantity) */
        markValue: string;
        /** markValue - entryCost. May be negative. */
        unrealizedPnl: string;
        quote: PortfolioQuoteProvenance;
      }
    | { status: "UNVALUED"; reason: PortfolioValuationReason };
}

export type PortfolioReconciliationStatus =
  /** cash + open entry cost == starting cash + realized P&L, exactly. */
  | "CONSISTENT"
  /** Both sides computed, but the identity does not hold. `difference` = actual cash - expected cash. */
  | "MISMATCH"
  /** Some stored rows could not be used (missing/unparsable cost, wrong account), so no identity check is claimed. */
  | "INCOMPLETE_RECORDS";

/**
 * One currency's paper portfolio. INR and USDT are never added together: no conversion is modelled.
 * `unrealizedPnl`, `markValue` and `equity` are null (not zero) when any open position is UNVALUED.
 */
export interface CurrencyPortfolio {
  currency: string;
  /** False until the user's first trade provisions the account; cash then shows the configured opening balance. */
  accountExists: boolean;
  startingCash: string;
  cashBalance: string;
  openPositionCount: number;
  /** Sum of entryCost over open positions (entry notional + entry fees). Already OUT of cash; not extra equity. */
  openPositionsEntryCost: string;
  closedTradeCount: number;
  /** Sum of stored realized P&L of closed trades (net of both fees and slippage). */
  realizedPnl: string;
  valuation: "COMPLETE" | "INCOMPLETE";
  unvaluedPositionCount: number;
  markValue: string | null;
  unrealizedPnl: string | null;
  /** cashBalance + markValue. Null when valuation is INCOMPLETE. */
  equity: string | null;
  /** cashBalance + openPositionsEntryCost: equity with open positions held at cost. Needs no quotes. */
  bookValue: string;
  reconciliation: { status: PortfolioReconciliationStatus; difference: string | null };
}

export interface PaperPortfolio {
  banner: string;
  notice: string;
  simulationVersion: string;
  /** The server clock when the valuation was computed. */
  calculatedAt: string;
  currencies: CurrencyPortfolio[];
  positions: PortfolioPosition[];
  /** Stored rows that could not be attributed to an account/currency; non-zero means totals are not trustworthy. */
  unattributedRecords: number;
}

/**
 * A server-computed ESTIMATE of what opening a position would cost right now. Read-only: it
 * writes nothing and reserves nothing. The real fill is re-quoted when the trade is opened and may
 * differ. Amounts are exact 8-dp decimal strings, never floats.
 */
export interface OpenTradeEstimate {
  assetId: string;
  symbol: string;
  side: OpenablePaperSide;
  quantity: string;
  currency: string;
  /** The validated quote price the estimate started from, before slippage. */
  referencePrice: string;
  /** referencePrice plus adverse slippage. */
  estimatedFillPrice: string;
  estimatedNotional: string;
  estimatedFee: string;
  /** notional + fee: what would leave the simulated account. */
  estimatedTotalCost: string;
  simulation: { version: string; slippageBps: number; feeBps: number };
  quote: PortfolioQuoteProvenance;
  estimatedAt: string;
  banner: string;
  notice: string;
}

/**
 * One closed simulated trade, assembled from the STORED trade row and its immutable result row.
 * Nothing here is recomputed; every amount is the exact decimal text the database holds.
 */
export interface ClosedTradeRecord {
  tradeId: string;
  assetId: string;
  symbol: string;
  market: string;
  currency: string;
  side: PaperTradeSide;
  quantity: string;
  entryPrice: string;
  /** Entry fee, from paper_trades.fees. */
  entryFee: string;
  /** Entry notional + entry fee. Null for a row that predates execution accounting. */
  entryCost: string | null;
  openedAt: string;
  exitPrice: string;
  /** The EXIT fee only, from paper_trade_results.fees. */
  exitFee: string;
  /** Null for a result that predates execution accounting. */
  cashCredited: string | null;
  /** Stored realized P&L, net of both fees and both slippages. May be negative. */
  realizedPnl: string;
  closedAt: string;
}

export interface ClosedTradeHistory {
  banner: string;
  notice: string;
  /** Most recent first. */
  trades: ClosedTradeRecord[];
  /** Every closed trade the user has, including those not listed. */
  totalCount: number;
  limit: number;
  truncated: boolean;
}
