/**
 * Prediction evaluator. Pipeline:
 *
 *   due prediction -> eligibility -> (already evaluated? stop) -> server quote + closed candles via
 *   the MarketDataService facade -> deterministic rules -> immutable prediction_results row.
 *
 * Nothing here calls a provider, fetch(), a browser API or accepts a price from a caller: the
 * evaluation price and the candles come only from the injected market-data facade, and every
 * timestamp that matters (evaluation time, result hash) is written by the database.
 *
 * Failure policy: when market data is unavailable, stale, inconsistent or incomplete the
 * prediction is NOT marked correct or incorrect. The outcome is UNAVAILABLE, the attempt is
 * audited, and the prediction stays due so a later run can evaluate it properly.
 *
 * Idempotency: a result is looked up before any market call, and the UNIQUE(prediction_id)
 * constraint is the final arbiter for concurrent runs. A duplicate insert is reported as
 * ALREADY_EVALUATED; an existing result is never overwritten (the table is append-only).
 */
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import type { Asset } from "@/services/market-data/types";
import { TIMEFRAME_MS, type Timeframe } from "@/types/market";
import { PREDICTION_TIMEFRAMES } from "./engine";
import {
  EVALUATION_RULE,
  EVALUATOR_VERSION,
  evaluatePath,
  OUTCOME_LABEL,
  type OutcomeLabel,
  type StoredOutcome,
} from "./evaluation-rules";
import { evaluationRunInputSchema } from "./schemas";
import { MAX_ENTRY_QUOTE_AGE_MS, MAX_QUOTE_FUTURE_SKEW_MS, type PredictionMarketData } from "./prediction-service";

/** The immutable prediction, as the evaluator needs it. Read with the service role. */
export interface EvaluablePrediction {
  id: string;
  assetId: string;
  direction: "BULLISH" | "BEARISH";
  targetPrice: number;
  invalidationPrice: number;
  horizonHours: number;
  timeframe: string | null;
  entryReferencePrice: number | null;
  engineVersion: string | null;
  entryQuoteIsMock: boolean | null;
  createdAt: string;
  expiresAt: string;
  contentHash: string;
}

export interface NewResultRow {
  prediction_id: string;
  status: StoredOutcome;
  exit_price: number;
  /** Not computed here: entry and evaluation prices are both stored, so any return is derivable. */
  return_pct: null;
  evaluation_meta: EvaluationMeta;
}

/** What the database returns: every server-owned value. */
export interface StoredResult {
  id: string;
  predictionId: string;
  status: StoredOutcome;
  closedAt: string;
  exitPrice: number;
  contentHash: string;
}

export class DuplicateResultError extends Error {
  constructor(public readonly predictionId: string) {
    super(`A result already exists for prediction ${predictionId}`);
    this.name = "DuplicateResultError";
  }
}

export interface EvaluatorStore {
  /** Engine predictions past their horizon with no result (and not in a deferral cooldown). */
  listDue(limit: number): Promise<EvaluablePrediction[]>;
  getPrediction(id: string): Promise<EvaluablePrediction | null>;
  getAssetById(id: string): Promise<Asset | null>;
  getResult(predictionId: string): Promise<StoredResult | null>;
  /** Throws DuplicateResultError when a result already exists. */
  insertResult(row: NewResultRow): Promise<StoredResult>;
}

export interface EvaluatorDeps {
  marketData: PredictionMarketData;
  store: EvaluatorStore;
  audit: (entry: {
    actorId?: string | null;
    action: string;
    entityType: string;
    entityId: string;
    metadata: Record<string, unknown>;
  }) => Promise<void>;
  now: () => Date;
  /** True only in development. Mock market data is refused everywhere else. */
  allowMockData: boolean;
}

export type DeferralReason =
  | "ASSET_UNAVAILABLE"
  | "QUOTE_UNAVAILABLE"
  | "QUOTE_STALE"
  | "QUOTE_NOT_LIVE"
  | "QUOTE_BEFORE_HORIZON"
  | "MOCK_DATA_NOT_ALLOWED"
  | "CANDLES_UNAVAILABLE"
  | "CANDLES_STALE"
  | "CANDLES_INCOMPLETE"
  | "DATA_INCONSISTENT";

export type SkipReason = "NOT_FOUND" | "NOT_EXPIRED" | "NOT_ELIGIBLE";

export type EvaluationOutcome =
  | { kind: "EVALUATED"; predictionId: string; status: StoredOutcome; label: OutcomeLabel; result: StoredResult }
  | { kind: "ALREADY_EVALUATED"; predictionId: string; status: StoredOutcome; label: OutcomeLabel; result: StoredResult }
  | { kind: "UNAVAILABLE"; predictionId: string; label: "UNAVAILABLE"; reason: DeferralReason; detail?: string }
  | { kind: "SKIPPED"; predictionId: string; reason: SkipReason };

export interface EvaluationMeta {
  evaluatorVersion: string;
  rule: string;
  /** The original, immutable prediction terms that were evaluated. Later notes/revisions are ignored. */
  prediction: {
    direction: "BULLISH" | "BEARISH";
    timeframe: Timeframe;
    entryReferencePrice: number;
    targetPrice: number;
    invalidationPrice: number;
    horizonHours: number;
    createdAt: string;
    expiresAt: string;
    contentHash: string;
  };
  /** The evaluation price (stored as exit_price) and where it came from. */
  quote: {
    price: number;
    source: string;
    asOf: string;
    fetchedAt: string;
    isMock: boolean;
    freshness: string;
    servedFrom: string;
  };
  /** The candle window the outcome was decided on. */
  candles: {
    source: string;
    asOf: string;
    fetchedAt: string;
    isMock: boolean;
    freshness: string;
    servedFrom: string;
    timeframe: Timeframe;
    barsEvaluated: number;
    windowStart: string;
    windowEnd: string;
  };
  touch: { kind: "TARGET" | "INVALIDATION"; level: number; barOpenTime: string; ambiguousWithinBar: boolean } | null;
  /** Evaluator clock at the time of the run. The authoritative timestamp is prediction_results.closed_at. */
  evaluationRequestedAt: string;
  evaluationDelayMs: number;
}

export const MIN_CANDLE_LIMIT = 30;
export const MAX_CANDLE_LIMIT = 1000;

const isTimeframe = (v: string | null): v is Timeframe =>
  v !== null && (PREDICTION_TIMEFRAMES as readonly string[]).includes(v);

const unavailable = (predictionId: string, reason: DeferralReason, detail?: string): EvaluationOutcome => ({
  kind: "UNAVAILABLE",
  predictionId,
  label: "UNAVAILABLE",
  reason,
  detail,
});

/** Only well-formed engine predictions with a server-observed entry can be evaluated. */
function eligibilityProblem(p: EvaluablePrediction, allowMock: boolean): string | null {
  if (p.engineVersion === null) return "not an engine prediction";
  if (p.direction !== "BULLISH" && p.direction !== "BEARISH") return "direction is not BULLISH or BEARISH";
  if (!isTimeframe(p.timeframe)) return "timeframe is missing or unsupported";
  if (p.entryReferencePrice === null || !(p.entryReferencePrice > 0)) return "no server-observed entry price";
  if (!(p.targetPrice > 0) || !(p.invalidationPrice > 0)) return "levels are not positive";
  if (p.entryQuoteIsMock === true && !allowMock) return "entry price came from mock data";
  if (!Number.isFinite(Date.parse(p.createdAt)) || !(Date.parse(p.expiresAt) > Date.parse(p.createdAt))) {
    return "timestamps are invalid";
  }
  return null;
}

export async function evaluatePrediction(p: EvaluablePrediction, deps: EvaluatorDeps): Promise<EvaluationOutcome> {
  const now = deps.now();

  const problem = eligibilityProblem(p, deps.allowMockData);
  if (problem) {
    logger.warn("prediction.evaluation_skipped", { predictionId: p.id, problem });
    return { kind: "SKIPPED", predictionId: p.id, reason: "NOT_ELIGIBLE" };
  }
  const timeframe = p.timeframe as Timeframe;
  const expiresMs = Date.parse(p.expiresAt);
  if (now.getTime() < expiresMs) return { kind: "SKIPPED", predictionId: p.id, reason: "NOT_EXPIRED" };

  // Cheap idempotency check first: no market calls for something that is already decided.
  const existing = await deps.store.getResult(p.id);
  if (existing) return alreadyEvaluated(p.id, existing);

  const asset = await deps.store.getAssetById(p.assetId);
  if (!asset) return defer(p, deps, unavailable(p.id, "ASSET_UNAVAILABLE"));

  // 1. Evaluation price: the server-observed quote. Never supplied by a caller.
  const q = await deps.marketData.getQuote(asset);
  if (!q.ok) return defer(p, deps, unavailable(p.id, "QUOTE_UNAVAILABLE", q.error.code));
  if (q.data.isMock && !deps.allowMockData) return defer(p, deps, unavailable(p.id, "MOCK_DATA_NOT_ALLOWED"));
  if (q.servedFrom !== "PROVIDER") return defer(p, deps, unavailable(p.id, "QUOTE_NOT_LIVE"));
  if (q.freshness.status === "STALE") return defer(p, deps, unavailable(p.id, "QUOTE_STALE"));
  const quoteAsOf = Date.parse(q.data.asOf);
  if (!Number.isFinite(quoteAsOf) || !Number.isFinite(q.data.price) || !(q.data.price > 0)) {
    return defer(p, deps, unavailable(p.id, "DATA_INCONSISTENT", "quote is malformed"));
  }
  if (quoteAsOf - now.getTime() > MAX_QUOTE_FUTURE_SKEW_MS) {
    return defer(p, deps, unavailable(p.id, "DATA_INCONSISTENT", "quote is stamped in the future"));
  }
  if (q.freshness.status === "FRESH") {
    // A live quote must be recent, and must have been observed at or after the end of the horizon.
    if (now.getTime() - quoteAsOf > MAX_ENTRY_QUOTE_AGE_MS) return defer(p, deps, unavailable(p.id, "QUOTE_STALE"));
    if (quoteAsOf < expiresMs) return defer(p, deps, unavailable(p.id, "QUOTE_BEFORE_HORIZON"));
  }
  // LAST_CLOSE (market closed) is a genuine observed price; its status is recorded in the metadata.

  // 2. Closed candles covering the horizon, through the same facade.
  const barMs = TIMEFRAME_MS[timeframe];
  const wanted = Math.ceil((now.getTime() - Date.parse(p.createdAt)) / barMs) + 2;
  const limit = Math.min(MAX_CANDLE_LIMIT, Math.max(MIN_CANDLE_LIMIT, wanted));
  const c = await deps.marketData.getCandles(asset, timeframe, limit);
  if (!c.ok) return defer(p, deps, unavailable(p.id, "CANDLES_UNAVAILABLE", c.error.code));
  if (c.data.isMock && !deps.allowMockData) return defer(p, deps, unavailable(p.id, "MOCK_DATA_NOT_ALLOWED"));
  if (c.freshness.status === "STALE") return defer(p, deps, unavailable(p.id, "CANDLES_STALE"));
  if (c.data.timeframe !== timeframe) {
    return defer(p, deps, unavailable(p.id, "DATA_INCONSISTENT", "candle timeframe does not match the prediction"));
  }

  // 3. Deterministic rules.
  const path = evaluatePath({
    direction: p.direction,
    targetPrice: p.targetPrice,
    invalidationPrice: p.invalidationPrice,
    createdAt: p.createdAt,
    expiresAt: p.expiresAt,
    timeframe,
    candles: c.data.candles,
    continuous: asset.market === "CRYPTO",
  });
  if (path.status === "INCOMPLETE") return defer(p, deps, unavailable(p.id, "CANDLES_INCOMPLETE", path.reason));

  // 4. Persist. closed_at / created_at / content_hash are written by the database trigger.
  const meta: EvaluationMeta = {
    evaluatorVersion: EVALUATOR_VERSION,
    rule: EVALUATION_RULE,
    prediction: {
      direction: p.direction,
      timeframe,
      entryReferencePrice: p.entryReferencePrice as number,
      targetPrice: p.targetPrice,
      invalidationPrice: p.invalidationPrice,
      horizonHours: p.horizonHours,
      createdAt: p.createdAt,
      expiresAt: p.expiresAt,
      contentHash: p.contentHash,
    },
    quote: {
      price: q.data.price,
      source: q.data.source,
      asOf: q.data.asOf,
      fetchedAt: q.data.fetchedAt,
      isMock: q.data.isMock,
      freshness: q.freshness.status,
      servedFrom: q.servedFrom,
    },
    candles: {
      source: c.data.source,
      asOf: c.data.asOf,
      fetchedAt: c.data.fetchedAt,
      isMock: c.data.isMock,
      freshness: c.freshness.status,
      servedFrom: c.servedFrom,
      timeframe,
      barsEvaluated: path.detail.barsEvaluated,
      windowStart: path.detail.windowStart,
      windowEnd: path.detail.windowEnd,
    },
    touch: path.detail.firstTouch,
    evaluationRequestedAt: now.toISOString(),
    evaluationDelayMs: now.getTime() - expiresMs,
  };
  const row: NewResultRow = {
    prediction_id: p.id,
    status: path.outcome,
    exit_price: q.data.price,
    return_pct: null,
    evaluation_meta: meta,
  };

  let stored: StoredResult;
  try {
    stored = await deps.store.insertResult(row);
  } catch (error) {
    if (error instanceof DuplicateResultError) {
      // Another run won the race. The existing result stands; nothing is overwritten.
      const winner = await deps.store.getResult(p.id);
      if (winner) return alreadyEvaluated(p.id, winner);
    }
    logger.error("prediction.result_insert_failed", { error, predictionId: p.id });
    throw new AppError("INTERNAL", "Could not save the evaluation result", error);
  }

  await deps.audit({
    actorId: null,
    action: "prediction.evaluated",
    entityType: "prediction",
    entityId: p.id,
    metadata: {
      resultId: stored.id,
      status: stored.status,
      label: OUTCOME_LABEL[stored.status],
      evaluatorVersion: EVALUATOR_VERSION,
      quoteSource: q.data.source,
      candleSource: c.data.source,
      resultHash: stored.contentHash,
    },
  });

  return { kind: "EVALUATED", predictionId: p.id, status: stored.status, label: OUTCOME_LABEL[stored.status], result: stored };
}

function alreadyEvaluated(predictionId: string, result: StoredResult): EvaluationOutcome {
  return { kind: "ALREADY_EVALUATED", predictionId, status: result.status, label: OUTCOME_LABEL[result.status], result };
}

/** Records the deferral (this also starts the discovery cooldown) and returns the outcome unchanged. */
async function defer(p: EvaluablePrediction, deps: EvaluatorDeps, outcome: EvaluationOutcome): Promise<EvaluationOutcome> {
  if (outcome.kind === "UNAVAILABLE") {
    logger.warn("prediction.evaluation_deferred", { predictionId: p.id, reason: outcome.reason, detail: outcome.detail });
    await deps.audit({
      actorId: null,
      action: "prediction.evaluation_deferred",
      entityType: "prediction",
      entityId: p.id,
      metadata: { reason: outcome.reason, detail: outcome.detail ?? null, evaluatorVersion: EVALUATOR_VERSION },
    });
  }
  return outcome;
}

export interface EvaluationRunSummary {
  scanned: number;
  evaluated: number;
  alreadyEvaluated: number;
  unavailable: number;
  skipped: number;
  failed: number;
  outcomes: Array<{
    predictionId: string;
    kind: EvaluationOutcome["kind"] | "ERROR";
    label?: OutcomeLabel | "UNAVAILABLE";
    reason?: string;
  }>;
}

/**
 * One scheduler tick: evaluate up to `limit` due predictions, one at a time (the market-data
 * facade caches, and sequential calls keep provider load predictable). One failing prediction
 * never stops the rest.
 */
export async function evaluateDuePredictions(rawInput: unknown, deps: EvaluatorDeps): Promise<EvaluationRunSummary> {
  const parsed = evaluationRunInputSchema.safeParse(rawInput ?? {});
  if (!parsed.success) throw new AppError("VALIDATION", parsed.error.issues[0]?.message ?? "Invalid request");
  const due = await deps.store.listDue(parsed.data.limit);

  const summary: EvaluationRunSummary = {
    scanned: due.length,
    evaluated: 0,
    alreadyEvaluated: 0,
    unavailable: 0,
    skipped: 0,
    failed: 0,
    outcomes: [],
  };
  for (const p of due) {
    try {
      const outcome = await evaluatePrediction(p, deps);
      summary.outcomes.push(
        outcome.kind === "SKIPPED"
          ? { predictionId: p.id, kind: outcome.kind, reason: outcome.reason }
          : outcome.kind === "UNAVAILABLE"
            ? { predictionId: p.id, kind: outcome.kind, label: outcome.label, reason: outcome.reason }
            : { predictionId: p.id, kind: outcome.kind, label: outcome.label },
      );
      if (outcome.kind === "EVALUATED") summary.evaluated++;
      else if (outcome.kind === "ALREADY_EVALUATED") summary.alreadyEvaluated++;
      else if (outcome.kind === "UNAVAILABLE") summary.unavailable++;
      else summary.skipped++;
    } catch (error) {
      summary.failed++;
      summary.outcomes.push({ predictionId: p.id, kind: "ERROR" });
      logger.error("prediction.evaluation_failed", { error, predictionId: p.id });
    }
  }
  return summary;
}
