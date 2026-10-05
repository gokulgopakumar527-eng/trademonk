import type { PredictionDirection } from "@/types/domain";
import type { EngineSnapshot, PredictionTimeframe, SignalAgreement, SignalUsed } from "./engine";
import type { PredictionLifecycle } from "./lifecycle";

/**
 * Columns the server writes on insert. `created_at`, `expires_at`, `content_hash` and
 * `hash_version` are deliberately ABSENT: the database trigger owns them.
 */
export interface NewPredictionRow {
  user_id: string;
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
