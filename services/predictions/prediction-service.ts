/**
 * Creates engine-generated predictions. Pipeline:
 *   Market data (server quote + closed candles) -> indicators -> market structure
 *   -> deterministic engine -> immutable prediction row.
 *
 * Dependencies are injected so the whole flow is testable without a network or database.
 * This module never calls a provider, fetch() or a browser API: all market data comes through
 * the MarketDataService facade.
 */
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import type { DataView } from "@/services/market-data/market-data-service";
import type { Asset } from "@/services/market-data/types";
import type { CandleSeries, Quote, Timeframe } from "@/types/market";
import { generatePrediction, type EngineResult } from "./engine";
import { PredictionIdempotencyConflictError, PredictionRejectedError } from "./errors";
import { derivePredictionLifecycle } from "./lifecycle";
import { createPredictionInputSchema } from "./schemas";
import type { CreatedPrediction, InsertedPredictionRow, NewPredictionRow, StoredPredictionRecord } from "./types";

export interface PredictionMarketData {
  getQuote(asset: Asset): Promise<DataView<Quote>>;
  getCandles(asset: Asset, timeframe: Timeframe, limit?: number): Promise<DataView<CandleSeries>>;
}

export interface PredictionStore {
  getAssetById(id: string): Promise<Asset | null>;
  /** Throws PredictionIdempotencyConflictError when (user_id, idempotency_key) already exists. */
  insert(row: NewPredictionRow): Promise<InsertedPredictionRow>;
  /** The user's own prediction for this key, as stored, or null. */
  findByIdempotencyKey(userId: string, idempotencyKey: string): Promise<StoredPredictionRecord | null>;
}

export interface PredictionDeps {
  marketData: PredictionMarketData;
  store: PredictionStore;
  audit: (entry: {
    actorId: string;
    action: string;
    entityType: string;
    entityId: string;
    metadata: Record<string, unknown>;
  }) => Promise<void>;
  now: () => Date;
  /** True only in development. Mock quotes are rejected everywhere else. */
  allowMockData: boolean;
}

/** An entry price older than this is refused, even if the facade still calls it fresh. */
export const MAX_ENTRY_QUOTE_AGE_MS = 2 * 60_000;
/** Quotes stamped further in the future than this are treated as inconsistent. */
export const MAX_QUOTE_FUTURE_SKEW_MS = 60_000;
export const CANDLE_LIMIT = 300;
export const STRATEGY_TAG = "trademonk-rules";

const REJECT_TEXT = {
  ASSET_NOT_FOUND: "That asset is not available for predictions.",
  QUOTE_UNAVAILABLE: "A live price is unavailable right now, so no prediction was created.",
  QUOTE_STALE: "The latest price is too old to use as an entry reference, so no prediction was created.",
  QUOTE_NOT_LIVE: "Only a stored price is available right now, so no prediction was created.",
  MARKET_CLOSED: "This market is closed, so there is no live entry price. No prediction was created.",
  MOCK_DATA_NOT_ALLOWED: "Only mock data is available, which is not allowed here. No prediction was created.",
  CANDLES_UNAVAILABLE: "Price history is unavailable right now, so no prediction was created.",
  CANDLES_STALE: "Price history is out of date, so no prediction was created.",
  INSUFFICIENT_DATA: "Not enough closed candles for this timeframe to produce a prediction.",
  DATA_INCONSISTENT: "Market data was inconsistent, so no prediction was created.",
  NO_DIRECTIONAL_SIGNAL:
    "The signals do not agree strongly enough for a directional prediction right now (neutral). Nothing was saved.",
  INVALID_LEVELS: "The computed target and invalidation levels were not valid for this price. Nothing was saved.",
  IDEMPOTENCY_KEY_REUSED:
    "This request was already used for a different prediction. Review the details and try again. No prediction was created.",
} as const;

const reject = (reason: keyof typeof REJECT_TEXT, detail?: Record<string, unknown>): never => {
  logger.warn("prediction.rejected", { reason, ...detail });
  throw new PredictionRejectedError(reason, REJECT_TEXT[reason]);
};

export async function createEnginePrediction(
  userId: string,
  rawInput: unknown,
  deps: PredictionDeps,
): Promise<CreatedPrediction> {
  const parsed = createPredictionInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new AppError("VALIDATION", parsed.error.issues[0]?.message ?? "Invalid request");
  }
  const { assetId, timeframe, idempotencyKey } = parsed.data;
  const intent = { assetId, timeframe };

  // 0. Lookup first, before any market call. A retry of an earlier request returns the ORIGINAL stored
  //    prediction: nothing is re-quoted, recomputed, inserted or audited, so a retry still works when
  //    the market is closed or the quote is stale.
  const existing = await findExisting(deps, userId, idempotencyKey);
  if (existing) return replayOrConflict(existing, intent, deps.now());

  const asset = await deps.store.getAssetById(assetId);
  if (!asset) return reject("ASSET_NOT_FOUND", { assetId });

  const now = deps.now();

  // 1. Server-observed quote. The browser never supplies a price.
  const q = await deps.marketData.getQuote(asset);
  if (!q.ok) return reject("QUOTE_UNAVAILABLE", { code: q.error.code });
  if (q.data.isMock && !deps.allowMockData) return reject("MOCK_DATA_NOT_ALLOWED");
  if (q.servedFrom !== "PROVIDER") return reject("QUOTE_NOT_LIVE");
  if (q.freshness.status === "LAST_CLOSE") return reject("MARKET_CLOSED");
  if (q.freshness.status !== "FRESH") return reject("QUOTE_STALE");
  const quoteAge = now.getTime() - new Date(q.data.asOf).getTime();
  if (Number.isNaN(quoteAge) || quoteAge > MAX_ENTRY_QUOTE_AGE_MS) return reject("QUOTE_STALE", { quoteAge });
  if (quoteAge < -MAX_QUOTE_FUTURE_SKEW_MS) return reject("DATA_INCONSISTENT", { quoteAge });

  // 2. Closed candles for the requested timeframe.
  const c = await deps.marketData.getCandles(asset, timeframe, CANDLE_LIMIT);
  if (!c.ok) return reject("CANDLES_UNAVAILABLE", { code: c.error.code });
  if (c.data.isMock && !deps.allowMockData) return reject("MOCK_DATA_NOT_ALLOWED");
  if (c.freshness.status !== "FRESH") return reject("CANDLES_STALE");

  // 3. Deterministic engine.
  const outcome = generatePrediction({ timeframe, candles: c.data.candles, quote: q.data, now });
  if (outcome.status === "INSUFFICIENT_DATA") {
    return reject("INSUFFICIENT_DATA", { needed: outcome.needed, have: outcome.have });
  }
  if (outcome.status === "INVALID_INPUT") {
    const reason = /levels/i.test(outcome.reason) || /ATR/.test(outcome.reason) ? "INVALID_LEVELS" : "DATA_INCONSISTENT";
    return reject(reason, { detail: outcome.reason });
  }
  const result = outcome.result;
  if (result.direction === "NEUTRAL" || result.targetPrice === null || result.invalidationPrice === null) {
    return reject("NO_DIRECTIONAL_SIGNAL", { agreeing: result.signalAgreement.agreeing });
  }

  // 4. Persist. created_at / expires_at / content_hash are set by the database trigger.
  const row = toRow(userId, idempotencyKey, assetId, result, q.data);
  let inserted: InsertedPredictionRow;
  try {
    inserted = await deps.store.insert(row);
  } catch (error) {
    if (error instanceof PredictionIdempotencyConflictError) {
      // Lost a concurrent race on (user_id, idempotency_key): the winner's row is authoritative.
      const winner = await findExisting(deps, userId, idempotencyKey);
      if (!winner) {
        logger.error("prediction.idempotency_race_unresolved", { assetId });
        throw new AppError("INTERNAL", "Could not save the prediction", error);
      }
      return replayOrConflict(winner, intent, deps.now());
    }
    logger.error("prediction.insert_failed", { error, assetId });
    throw new AppError("INTERNAL", "Could not save the prediction", error);
  }

  await deps.audit({
    actorId: userId,
    action: "prediction.created",
    entityType: "prediction",
    entityId: inserted.id,
    metadata: {
      assetId,
      direction: result.direction,
      timeframe,
      signalAgreement: result.signalAgreement.agreeing,
      engineVersion: result.engineVersion,
      contentHash: inserted.content_hash,
    },
  });

  return {
    replayed: false,
    id: inserted.id,
    assetId,
    direction: result.direction,
    timeframe,
    horizonHours: result.horizonHours,
    entryReferencePrice: result.entryReferencePrice,
    targetPrice: result.targetPrice,
    invalidationPrice: result.invalidationPrice,
    reasoning: result.reasoning,
    signalsUsed: result.signalsUsed,
    signalAgreement: result.signalAgreement,
    engineVersion: result.engineVersion,
    entryQuote: { source: q.data.source, asOf: q.data.asOf, fetchedAt: q.data.fetchedAt, isMock: q.data.isMock },
    createdAt: inserted.created_at,
    expiresAt: inserted.expires_at,
    contentHash: inserted.content_hash,
    hashVersion: inserted.hash_version,
    lifecycle: derivePredictionLifecycle(
      { createdAt: inserted.created_at, expiresAt: inserted.expires_at },
      now,
      { justCreated: true },
    ),
  };
}

async function findExisting(
  deps: PredictionDeps,
  userId: string,
  idempotencyKey: string,
): Promise<StoredPredictionRecord | null> {
  try {
    return await deps.store.findByIdempotencyKey(userId, idempotencyKey);
  } catch (error) {
    logger.error("prediction.idempotency_lookup_failed", { error });
    throw new AppError("INTERNAL", "Could not save the prediction", error);
  }
}

/**
 * Same key + same intent (asset, timeframe) = replay of the original. Same key + any other intent =
 * IDEMPOTENCY_KEY_REUSED. The engine output (direction, levels, horizon) is NOT part of the intent:
 * it is derived server-side from live data and may legitimately differ on a retry, which is exactly
 * why the stored row is returned and never recomputed.
 */
function replayOrConflict(
  stored: StoredPredictionRecord,
  intent: { assetId: string; timeframe: string },
  now: Date,
): CreatedPrediction {
  if (stored.asset_id !== intent.assetId || stored.timeframe !== intent.timeframe) {
    return reject("IDEMPOTENCY_KEY_REUSED", { predictionId: stored.id });
  }
  logger.info("prediction.create_replayed", { predictionId: stored.id });
  return storedToView(stored, now);
}

function storedToView(r: StoredPredictionRecord, now: Date): CreatedPrediction {
  const snap = r.engine_snapshot;
  if (
    r.engine_version === null ||
    r.timeframe === null ||
    r.entry_reference_price === null ||
    r.signal_agreement === null ||
    r.entry_quote_source === null ||
    r.entry_quote_as_of === null ||
    r.entry_quote_fetched_at === null ||
    r.entry_quote_is_mock === null ||
    !Array.isArray(snap?.signalsUsed) ||
    !Array.isArray(snap?.reasoning)
  ) {
    logger.error("prediction.replay_row_incomplete", { predictionId: r.id });
    throw new AppError("INTERNAL", "Could not load the saved prediction");
  }
  return {
    replayed: true,
    id: r.id,
    assetId: r.asset_id,
    direction: r.direction,
    timeframe: r.timeframe as CreatedPrediction["timeframe"],
    horizonHours: r.horizon_hours,
    entryReferencePrice: r.entry_reference_price,
    targetPrice: r.target_price,
    invalidationPrice: r.invalidation_price,
    reasoning: snap.reasoning,
    signalsUsed: snap.signalsUsed,
    // Only directional predictions are stored, and a direction needs a majority on its own side.
    signalAgreement: { agreeing: r.signal_agreement, total: 5, side: r.direction },
    engineVersion: r.engine_version,
    entryQuote: { source: r.entry_quote_source, asOf: r.entry_quote_as_of, fetchedAt: r.entry_quote_fetched_at, isMock: r.entry_quote_is_mock },
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    contentHash: r.content_hash,
    hashVersion: r.hash_version,
    lifecycle: derivePredictionLifecycle({ createdAt: r.created_at, expiresAt: r.expires_at }, now, { evaluated: r.evaluated }),
  };
}

function toRow(userId: string, idempotencyKey: string, assetId: string, r: EngineResult, quote: Quote): NewPredictionRow {
  return {
    user_id: userId,
    idempotency_key: idempotencyKey,
    origin: "USER",
    asset_id: assetId,
    direction: r.direction as "BULLISH" | "BEARISH",
    target_price: r.targetPrice!,
    invalidation_price: r.invalidationPrice!,
    horizon_hours: r.horizonHours,
    timeframe: r.timeframe,
    strategy_tag: STRATEGY_TAG,
    rationale: r.reasoning.join("\n").slice(0, 4000),
    entry_reference_price: r.entryReferencePrice,
    engine_version: r.engineVersion,
    signal_agreement: r.signalAgreement.agreeing,
    signal_total: 5,
    entry_quote_source: quote.source,
    entry_quote_as_of: quote.asOf,
    entry_quote_fetched_at: quote.fetchedAt,
    entry_quote_is_mock: quote.isMock,
    engine_snapshot: { ...r.snapshot, signalsUsed: r.signalsUsed, reasoning: r.reasoning },
  };
}
