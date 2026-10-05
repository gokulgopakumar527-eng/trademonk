/**
 * Market-structure analysis: swing points, HH/HL/LH/LL classification, breakouts, volatility
 * regime and support/resistance. Deterministic, rule-based, pure.
 *
 * `confidence` is an AGREEMENT SCORE (fraction of independent structural signals pointing the
 * same way). It is NOT a probability of profit or of the move continuing, and the UI must not
 * present it as one.
 */
import type { Candle } from "@/types/market";
import { atr, bollinger, closedCandles, ema, last, macd, rsi } from "./core";

export interface Swing {
  index: number;
  time: string;
  price: number;
  kind: "HIGH" | "LOW";
}

/**
 * Fractal pivots: a swing high has a strictly higher high than the `k` candles on each side.
 * A pivot at index i is only knowable after candle i+k has closed, so the newest `k` candles can
 * never be pivots (no lookahead).
 */
export function findSwings(candles: readonly Candle[], k = 3): Swing[] {
  const out: Swing[] = [];
  for (let i = k; i < candles.length - k; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= k; j++) {
      const l = candles[i - j]!;
      const r = candles[i + j]!;
      const c = candles[i]!;
      if (!(c.high > l.high && c.high > r.high)) isHigh = false;
      if (!(c.low < l.low && c.low < r.low)) isLow = false;
    }
    if (isHigh) out.push({ index: i, time: candles[i]!.openTime, price: candles[i]!.high, kind: "HIGH" });
    if (isLow) out.push({ index: i, time: candles[i]!.openTime, price: candles[i]!.low, kind: "LOW" });
  }
  return out;
}

export type StructureLabel =
  | "HIGHER_HIGH_HIGHER_LOW"
  | "LOWER_HIGH_LOWER_LOW"
  /** higher highs with lower lows: widening range */
  | "EXPANDING_RANGE"
  /** lower highs with higher lows: narrowing range / triangle */
  | "CONTRACTING_RANGE"
  | "UNDEFINED";

export function classifyStructure(swings: readonly Swing[]): StructureLabel {
  const highs = swings.filter((s) => s.kind === "HIGH").slice(-2);
  const lows = swings.filter((s) => s.kind === "LOW").slice(-2);
  if (highs.length < 2 || lows.length < 2) return "UNDEFINED";
  const hh = highs[1]!.price > highs[0]!.price;
  const lh = highs[1]!.price < highs[0]!.price;
  const hl = lows[1]!.price > lows[0]!.price;
  const ll = lows[1]!.price < lows[0]!.price;
  if (hh && hl) return "HIGHER_HIGH_HIGHER_LOW";
  if (lh && ll) return "LOWER_HIGH_LOWER_LOW";
  if (hh && ll) return "EXPANDING_RANGE";
  if (lh && hl) return "CONTRACTING_RANGE";
  return "UNDEFINED";
}

export interface Level {
  price: number;
  kind: "SUPPORT" | "RESISTANCE";
  touches: number;
  lastTouch: string;
  /** Distance from the last close as a fraction of price (positive). */
  distancePct: number;
}

/** Cluster swing prices within `tolerance` of each other; keep clusters with >= minTouches. */
export function findLevels(
  swings: readonly Swing[],
  lastClose: number,
  tolerance: number,
  minTouches = 2,
  perSide = 3,
): Level[] {
  const sorted = [...swings].sort((a, b) => a.price - b.price);
  const clusters: Swing[][] = [];
  for (const s of sorted) {
    const cur = clusters.at(-1);
    const mean = cur ? cur.reduce((a, b) => a + b.price, 0) / cur.length : 0;
    if (cur && Math.abs(s.price - mean) <= tolerance) cur.push(s);
    else clusters.push([s]);
  }
  const levels: Level[] = clusters
    .filter((c) => c.length >= minTouches)
    .map((c) => {
      const price = c.reduce((a, b) => a + b.price, 0) / c.length;
      return {
        price,
        kind: price < lastClose ? ("SUPPORT" as const) : ("RESISTANCE" as const),
        touches: c.length,
        lastTouch: c.reduce((a, b) => (b.index > a.index ? b : a)).time,
        distancePct: Math.abs(price - lastClose) / lastClose,
      };
    });
  const nearest = (kind: Level["kind"]) =>
    levels.filter((l) => l.kind === kind).sort((a, b) => a.distancePct - b.distancePct).slice(0, perSide);
  return [...nearest("SUPPORT"), ...nearest("RESISTANCE")];
}

export type Trend = "BULLISH" | "BEARISH" | "NEUTRAL";
export type VolatilityState = "EXPANDING" | "CONTRACTING" | "STABLE";
export type BreakoutState = "BREAKOUT" | "BREAKDOWN" | "NONE";
export type BreakoutRisk = "LOW" | "MEDIUM" | "HIGH";

export interface MarketStructure {
  status: "OK";
  trend: Trend;
  /** Agreement score 0..1. NOT a probability of profit. */
  confidence: number;
  structure: StructureLabel;
  regime: "TRENDING" | "RANGE";
  volatility: VolatilityState;
  breakout: BreakoutState;
  breakoutRisk: BreakoutRisk;
  levels: Level[];
  swings: Swing[];
  signals: { bullish: number; bearish: number; total: number };
  /** Open time of the newest closed candle used. */
  asOf: string;
  candlesUsed: number;
}

export interface InsufficientData {
  status: "INSUFFICIENT_DATA";
  needed: number;
  have: number;
}

export const MIN_STRUCTURE_CANDLES = 60;

export interface StructureOptions {
  swingWindow?: number;
  breakoutLookback?: number;
}

export function analyzeMarketStructure(
  input: readonly Candle[],
  opts: StructureOptions = {},
): MarketStructure | InsufficientData {
  const candles = closedCandles(input);
  if (candles.length < MIN_STRUCTURE_CANDLES) {
    return { status: "INSUFFICIENT_DATA", needed: MIN_STRUCTURE_CANDLES, have: candles.length };
  }
  const k = opts.swingWindow ?? 3;
  const lookback = opts.breakoutLookback ?? 20;
  const closes = candles.map((c) => c.close);
  const lastCandle = candles.at(-1)!;
  const lastClose = lastCandle.close;

  const swings = findSwings(candles, k);
  const structure = classifyStructure(swings);

  const ema20 = last(ema(closes, 20))!;
  const ema50 = last(ema(closes, 50))!;
  const hist = last(macd(closes).histogram);
  const r = last(rsi(closes, 14));
  const atrSeries = atr(candles, 14);
  const atrNow = last(atrSeries)!;

  // Independent directional signals; each contributes one vote.
  const bull = [
    structure === "HIGHER_HIGH_HIGHER_LOW",
    lastClose > ema20,
    ema20 > ema50,
    hist !== null && hist > 0,
    r !== null && r > 50,
  ].filter(Boolean).length;
  const bear = [
    structure === "LOWER_HIGH_LOWER_LOW",
    lastClose < ema20,
    ema20 < ema50,
    hist !== null && hist < 0,
    r !== null && r < 50,
  ].filter(Boolean).length;
  const total = 5;
  const trend: Trend = bull >= 4 ? "BULLISH" : bear >= 4 ? "BEARISH" : "NEUTRAL";

  // Volatility regime: current ATR vs the mean of the previous 20 ATR values.
  const atrVals = atrSeries.filter((x): x is number => x !== null);
  const prior = atrVals.slice(-21, -1);
  const priorMean = prior.length ? prior.reduce((a, b) => a + b, 0) / prior.length : atrNow;
  const ratio = atrNow / priorMean;
  const volatility: VolatilityState = ratio > 1.25 ? "EXPANDING" : ratio < 0.8 ? "CONTRACTING" : "STABLE";

  // Donchian-style break of the previous `lookback` candles (excluding the newest).
  const prev = candles.slice(-lookback - 1, -1);
  const priorHigh = Math.max(...prev.map((c) => c.high));
  const priorLow = Math.min(...prev.map((c) => c.low));
  const breakout: BreakoutState = lastClose > priorHigh ? "BREAKOUT" : lastClose < priorLow ? "BREAKDOWN" : "NONE";

  // Range regime: the last 20 candles span less than 4 ATR and there is no directional trend.
  const recent = candles.slice(-20);
  const span = Math.max(...recent.map((c) => c.high)) - Math.min(...recent.map((c) => c.low));
  const regime = trend === "NEUTRAL" && span < 4 * atrNow ? "RANGE" : "TRENDING";

  // Squeeze: current Bollinger bandwidth in the bottom quintile of its recent history.
  const bw = bollinger(closes, 20, 2).bandwidth.filter((x): x is number => x !== null).slice(-100);
  const nowBw = bw.at(-1)!;
  const rank = bw.filter((x) => x <= nowBw).length / bw.length;
  const nearEdge = lastClose >= priorHigh - atrNow || lastClose <= priorLow + atrNow;
  const breakoutRisk: BreakoutRisk = rank <= 0.2 ? (nearEdge ? "HIGH" : "MEDIUM") : nearEdge && breakout === "NONE" ? "MEDIUM" : "LOW";

  const levels = findLevels(swings, lastClose, Math.max(0.5 * atrNow, lastClose * 0.001));

  return {
    status: "OK",
    trend,
    confidence: Math.max(bull, bear) / total,
    structure,
    regime,
    volatility,
    breakout,
    breakoutRisk,
    levels,
    swings: swings.slice(-8),
    signals: { bullish: bull, bearish: bear, total },
    asOf: lastCandle.openTime,
    candlesUsed: candles.length,
  };
}
