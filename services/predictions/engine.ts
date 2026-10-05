/**
 * Deterministic, rule-based prediction engine. PURE: no I/O, no clock, no randomness.
 * The caller supplies candles, a server-observed quote and `now`; the same input always yields
 * the same output.
 *
 * It consumes the existing indicator and market-structure engines and adds no new indicator
 * maths. It never calls a provider, `fetch()` or a browser API.
 *
 * "N of 5 signals agree" is an AGREEMENT SCORE between five rule-based signals (the same five the
 * market-structure engine counts). It is not a forecast, and it is not a probability of any
 * outcome. Direction needs at least MIN_AGREEMENT of the five plus no triggered guard.
 */
import {
  atr,
  bollinger,
  closedCandles,
  ema,
  last,
  macd,
  rsi,
  sma,
  stochRsi,
  volumeMovingAverage,
  vwap,
} from "@/services/indicators/core";
import { analyzeMarketStructure, type Level } from "@/services/indicators/structure";
import type { Candle, Quote, Timeframe } from "@/types/market";

export const ENGINE_VERSION = "rules-1.0.0";

/** Timeframes the engine will produce a prediction for (1m/5m are noise; 1w gives ~60 weekly bars). */
export const PREDICTION_TIMEFRAMES = ["15m", "1h", "4h", "1d"] as const satisfies readonly Timeframe[];
export type PredictionTimeframe = (typeof PREDICTION_TIMEFRAMES)[number];

/** Time horizon per timeframe: 24 bars for intraday, 10 bars for daily. */
export const HORIZON_HOURS: Record<PredictionTimeframe, number> = {
  "15m": 6,
  "1h": 24,
  "4h": 96,
  "1d": 240,
};

export const ENGINE_PARAMS = {
  /** Minimum agreeing signals (of 5) required for a directional call. */
  minAgreement: 4,
  atrPeriod: 14,
  /** Default invalidation distance from entry, in ATRs. */
  invalidationAtr: 1.5,
  /** A support/resistance level is used for invalidation when it lies in this ATR band from entry. */
  levelBandNearAtr: 0.5,
  levelBandFarAtr: 3,
  /** Invalidation is placed this many ATRs beyond the level. */
  levelBufferAtr: 0.25,
  /** Target distance as a multiple of the invalidation distance. */
  rewardToRisk: 1.5,
  rsiExhaustionHigh: 80,
  rsiExhaustionLow: 20,
  /** Reject when the quote and the last closed candle disagree by more than this fraction. */
  maxQuoteCandleDeviation: 0.25,
} as const;

export const AGREEMENT_DISCLAIMER =
  "Signal agreement counts how many of five rule-based signals point the same way. It is not a forecast and not a probability of any outcome.";

export type Reading = "BULLISH" | "BEARISH" | "NEUTRAL" | "N/A";
export type EngineDirection = "BULLISH" | "BEARISH" | "NEUTRAL";

export interface SignalUsed {
  id: string;
  /** VOTE counts toward the agreement score; GUARD can veto a direction; CONTEXT is recorded only. */
  group: "VOTE" | "GUARD" | "CONTEXT";
  reading: Reading;
  /** Observed value from the indicator engines, or null when it could not be computed. */
  value: number | string | null;
  note: string;
}

export interface SignalAgreement {
  agreeing: number;
  total: 5;
  /** Side the `agreeing` count refers to. NONE when bullish and bearish votes tie. */
  side: "BULLISH" | "BEARISH" | "NONE";
}

export interface EngineSnapshot {
  engineVersion: string;
  timeframe: PredictionTimeframe;
  candlesUsed: number;
  /** Open time of the newest CLOSED candle used. */
  lastClosedCandle: string;
  lastClose: number;
  agreementNote: string;
  params: typeof ENGINE_PARAMS;
  votes: { bullish: number; bearish: number; total: 5 };
  indicators: Record<string, number | null>;
  structure: {
    trend: string;
    label: string;
    regime: string;
    volatility: string;
    breakout: string;
    breakoutRisk: string;
  };
  levels: Array<{ price: number; kind: Level["kind"]; touches: number }>;
  guards: Array<{ id: string; triggered: boolean; note: string }>;
  levelBasis: { invalidation: "ATR" | "STRUCTURE_LEVEL" | null; atr: number | null };
}

export interface EngineResult {
  direction: EngineDirection;
  timeframe: PredictionTimeframe;
  horizonHours: number;
  entryReferencePrice: number;
  /** Null when direction is NEUTRAL: the engine does not propose levels without a direction. */
  targetPrice: number | null;
  invalidationPrice: number | null;
  reasoning: string[];
  signalsUsed: SignalUsed[];
  signalAgreement: SignalAgreement;
  engineVersion: string;
  /** Engine-side preview. The database sets the authoritative created_at / expires_at on insert. */
  createdAt: string;
  expiresAt: string;
  snapshot: EngineSnapshot;
}

export type EngineOutcome =
  | { status: "OK"; result: EngineResult }
  | { status: "INSUFFICIENT_DATA"; needed: number; have: number }
  | { status: "INVALID_INPUT"; reason: string };

export interface EngineInput {
  timeframe: PredictionTimeframe;
  /** May include the forming candle; it is excluded from every indicator. */
  candles: readonly Candle[];
  /** Server-observed quote. Only price is used for the entry; provenance is stored by the caller. */
  quote: Pick<Quote, "price">;
  now: Date;
}

const VWAP_TIMEFRAMES: readonly Timeframe[] = ["15m", "1h", "4h"];
const utcDay = (c: Candle) => c.openTime.slice(0, 10);

/** Stable rounding so equal computations serialise identically (and hash identically). */
const r10 = (n: number): number => Number(n.toPrecision(10));
const r6 = (n: number | null): number | null => (n === null || !Number.isFinite(n) ? null : Number(n.toPrecision(6)));
const fmt = (n: number): string => String(Number(n.toPrecision(6)));

const reading = (bull: boolean, bear: boolean): Reading => (bull ? "BULLISH" : bear ? "BEARISH" : "NEUTRAL");

export function generatePrediction(input: EngineInput): EngineOutcome {
  const { timeframe, quote, now } = input;
  const entry = quote.price;
  if (!Number.isFinite(entry) || entry <= 0) {
    return { status: "INVALID_INPUT", reason: "Quote price is not a positive number" };
  }

  const structure = analyzeMarketStructure(input.candles);
  if (structure.status === "INSUFFICIENT_DATA") {
    return { status: "INSUFFICIENT_DATA", needed: structure.needed, have: structure.have };
  }

  const candles = closedCandles(input.candles);
  const closes = candles.map((c) => c.close);
  const lastCandle = candles.at(-1)!;
  const lastClose = lastCandle.close;

  if (Math.abs(entry - lastClose) / lastClose > ENGINE_PARAMS.maxQuoteCandleDeviation) {
    return {
      status: "INVALID_INPUT",
      reason: "Quote and the last closed candle disagree by more than 25%; the data set is not consistent",
    };
  }

  // ── Indicators (existing engine; closed candles only) ──
  const ema20 = last(ema(closes, 20));
  const ema50 = last(ema(closes, 50));
  const sma200 = last(sma(closes, 200));
  const m = macd(closes);
  const hist = last(m.histogram);
  const rsi14 = last(rsi(closes, 14));
  const bb = bollinger(closes, 20, 2);
  const percentB = last(bb.percentB);
  const atr14 = last(atr(candles, ENGINE_PARAMS.atrPeriod));
  const st = stochRsi(closes);
  const stK = last(st.k);
  const stD = last(st.d);
  const volMa = last(volumeMovingAverage(candles, 20));
  const lastVol = lastCandle.volume;
  const volumeVsAvg = lastVol !== null && volMa !== null && volMa > 0 ? lastVol / volMa : null;
  const vwapNow = VWAP_TIMEFRAMES.includes(timeframe) ? last(vwap(candles, utcDay)) : null;

  // ── The five agreement votes (same five the market-structure engine counts) ──
  const votes: SignalUsed[] = [
    {
      id: "STRUCTURE",
      group: "VOTE",
      reading: reading(structure.structure === "HIGHER_HIGH_HIGHER_LOW", structure.structure === "LOWER_HIGH_LOWER_LOW"),
      value: structure.structure,
      note: "Swing structure (higher highs and lows, or lower highs and lows)",
    },
    {
      id: "PRICE_VS_EMA20",
      group: "VOTE",
      reading: ema20 === null ? "N/A" : reading(lastClose > ema20, lastClose < ema20),
      value: r6(ema20),
      note: "Last closed price relative to the 20-period EMA",
    },
    {
      id: "EMA20_VS_EMA50",
      group: "VOTE",
      reading: ema20 === null || ema50 === null ? "N/A" : reading(ema20 > ema50, ema20 < ema50),
      value: r6(ema50),
      note: "20-period EMA relative to the 50-period EMA",
    },
    {
      id: "MACD_HISTOGRAM",
      group: "VOTE",
      reading: hist === null ? "N/A" : reading(hist > 0, hist < 0),
      value: r6(hist),
      note: "MACD histogram sign",
    },
    {
      id: "RSI_14",
      group: "VOTE",
      reading: rsi14 === null ? "N/A" : reading(rsi14 > 50, rsi14 < 50),
      value: r6(rsi14),
      note: "RSI(14) above or below 50",
    },
  ];
  const bull = votes.filter((v) => v.reading === "BULLISH").length;
  const bear = votes.filter((v) => v.reading === "BEARISH").length;
  if (bull !== structure.signals.bullish || bear !== structure.signals.bearish) {
    // The engine and the structure module must never disagree about the votes.
    return { status: "INVALID_INPUT", reason: "Signal votes are inconsistent with the market-structure engine" };
  }

  const side: SignalAgreement["side"] = bull > bear ? "BULLISH" : bear > bull ? "BEARISH" : "NONE";
  const signalAgreement: SignalAgreement = { agreeing: Math.max(bull, bear), total: 5, side };

  // ── Guards: conditions that turn a directional read into NEUTRAL ──
  const candidate: EngineDirection = structure.trend;
  const guards: EngineSnapshot["guards"] = [
    {
      id: "CONFLICTING_BREAKOUT",
      triggered:
        (candidate === "BULLISH" && structure.breakout === "BREAKDOWN") ||
        (candidate === "BEARISH" && structure.breakout === "BREAKOUT"),
      note: "Price has broken the prior 20-candle range against the signal direction",
    },
    {
      id: "MOMENTUM_EXHAUSTION",
      triggered:
        rsi14 !== null &&
        ((candidate === "BULLISH" && rsi14 >= ENGINE_PARAMS.rsiExhaustionHigh) ||
          (candidate === "BEARISH" && rsi14 <= ENGINE_PARAMS.rsiExhaustionLow)),
      note: `RSI(14) at an extreme (>= ${ENGINE_PARAMS.rsiExhaustionHigh} or <= ${ENGINE_PARAMS.rsiExhaustionLow}) in the signal direction`,
    },
  ];
  const guardHit = guards.find((g) => g.triggered);
  const direction: EngineDirection = candidate !== "NEUTRAL" && !guardHit ? candidate : "NEUTRAL";

  // ── Context (recorded, never counted as a vote) ──
  const context: SignalUsed[] = [
    { id: "BREAKOUT_STATE", group: "CONTEXT", reading: "N/A", value: structure.breakout, note: "Break of the prior 20-candle high/low" },
    { id: "BREAKOUT_RISK", group: "CONTEXT", reading: "N/A", value: structure.breakoutRisk, note: "Bollinger squeeze and proximity to range edge" },
    { id: "VOLATILITY_REGIME", group: "CONTEXT", reading: "N/A", value: structure.volatility, note: "ATR versus its trailing average" },
    { id: "MARKET_REGIME", group: "CONTEXT", reading: "N/A", value: structure.regime, note: "Trending or range-bound" },
    { id: "ATR_14", group: "CONTEXT", reading: "N/A", value: r6(atr14), note: "Average true range, 14 periods" },
    {
      id: "VOLUME_VS_20_AVG",
      group: "CONTEXT",
      reading: "N/A",
      value: r6(volumeVsAvg),
      note: volumeVsAvg === null ? "Volume unavailable for this instrument or window" : "Last closed candle volume over its 20-candle average",
    },
    {
      id: "PRICE_VS_VWAP",
      group: "CONTEXT",
      reading: vwapNow === null ? "N/A" : reading(lastClose > vwapNow, lastClose < vwapNow),
      value: r6(vwapNow),
      note: vwapNow === null ? "VWAP is not used on daily timeframes" : "Last closed price relative to the UTC-day VWAP",
    },
    {
      id: "BOLLINGER_PERCENT_B",
      group: "CONTEXT",
      reading: "N/A",
      value: r6(percentB),
      note: "Position inside the Bollinger Bands (0 = lower band, 1 = upper band)",
    },
    {
      id: "STOCH_RSI_K_MINUS_D",
      group: "CONTEXT",
      reading: stK === null || stD === null ? "N/A" : reading(stK > stD, stK < stD),
      value: stK === null || stD === null ? null : r6(stK - stD),
      note: "Stochastic RSI %K relative to %D",
    },
    {
      id: "PRICE_VS_SMA200",
      group: "CONTEXT",
      reading: sma200 === null ? "N/A" : reading(lastClose > sma200, lastClose < sma200),
      value: r6(sma200),
      note: sma200 === null ? "Fewer than 200 closed candles" : "Last closed price relative to the 200-period SMA",
    },
  ];
  const guardSignals: SignalUsed[] = guards.map((g) => ({
    id: g.id,
    group: "GUARD",
    reading: g.triggered ? "NEUTRAL" : "N/A",
    value: g.triggered ? "TRIGGERED" : "CLEAR",
    note: g.note,
  }));
  const signalsUsed = [...votes, ...guardSignals, ...context];

  const horizonHours = HORIZON_HOURS[timeframe];
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + horizonHours * 3_600_000).toISOString();

  const snapshotBase = {
    engineVersion: ENGINE_VERSION,
    timeframe,
    candlesUsed: candles.length,
    lastClosedCandle: lastCandle.openTime,
    lastClose: r10(lastClose),
    agreementNote: AGREEMENT_DISCLAIMER,
    params: ENGINE_PARAMS,
    votes: { bullish: bull, bearish: bear, total: 5 as const },
    indicators: {
      ema20: r6(ema20),
      ema50: r6(ema50),
      sma200: r6(sma200),
      macdHistogram: r6(hist),
      rsi14: r6(rsi14),
      percentB: r6(percentB),
      atr14: r6(atr14),
      vwap: r6(vwapNow),
      stochRsiK: r6(stK),
      stochRsiD: r6(stD),
      volumeVsAvg: r6(volumeVsAvg),
    },
    structure: {
      trend: structure.trend,
      label: structure.structure,
      regime: structure.regime,
      volatility: structure.volatility,
      breakout: structure.breakout,
      breakoutRisk: structure.breakoutRisk,
    },
    levels: structure.levels.map((l) => ({ price: r6(l.price)!, kind: l.kind, touches: l.touches })),
    guards,
  };

  const agreeNames = votes.filter((v) => v.reading === side).map((v) => v.id);
  const headline =
    side === "NONE"
      ? `Signals are split: ${bull} bullish, ${bear} bearish, ${5 - bull - bear} neutral (of 5). No side has more signals than the other.`
      : `${signalAgreement.agreeing} of 5 signals agree (${side.toLowerCase()}): ${agreeNames.join(", ")}.`;

  if (direction === "NEUTRAL") {
    const why = guardHit
      ? `Directional read withheld: ${guardHit.note}.`
      : `Directional read withheld: fewer than ${ENGINE_PARAMS.minAgreement} of 5 signals agree.`;
    return {
      status: "OK",
      result: {
        direction: "NEUTRAL",
        timeframe,
        horizonHours,
        entryReferencePrice: entry,
        targetPrice: null,
        invalidationPrice: null,
        reasoning: [headline, why, contextLine(structure, rsi14, volumeVsAvg)],
        signalsUsed,
        signalAgreement,
        engineVersion: ENGINE_VERSION,
        createdAt,
        expiresAt,
        snapshot: { ...snapshotBase, levelBasis: { invalidation: null, atr: r6(atr14) } },
      },
    };
  }

  // ── Levels ──
  if (atr14 === null || !(atr14 > 0)) {
    return { status: "INVALID_INPUT", reason: "ATR is unavailable or zero; cannot size invalidation" };
  }
  const bullish = direction === "BULLISH";
  const sign = bullish ? 1 : -1;
  const p = ENGINE_PARAMS;

  // Nearest structure level on the invalidation side, inside the ATR band from entry.
  const near = p.levelBandNearAtr * atr14;
  const far = p.levelBandFarAtr * atr14;
  const guardLevel = structure.levels
    .filter((l) => (bullish ? l.price < entry - near && l.price > entry - far : l.price > entry + near && l.price < entry + far))
    .sort((a, b) => Math.abs(entry - a.price) - Math.abs(entry - b.price))[0];

  const invalidation = r10(
    guardLevel ? guardLevel.price - sign * p.levelBufferAtr * atr14 : entry - sign * p.invalidationAtr * atr14,
  );
  const risk = Math.abs(entry - invalidation);
  const target = r10(entry + sign * p.rewardToRisk * risk);

  const ordered = bullish ? invalidation < entry && entry < target : invalidation > entry && entry > target;
  if (!ordered || invalidation <= 0 || target <= 0 || !Number.isFinite(target)) {
    return { status: "INVALID_INPUT", reason: "Computed levels are not valid for this price (non-positive or mis-ordered)" };
  }

  const blocker = structure.levels
    .filter((l) => (bullish ? l.price > entry && l.price < target : l.price < entry && l.price > target))
    .sort((a, b) => Math.abs(entry - a.price) - Math.abs(entry - b.price))[0];

  const reasoning = [
    headline,
    `Entry reference ${fmt(entry)} is the server-observed quote. ATR(14) is ${fmt(atr14)}.`,
    guardLevel
      ? `Invalidation ${fmt(invalidation)} sits just beyond the ${guardLevel.kind.toLowerCase()} near ${fmt(guardLevel.price)} (${guardLevel.touches} touches).`
      : `Invalidation ${fmt(invalidation)} is ${p.invalidationAtr} x ATR(14) from entry.`,
    `Target ${fmt(target)} is ${p.rewardToRisk} x the invalidation distance from entry.`,
    ...(blocker ? [`Note: a ${blocker.kind.toLowerCase()} near ${fmt(blocker.price)} lies between entry and target.`] : []),
    contextLine(structure, rsi14, volumeVsAvg),
  ];

  return {
    status: "OK",
    result: {
      direction,
      timeframe,
      horizonHours,
      entryReferencePrice: entry,
      targetPrice: target,
      invalidationPrice: invalidation,
      reasoning,
      signalsUsed,
      signalAgreement,
      engineVersion: ENGINE_VERSION,
      createdAt,
      expiresAt,
      snapshot: {
        ...snapshotBase,
        levelBasis: { invalidation: guardLevel ? "STRUCTURE_LEVEL" : "ATR", atr: r6(atr14) },
      },
    },
  };
}

function contextLine(
  s: { breakout: string; volatility: string; regime: string },
  rsi14: number | null,
  volumeVsAvg: number | null,
): string {
  const parts = [
    `breakout state ${s.breakout.toLowerCase()}`,
    `volatility ${s.volatility.toLowerCase()}`,
    `regime ${s.regime.toLowerCase()}`,
    rsi14 === null ? null : `RSI(14) ${fmt(rsi14)}`,
    volumeVsAvg === null ? "volume unavailable" : `volume ${fmt(volumeVsAvg)} x its 20-candle average`,
  ].filter((x): x is string => x !== null);
  return `Context: ${parts.join(", ")}.`;
}
