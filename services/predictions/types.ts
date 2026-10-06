import type { PredictionDirection } from "@/types/domain";
import type { EngineSnapshot, PredictionTimeframe, SignalAgreement, SignalUsed } from "./engine";
import type { PredictionLifecycle } from "./lifecycle";

/**
 * Columns the server writes on insert. `created_at`, `expires_at`, `content_hash` and
 * `hash_version` are deliberately ABSENT: the database trigger owns them.
 */
export interface NewPredictionRow {
  user_id: string;
  /** Validated client idempotency key (A2). Stored as-is; the database owns uniqueness per user. */
  idempotency_key: string;
  origin: "USER";
  asset_id: string;
  direction: PredictionDirection;
  target_price: number;
  invalidation_price: number;
  horizon_hours: number;
  timeframe: PredictionTimeframe;
  strategy_tag: string;
  rationale: string;
  entry_reference_price: number;
  engine_version: string;
  signal_agreement: number;
  signal_total: 5;
  entry_quote_source: string;
  entry_quote_as_of: string;
  entry_quote_fetched_at: string;
  entry_quote_is_mock: boolean;
  engine_snapshot: EngineSnapshot & { signalsUsed: SignalUsed[]; reasoning: string[] };
}

/** What the database returns after insert: server-owned values only. */
export interface InsertedPredictionRow {
  id: string;
  created_at: string;
  expires_at: string;
  content_hash: string;
  hash_version: number;
}

export interface PredictionView {
  id: string;
  assetId: string;
  direction: PredictionDirection;
  timeframe: PredictionTimeframe;
  horizonHours: number;
  entryReferencePrice: number;
  targetPrice: number;
  invalidationPrice: number;
  reasoning: string[];
  signalsUsed: SignalUsed[];
  signalAgreement: SignalAgreement;
  engineVersion: string;
  entryQuote: { source: string; asOf: string; fetchedAt: string; isMock: boolean };
  /** Server-set by the database. */
  createdAt: string;
  expiresAt: string;
  contentHash: string;
  hashVersion: number;
  lifecycle: PredictionLifecycle;
}

/**
 * Result of creating an engine prediction. `replayed: false` = this call created the row;
 * `replayed: true` = an earlier request with the same (user, idempotencyKey) already created it and
 * this is that ORIGINAL prediction, read back as stored (nothing was recomputed or written).
 */
export interface CreatedPrediction extends PredictionView {
  replayed: boolean;
}

/**
 * An already-persisted engine prediction, as read back for an idempotent replay. Numeric columns are
 * already converted to numbers by the store. Nullable fields are nullable in the table (legacy and
 * manual rows); a row that cannot be turned into a PredictionView is treated as an internal error.
 */
export interface StoredPredictionRecord {
  id: string;
  asset_id: string;
  direction: PredictionDirection;
  timeframe: string | null;
  horizon_hours: number;
  entry_reference_price: number | null;
  target_price: number;
  invalidation_price: number;
  engine_version: string | null;
  signal_agreement: number | null;
  entry_quote_source: string | null;
  entry_quote_as_of: string | null;
  entry_quote_fetched_at: string | null;
  entry_quote_is_mock: boolean | null;
  engine_snapshot: { signalsUsed?: SignalUsed[]; reasoning?: string[] } | null;
  created_at: string;
  expires_at: string;
  content_hash: string;
  hash_version: number;
  /** True when a prediction_results row exists. */
  evaluated: boolean;
}
