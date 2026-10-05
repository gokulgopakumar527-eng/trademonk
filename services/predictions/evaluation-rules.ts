/**
 * Deterministic evaluation rules. PURE: no I/O, no clock, no randomness. Given the same prediction
 * levels and the same candles the answer is always the same.
 *
 * Semantics (rule id TOUCH_WITHIN_HORIZON_V1). These use exactly what Phase 5A stored: a direction,
 * a target level, an invalidation level, and a horizon (created_at .. expires_at).
 *
 *   BULLISH  target reached  = a candle HIGH  >= target price
 *            invalidated     = a candle LOW   <= invalidation price
 *   BEARISH  target reached  = a candle LOW   <= target price
 *            invalidated     = a candle HIGH  >= invalidation price
 *
 *   The FIRST candle (in time order) that reaches either level decides:
 *     target first        -> WIN          (label CORRECT)
 *     invalidation first  -> INVALIDATED  (label INCORRECT)
 *     neither in horizon  -> EXPIRED      (label NO_CLEAR_RESULT)
 *
 * Candle granularity is a real limit, so two conservative choices are made and both are recorded:
 *   1. Only CLOSED candles that lie entirely inside [created_at, expires_at] are used. The candle
 *      that was already forming at creation, and the one still forming at expiry, are excluded
 *      because part of their range falls outside the horizon.
 *   2. If ONE candle reaches both levels the order inside the candle is unknowable. It is resolved
 *      as INVALIDATED (never as a WIN) and flagged `ambiguousWithinBar`, so uncertainty can only
 *      cost the prediction, never flatter it.
 *
 * If the candles do not demonstrably cover the horizon the function returns INCOMPLETE. It never
 * guesses an outcome from partial data.
 */
import { TIMEFRAME_MS, type Candle, type Timeframe } from "@/types/market";

export const EVALUATOR_VERSION = "eval-1.0.0";
export const EVALUATION_RULE = "TOUCH_WITHIN_HORIZON_V1";

/** Statuses this evaluator writes to prediction_results (a subset of the existing enum). */
export type StoredOutcome = "WIN" | "INVALIDATED" | "EXPIRED";
/** Product vocabulary. UNAVAILABLE is never stored: see the note in migration 6. */
export type OutcomeLabel = "CORRECT" | "INCORRECT" | "NO_CLEAR_RESULT";

export const OUTCOME_LABEL: Record<StoredOutcome, OutcomeLabel> = {
  WIN: "CORRECT",
  INVALIDATED: "INCORRECT",
  EXPIRED: "NO_CLEAR_RESULT",
};

export interface PathInput {
  direction: "BULLISH" | "BEARISH";
  targetPrice: number;
  invalidationPrice: number;
  /** Server timestamps from the immutable prediction row. */
  createdAt: string;
  expiresAt: string;
  timeframe: Timeframe;
  /** May include a forming candle; it is ignored. Ascending by openTime. */
  candles: readonly Candle[];
  /**
   * True for markets that trade continuously (crypto). A missing candle inside the horizon then
   * means missing DATA, and the evaluation is refused. Exchanges with sessions have legitimate gaps.
   */
  continuous: boolean;
}

export interface TouchDetail {
  kind: "TARGET" | "INVALIDATION";
  level: number;
  barOpenTime: string;
  /** True when the same candle reached both levels; resolved as INVALIDATED. */
  ambiguousWithinBar: boolean;
}

export interface PathDetail {
  barsEvaluated: number;
  /** Open time of the first / close time of the last candle used. */
  windowStart: string;
  windowEnd: string;
  firstTouch: TouchDetail | null;
}

export type IncompleteReason =
  | "INVALID_INPUT"
  | "SERIES_STARTS_AFTER_CREATION"
  | "SERIES_ENDS_BEFORE_EXPIRY"
  | "NO_BARS_IN_WINDOW"
  | "GAP_IN_SERIES";

export type PathOutcome =
  | { status: "OK"; outcome: StoredOutcome; detail: PathDetail }
  | { status: "INCOMPLETE"; reason: IncompleteReason; message: string };

const incomplete = (reason: IncompleteReason, message: string): PathOutcome => ({ status: "INCOMPLETE", reason, message });

export function evaluatePath(input: PathInput): PathOutcome {
  const { direction, targetPrice, invalidationPrice, timeframe } = input;
  const createdMs = Date.parse(input.createdAt);
  const expiresMs = Date.parse(input.expiresAt);
  const barMs = TIMEFRAME_MS[timeframe];

  if (!Number.isFinite(createdMs) || !Number.isFinite(expiresMs) || expiresMs <= createdMs) {
    return incomplete("INVALID_INPUT", "Prediction timestamps are invalid");
  }
  const levelsOrdered =
    Number.isFinite(targetPrice) &&
    Number.isFinite(invalidationPrice) &&
    targetPrice > 0 &&
    invalidationPrice > 0 &&
    (direction === "BULLISH" ? targetPrice > invalidationPrice : targetPrice < invalidationPrice);
  if (!levelsOrdered) return incomplete("INVALID_INPUT", "Prediction levels are invalid for its direction");

  const closed = input.candles.filter((c) => c.closed);
  for (const c of closed) {
    const open = Date.parse(c.openTime);
    if (![open, c.high, c.low].every(Number.isFinite) || c.high < c.low) {
      return incomplete("INVALID_INPUT", "A candle is malformed");
    }
  }
  if (closed.length === 0) return incomplete("NO_BARS_IN_WINDOW", "No closed candles were supplied");

  // The series must demonstrably reach back to creation and forward to the end of the horizon.
  const opens = closed.map((c) => Date.parse(c.openTime));
  if (opens[0]! > createdMs) {
    return incomplete("SERIES_STARTS_AFTER_CREATION", "Candle history does not reach back to the prediction's creation time");
  }
  if (opens[opens.length - 1]! + barMs < expiresMs) {
    return incomplete("SERIES_ENDS_BEFORE_EXPIRY", "Candle history does not extend to the end of the horizon");
  }

  const bars = closed.filter((c) => {
    const open = Date.parse(c.openTime);
    return open >= createdMs && open + barMs <= expiresMs;
  });
  if (bars.length === 0) return incomplete("NO_BARS_IN_WINDOW", "No complete candle lies inside the horizon");

  if (input.continuous) {
    const first = Date.parse(bars[0]!.openTime);
    const last = Date.parse(bars[bars.length - 1]!.openTime);
    if (first - createdMs >= barMs || expiresMs - (last + barMs) >= barMs) {
      return incomplete("GAP_IN_SERIES", "Candles are missing at the start or end of the horizon");
    }
    for (let i = 1; i < bars.length; i++) {
      if (Date.parse(bars[i]!.openTime) - Date.parse(bars[i - 1]!.openTime) !== barMs) {
        return incomplete("GAP_IN_SERIES", "Candles are missing inside the horizon");
      }
    }
  }

  const bullish = direction === "BULLISH";
  let firstTouch: TouchDetail | null = null;
  let outcome: StoredOutcome = "EXPIRED";
  for (const bar of bars) {
    const targetHit = bullish ? bar.high >= targetPrice : bar.low <= targetPrice;
    const invalidationHit = bullish ? bar.low <= invalidationPrice : bar.high >= invalidationPrice;
    if (!targetHit && !invalidationHit) continue;
    if (targetHit && !invalidationHit) {
      outcome = "WIN";
      firstTouch = { kind: "TARGET", level: targetPrice, barOpenTime: bar.openTime, ambiguousWithinBar: false };
    } else {
      outcome = "INVALIDATED";
      firstTouch = {
        kind: "INVALIDATION",
        level: invalidationPrice,
        barOpenTime: bar.openTime,
        ambiguousWithinBar: targetHit && invalidationHit,
      };
    }
    break;
  }

  const lastBar = bars[bars.length - 1]!;
  return {
    status: "OK",
    outcome,
    detail: {
      barsEvaluated: bars.length,
      windowStart: bars[0]!.openTime,
      windowEnd: new Date(Date.parse(lastBar.openTime) + barMs).toISOString(),
      firstTouch,
    },
  };
}
