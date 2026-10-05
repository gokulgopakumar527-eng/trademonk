import { AppError, type AppErrorCode } from "@/lib/errors";

export type PredictionRejectionReason =
  | "ASSET_NOT_FOUND"
  | "QUOTE_UNAVAILABLE"
  | "QUOTE_STALE"
  | "QUOTE_NOT_LIVE"
  | "MARKET_CLOSED"
  | "MOCK_DATA_NOT_ALLOWED"
  | "CANDLES_UNAVAILABLE"
  | "CANDLES_STALE"
  | "INSUFFICIENT_DATA"
  | "DATA_INCONSISTENT"
  | "NO_DIRECTIONAL_SIGNAL"
  | "INVALID_LEVELS";

const CODE: Record<PredictionRejectionReason, AppErrorCode> = {
  ASSET_NOT_FOUND: "NOT_FOUND",
  QUOTE_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  QUOTE_STALE: "PROVIDER_UNAVAILABLE",
  QUOTE_NOT_LIVE: "PROVIDER_UNAVAILABLE",
  MARKET_CLOSED: "PROVIDER_UNAVAILABLE",
  MOCK_DATA_NOT_ALLOWED: "PROVIDER_UNAVAILABLE",
  CANDLES_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  CANDLES_STALE: "PROVIDER_UNAVAILABLE",
  INSUFFICIENT_DATA: "VALIDATION",
  DATA_INCONSISTENT: "PROVIDER_UNAVAILABLE",
  NO_DIRECTIONAL_SIGNAL: "VALIDATION",
  INVALID_LEVELS: "VALIDATION",
};

/** A prediction was refused. `message` is safe to show to the user. */
export class PredictionRejectedError extends AppError {
  constructor(
    public readonly reason: PredictionRejectionReason,
    message: string,
  ) {
    super(CODE[reason], message);
    this.name = "PredictionRejectedError";
  }
}
