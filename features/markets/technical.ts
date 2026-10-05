/**
 * View-model builder for the asset page: wires the existing indicator + structure engine to the UI.
 * No new indicator maths lives here; this only calls services/indicators and shapes the output.
 * Indicators use CLOSED candles only, so the forming candle never leaks into a signal.
 */
import {
  atr,
  bollinger,
  closedCandles,
  ema,
  historicalVolatility,
  last,
  macd,
  rsi,
  sma,
  stochRsi,
  volumeMovingAverage,
  vwap,
  type Series,
} from "@/services/indicators/core";
import {
  analyzeMarketStructure,
  type InsufficientData,
  type MarketStructure,
} from "@/services/indicators/structure";
import type { Candle, Timeframe } from "@/types/market";

export interface LinePoint {
  /** Unix seconds (UTC), the chart library's time unit. */
  time: number;
  value: number;
}

export interface ChartCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  closed: boolean;
}

export interface Overlays {
  ema20: LinePoint[];
  ema50: LinePoint[];
  sma200: LinePoint[];
  bbUpper: LinePoint[];
  bbLower: LinePoint[];
  /** Null when VWAP is not meaningful for the timeframe (daily and weekly). */
  vwap: LinePoint[] | null;
}

export interface TechnicalSnapshot {
  rsi14: number | null;
  macd: number | null;
  macdSignal: number | null;
  macdHistogram: number | null;
  ema20: number | null;
  ema50: number | null;
  sma200: number | null;
  bbUpper: number | null;
  bbMiddle: number | null;
  bbLower: number | null;
  percentB: number | null;
  atr14: number | null;
  vwap: number | null;
  stochRsiK: number | null;
  stochRsiD: number | null;
  /** Last closed candle's volume divided by its 20-period average. */
  volumeVsAvg: number | null;
  lastVolume: number | null;
  /** Std-dev of log returns over 20 candles, unannualised, per-candle. */
  histVol20: number | null;
  lastClose: number | null;
  /** Open time of the newest closed candle used. */
  asOf: string | null;
  closedCount: number;
}

export interface TechnicalView {
  chartCandles: ChartCandle[];
  overlays: Overlays;
  snapshot: TechnicalSnapshot;
  structure: MarketStructure | InsufficientData;
}

const toSec = (iso: string): number => Math.floor(new Date(iso).getTime() / 1000);

export function toChartCandles(candles: readonly Candle[]): ChartCandle[] {
  return candles.map((c) => ({
    time: toSec(c.openTime),
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
    closed: c.closed,
  }));
}

function line(candles: readonly Candle[], series: Series): LinePoint[] {
  const out: LinePoint[] = [];
  for (let i = 0; i < candles.length; i++) {
    const v = series[i];
    if (v !== null && v !== undefined && Number.isFinite(v)) {
      out.push({ time: toSec(candles[i]!.openTime), value: v });
    }
  }
  return out;
}

const utcDay = (c: Candle) => c.openTime.slice(0, 10);

/** VWAP resets each UTC day on intraday timeframes; it is not offered on 1d/1w. */
const VWAP_TIMEFRAMES: readonly Timeframe[] = ["1m", "5m", "15m", "1h", "4h"];

export function buildTechnicalView(candles: readonly Candle[], timeframe: Timeframe): TechnicalView {
  const closed = closedCandles(candles);
  const cl = closed.map((c) => c.close);
  const ema20 = ema(cl, 20);
  const ema50 = ema(cl, 50);
  const sma200 = sma(cl, 200);
  const bb = bollinger(cl, 20, 2);
  const m = macd(cl);
  const st = stochRsi(cl);
  const volMa = volumeMovingAverage(closed, 20);
  const wantVwap = VWAP_TIMEFRAMES.includes(timeframe);
  const vw = wantVwap ? vwap(closed, utcDay) : null;
  const lastCandle = closed.at(-1) ?? null;
  const lastVol = lastCandle?.volume ?? null;
  const volAvg = last(volMa);

  const snapshot: TechnicalSnapshot = {
    rsi14: last(rsi(cl, 14)),
    macd: last(m.macd),
    macdSignal: last(m.signal),
    macdHistogram: last(m.histogram),
    ema20: last(ema20),
    ema50: last(ema50),
    sma200: last(sma200),
    bbUpper: last(bb.upper),
    bbMiddle: last(bb.middle),
    bbLower: last(bb.lower),
    percentB: last(bb.percentB),
    atr14: last(atr(closed, 14)),
    vwap: vw ? last(vw) : null,
    stochRsiK: last(st.k),
    stochRsiD: last(st.d),
    volumeVsAvg: lastVol !== null && volAvg !== null && volAvg > 0 ? lastVol / volAvg : null,
    lastVolume: lastVol,
    histVol20: last(historicalVolatility(cl, 20)),
    lastClose: lastCandle?.close ?? null,
    asOf: lastCandle?.openTime ?? null,
    closedCount: closed.length,
  };

  return {
    chartCandles: toChartCandles(candles),
    overlays: {
      ema20: line(closed, ema20),
      ema50: line(closed, ema50),
      sma200: line(closed, sma200),
      bbUpper: line(closed, bb.upper),
      bbLower: line(closed, bb.lower),
      vwap: vw ? line(closed, vw) : null,
    },
    snapshot,
    structure: analyzeMarketStructure(candles),
  };
}

// ── Descriptive labels (facts about the numbers, never trade instructions) ──

export function describeRsi(v: number | null): string {
  if (v === null) return "Not enough data";
  if (v >= 70) return "At or above 70";
  if (v <= 30) return "At or below 30";
  return "Between 30 and 70";
}

export function describeMacd(hist: number | null): string {
  if (hist === null) return "Not enough data";
  return hist > 0 ? "MACD above signal line" : hist < 0 ? "MACD below signal line" : "MACD on signal line";
}

export function describeVolume(ratio: number | null): string {
  if (ratio === null) return "Volume average not available";
  return `${ratio.toFixed(2)}\u00d7 the 20-candle average`;
}

// ── Row-level analytics for lists and watchlists ──

export interface RowAnalytics {
  rsi14: number | null;
  trend: "BULLISH" | "BEARISH" | "NEUTRAL" | null;
  /** Why a value is missing, shown as a tooltip. */
  note: string | null;
}

/** RSI and trend from a candle series (daily candles for list views). Null means "not enough data". */
export function buildRowAnalytics(candles: readonly Candle[]): RowAnalytics {
  const closed = closedCandles(candles);
  const r = closed.length > 14 ? last(rsi(closed.map((c) => c.close), 14)) : null;
  const s = analyzeMarketStructure(candles);
  if (s.status === "INSUFFICIENT_DATA") {
    return { rsi14: r, trend: null, note: `Trend needs ${s.needed} closed candles; have ${s.have}` };
  }
  return { rsi14: r, trend: s.trend, note: null };
}
