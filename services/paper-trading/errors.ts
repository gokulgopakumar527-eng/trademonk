import { AppError, type AppErrorCode } from "@/lib/errors";

export type PaperTradeRejectionReason =
  | "ASSET_NOT_FOUND"
  | "ASSET_NOT_TRADABLE"
  | "SIDE_NOT_SUPPORTED"
  | "INVALID_QUANTITY"
  | "QUOTE_UNAVAILABLE"
  | "QUOTE_STALE"
  | "QUOTE_NOT_LIVE"
  | "MARKET_CLOSED"
  | "MOCK_DATA_NOT_ALLOWED"
  | "DATA_INCONSISTENT"
  | "INSUFFICIENT_PAPER_CASH"
  | "IDEMPOTENCY_KEY_REUSED";

/** Reasons only the close flow can produce. Kept apart so the open flow's exhaustive maps are unchanged. */
export type PaperTradeCloseOnlyReason = "TRADE_NOT_FOUND" | "TRADE_ALREADY_CLOSED" | "TRADE_NOT_CLOSABLE";

export type PaperTradeAnyRejectionReason = PaperTradeRejectionReason | PaperTradeCloseOnlyReason;

const CODE: Record<PaperTradeAnyRejectionReason, AppErrorCode> = {
  TRADE_NOT_FOUND: "NOT_FOUND",
  TRADE_ALREADY_CLOSED: "VALIDATION",
  TRADE_NOT_CLOSABLE: "VALIDATION",
  ASSET_NOT_FOUND: "NOT_FOUND",
  ASSET_NOT_TRADABLE: "VALIDATION",
  SIDE_NOT_SUPPORTED: "VALIDATION",
  INVALID_QUANTITY: "VALIDATION",
  QUOTE_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  QUOTE_STALE: "PROVIDER_UNAVAILABLE",
  QUOTE_NOT_LIVE: "PROVIDER_UNAVAILABLE",
  MARKET_CLOSED: "PROVIDER_UNAVAILABLE",
  MOCK_DATA_NOT_ALLOWED: "PROVIDER_UNAVAILABLE",
  DATA_INCONSISTENT: "PROVIDER_UNAVAILABLE",
  INSUFFICIENT_PAPER_CASH: "VALIDATION",
  IDEMPOTENCY_KEY_REUSED: "VALIDATION",
};

/** A paper trade was refused and nothing was created, closed, debited or credited. `message` is safe to show. */
export class PaperTradeRejectedError extends AppError {
  constructor(
    public readonly reason: PaperTradeAnyRejectionReason,
    message: string,
  ) {
    super(CODE[reason], message);
    this.name = "PaperTradeRejectedError";
  }
}
