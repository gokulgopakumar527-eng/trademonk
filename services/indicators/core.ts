/**
 * Technical indicators: pure functions, no I/O, no React, no provider knowledge.
 * Every function returns an array ALIGNED to its input (same length); positions without enough
 * history are `null`. Nothing is ever back-filled or invented.
 *
 * Feed CLOSED candles only (see closedCandles); a forming candle would make values repaint.
 */
import type { Candle } from "@/types/market";

export type Series = (number | null)[];

export const closedCandles = (candles: readonly Candle[]): Candle[] => candles.filter((c) => c.closed);
export const closes = (candles: readonly Candle[]): number[] => candles.map((c) => c.close);

function assertPeriod(period: number, name: string) {
  if (!Number.isInteger(period) || period < 1) throw new RangeError(`${name} period must be a positive integer`);
}

/** Rolling mean; a window containing any null yields null. */
export function sma(values: readonly (number | null)[], period: number): Series {
  assertPeriod(period, "SMA");
  const out: Series = new Array(values.length).fill(null);
  let sum = 0;
  let valid = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v !== null && v !== undefined) {
      sum += v;
      valid++;
    }
    const drop = i - period;
    if (drop >= 0) {
      const d = values[drop];
      if (d !== null && d !== undefined) {
        sum -= d;
        valid--;
      }
    }
    if (i >= period - 1 && valid === period) out[i] = sum / period;
  }
  return out;
}

/**
 * EMA seeded with the SMA of the first `period` non-null values (the convention used by most
 * charting packages). Leading nulls are skipped, so it can be chained (e.g. MACD signal).
 */
export function ema(values: readonly (number | null)[], period: number): Series {
  assertPeriod(period, "EMA");
  const out: Series = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev: number | null = null;
  let seedSum = 0;
  let seedCount = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === null || v === undefined) {
      if (prev !== null) throw new Error("EMA input has a gap after it started");
      continue;
    }
    if (prev === null) {
      seedSum += v;
      seedCount++;
      if (seedCount === period) {
        prev = seedSum / period;
        out[i] = prev;
      }
    } else {
      prev = prev + k * (v - prev);
      out[i] = prev;
    }
  }
  return out;
}

/** Wilder's RSI. Flat series => 50; all gains => 100; all losses => 0. */
export function rsi(values: readonly number[], period = 14): Series {
  assertPeriod(period, "RSI");
  const out: Series = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i]! - values[i - 1]!;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  const toRsi = (g: number, l: number) => (l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l));
  out[period] = toRsi(avgGain, avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i]! - values[i - 1]!;
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = toRsi(avgGain, avgLoss);
  }
  return out;
}

export interface MacdResult {
  macd: Series;
  signal: Series;
  histogram: Series;
}

export function macd(values: readonly number[], fast = 12, slow = 26, signalPeriod = 9): MacdResult {
  if (fast >= slow) throw new RangeError("MACD fast period must be shorter than slow period");
  const f = ema(values, fast);
  const s = ema(values, slow);
  const line: Series = values.map((_, i) => (f[i] !== null && s[i] !== null ? f[i]! - s[i]! : null));
  const signal = ema(line, signalPeriod);
  const histogram: Series = line.map((m, i) => (m !== null && signal[i] !== null ? m - signal[i]! : null));
  return { macd: line, signal, histogram };
}

export interface BollingerResult {
  middle: Series;
  upper: Series;
  lower: Series;
  /** (upper - lower) / middle */
  bandwidth: Series;
  /** (price - lower) / (upper - lower); null when bands collapse */
  percentB: Series;
}

/** Bollinger Bands with POPULATION standard deviation (the charting-package convention). */
export function bollinger(values: readonly number[], period = 20, mult = 2): BollingerResult {
  const middle = sma(values, period);
  const n = values.length;
  const upper: Series = new Array(n).fill(null);
  const lower: Series = new Array(n).fill(null);
  const bandwidth: Series = new Array(n).fill(null);
  const percentB: Series = new Array(n).fill(null);
  for (let i = period - 1; i < n; i++) {
    const m = middle[i]!;
    let sq = 0;
    for (let j = i - period + 1; j <= i; j++) sq += (values[j]! - m) ** 2;
    const sd = Math.sqrt(sq / period);
    upper[i] = m + mult * sd;
    lower[i] = m - mult * sd;
    bandwidth[i] = m === 0 ? null : (upper[i]! - lower[i]!) / m;
    percentB[i] = upper[i]! === lower[i]! ? null : (values[i]! - lower[i]!) / (upper[i]! - lower[i]!);
  }
  return { middle, upper, lower, bandwidth, percentB };
}

export function trueRange(candles: readonly Candle[]): number[] {
  return candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const pc = candles[i - 1]!.close;
    return Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  });
}

/** Wilder's ATR: seeded with the mean of the first `period` true ranges, then RMA-smoothed. */
export function atr(candles: readonly Candle[], period = 14): Series {
  assertPeriod(period, "ATR");
  const out: Series = new Array(candles.length).fill(null);
  if (candles.length < period) return out;
  const tr = trueRange(candles);
  let prev = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < candles.length; i++) {
    prev = (prev * (period - 1) + tr[i]!) / period;
    out[i] = prev;
  }
  return out;
}

/**
 * Volume-weighted average price on typical price (H+L+C)/3, cumulative from the start of the
 * input or from each anchor boundary. `anchorKey` returns a string; VWAP resets when it changes
 * (e.g. UTC day for intraday crypto). Candles with unknown volume yield null and break the run.
 */
export function vwap(candles: readonly Candle[], anchorKey?: (c: Candle) => string): Series {
  const out: Series = new Array(candles.length).fill(null);
  let key: string | undefined;
  let pv = 0;
  let vol = 0;
  let broken = false;
  candles.forEach((c, i) => {
    const k = anchorKey?.(c);
    if (k !== key) {
      key = k;
      pv = 0;
      vol = 0;
      broken = false;
    }
    if (c.volume === null) {
      broken = true;
      return;
    }
    pv += ((c.high + c.low + c.close) / 3) * c.volume;
    vol += c.volume;
    out[i] = !broken && vol > 0 ? pv / vol : null;
  });
  return out;
}

export interface StochRsiResult {
  k: Series;
  d: Series;
}

/** Stochastic RSI on a 0-100 scale. A flat RSI window (max == min) yields 0 for that raw value. */
export function stochRsi(
  values: readonly number[],
  rsiPeriod = 14,
  stochPeriod = 14,
  kSmooth = 3,
  dSmooth = 3,
): StochRsiResult {
  const r = rsi(values, rsiPeriod);
  const raw: Series = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i++) {
    if (i < stochPeriod - 1) continue;
    const win = r.slice(i - stochPeriod + 1, i + 1);
    if (win.some((x) => x === null)) continue;
    const nums = win as number[];
    const hi = Math.max(...nums);
    const lo = Math.min(...nums);
    raw[i] = hi === lo ? 0 : ((r[i]! - lo) / (hi - lo)) * 100;
  }
  const k = sma(raw, kSmooth);
  return { k, d: sma(k, dSmooth) };
}

export function volumeMovingAverage(candles: readonly Candle[], period = 20): Series {
  return sma(candles.map((c) => c.volume), period);
}

/** Population std-dev of log returns over `period`; unannualised. */
export function historicalVolatility(values: readonly number[], period = 20): Series {
  const out: Series = new Array(values.length).fill(null);
  const rets = values.map((v, i) => (i === 0 || values[i - 1]! <= 0 || v <= 0 ? null : Math.log(v / values[i - 1]!)));
  for (let i = period; i < values.length; i++) {
    const win = rets.slice(i - period + 1, i + 1);
    if (win.some((x) => x === null)) continue;
    const nums = win as number[];
    const mean = nums.reduce((a, b) => a + b, 0) / period;
    out[i] = Math.sqrt(nums.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
  }
  return out;
}

export const last = <T>(s: readonly (T | null)[]): T | null => {
  for (let i = s.length - 1; i >= 0; i--) if (s[i] !== null) return s[i] as T;
  return null;
};
