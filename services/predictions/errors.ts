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
  | "INVALID_LEVELS"
  /** The same idempotency key was already used for a different prediction intent. */
  | "IDEMPOTENCY_KEY_REUSED";

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
  IDEMPOTENCY_KEY_REUSED: "VALIDATION",
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

/** Name of the A1 partial unique index on (user_id, idempotency_key). Must match the migration. */
export const PREDICTION_IDEMPOTENCY_INDEX = "predictions_user_idempotency_key_uidx";

/**
 * Thrown by a store when an insert lost the (user_id, idempotency_key) race: another request already
 * persisted a prediction for the same user and key. It carries NO database detail and is never shown
 * to a caller; the service catches it and reconciles against the winning row.
 */
export class PredictionIdempotencyConflictError extends Error {
  constructor() {
    super("A prediction already exists for this idempotency key");
    this.name = "PredictionIdempotencyConflictError";
  }
}

/**
 * True only for a PostgreSQL unique violation (SQLSTATE 23505) on the idempotency index. Other unique
 * violations (for example the primary key) and every other database error are NOT conflicts and must
 * keep propagating as failures.
 */
export function isPredictionIdempotencyViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { code?: unknown; message?: unknown; details?: unknown };
  if (e.code !== "23505") return false;
  const text = `${typeof e.message === "string" ? e.message : ""} ${typeof e.details === "string" ? e.details : ""}`;
  return text.includes(PREDICTION_IDEMPOTENCY_INDEX);
}
