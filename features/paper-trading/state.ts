import type { ClosedPaperTrade, OpenedPaperTrade, OpenTradeEstimate } from "@/services/paper-trading/types";

// Type-only re-exports: UI code imports its view types from here, never from the service layer.
export type {
  ClosedTradeHistory,
  ClosedTradeRecord,
  ClosedPaperTrade,
  CurrencyPortfolio,
  OpenedPaperTrade,
  OpenTradeEstimate,
  PaperPortfolio,
  PortfolioPosition,
  PortfolioValuationReason,
} from "@/services/paper-trading/types";

/** PAPER TRADING — SIMULATION ONLY. Result of the open-trade server action. */
export type OpenPaperTradeResult =
  | { ok: true; trade: OpenedPaperTrade }
  | { ok: false; error: string; reason?: string };

/** PAPER TRADING — SIMULATION ONLY. Result of the close-trade server action. */
export type ClosePaperTradeResult =
  | { ok: true; trade: ClosedPaperTrade }
  | { ok: false; error: string; reason?: string };

/** PAPER TRADING — SIMULATION ONLY. Result of the read-only estimate action. */
export type PreviewPaperTradeResult =
  | { ok: true; estimate: OpenTradeEstimate }
  | { ok: false; error: string; reason?: string };

/** A server read that either produced data or says plainly that it could not. Never a zero-filled stand-in. */
export type LoadResult<T> = { ok: true; data: T } | { ok: false; message: string };
