import { describe, expect, it } from "vitest";
import {
  atr, bollinger, closedCandles, ema, historicalVolatility, macd, rsi, sma, stochRsi, volumeMovingAverage, vwap,
} from "@/services/indicators/core";
import type { Candle } from "@/types/market";

// Deterministic synthetic series. Expected values below were produced by an INDEPENDENT Python
// implementation (/tmp/ref.py during Phase 2 development), not by this code.
const N = 80;
const c = Array.from({ length: N }, (_, i) => 100 + 10 * Math.sin(i / 5) + (i % 7) * 0.5);
const candles: Candle[] = c.map((close, i) => ({
  openTime: new Date(Date.UTC(2026, 0, 1, i)).toISOString(),
  open: i === 0 ? close : c[i - 1]!,
  high: close + 1 + (i % 3) * 0.3,
  low: close - 1 - (i % 4) * 0.2,
  close,
  volume: 1000 + ((i * 37) % 500),
  closed: true,
}));
const at = (s: (number | null)[], i: number) => s[i];

const EXPECT = {
  sma20: { 19: 105.73452011681161, 25: 101.63936139133679, 50: 105.94194944902952, 79: 105.92659356736435 },
  ema12: { 19: 102.48848487053515, 25: 95.82731262354595, 79: 105.3914129766667 },
  rsi14: { 19: 41.58708638499228, 25: 37.220156480594795, 33: 67.35458636892895, 79: 39.62337124065143 },
  macd: { 25: -6.765102762946256, 33: -2.1640837457664617, 79: 0.8630321196679773 },
  signal: { 33: -4.854683303810294, 50: 0.32324256220176756, 79: 1.8693283267682965 },
  hist: { 33: 2.690599558043832, 50: -1.441513227310563, 79: -1.0062962071003192 },
  bbUpper: { 19: 115.75833771797247, 79: 115.42438201105844 },
  bbLower: { 19: 95.71070251565075, 79: 96.42880512367026 },
  atr14: { 19: 3.0683889723467046, 50: 3.2377098026176676, 79: 3.1779265298428174 },
  vwap: { 19: 106.08213226123567, 79: 102.66066367091678 },
  stochK: { 33: 100, 50: 0, 79: 0 },
  stochD: { 33: 98.99485711162485, 79: 7.501720363733731 },
} as const;

function check(name: string, series: (number | null)[], exp: Record<number, number>) {
  for (const [i, v] of Object.entries(exp)) {
    const got = at(series, Number(i));
    expect(got, `${name}[${i}]`).not.toBeNull();
    expect(got!, `${name}[${i}]`).toBeCloseTo(v, 8);
  }
}

describe("indicators match an independent reference implementation", () => {
  it("SMA / EMA", () => {
    check("sma20", sma(c, 20), EXPECT.sma20);
    check("ema12", ema(c, 12), EXPECT.ema12);
  });
  it("RSI (Wilder)", () => check("rsi14", rsi(c, 14), EXPECT.rsi14));
  it("MACD", () => {
    const m = macd(c);
    check("macd", m.macd, EXPECT.macd);
    check("signal", m.signal, EXPECT.signal);
    check("hist", m.histogram, EXPECT.hist);
  });
  it("Bollinger (population sd)", () => {
    const b = bollinger(c, 20, 2);
    check("upper", b.upper, EXPECT.bbUpper);
    check("lower", b.lower, EXPECT.bbLower);
  });
  it("ATR (Wilder)", () => check("atr14", atr(candles, 14), EXPECT.atr14));
  it("VWAP", () => check("vwap", vwap(candles), EXPECT.vwap));
  it("Stochastic RSI", () => {
    const s = stochRsi(c);
    check("k", s.k, EXPECT.stochK);
    check("d", s.d, EXPECT.stochD);
  });
});

describe("indicator behaviour", () => {
  it("SMA/EMA on a linear series are hand-checkable and null-padded", () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
    expect(ema([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });
  it("outputs are aligned to the input length", () => {
    for (const s of [sma(c, 20), ema(c, 20), rsi(c), macd(c).macd, bollinger(c).upper, atr(candles), stochRsi(c).k]) {
      expect(s).toHaveLength(N);
    }
    expect(rsi([1, 2, 3], 14)).toEqual([null, null, null]);
  });
  it("RSI extremes: all gains 100, all losses 0, flat 50", () => {
    const up = Array.from({ length: 30 }, (_, i) => i + 1);
    expect(rsi(up).at(-1)).toBe(100);
    expect(rsi([...up].reverse()).at(-1)).toBe(0);
    expect(rsi(new Array(30).fill(5)).at(-1)).toBe(50);
  });
  it("never looks ahead: appending future data leaves past values unchanged", () => {
    const short = c.slice(0, 60);
    for (const [a, b] of [
      [rsi(short), rsi(c)], [ema(short, 12), ema(c, 12)], [macd(short).signal, macd(c).signal],
      [atr(candles.slice(0, 60)), atr(candles)], [bollinger(short).upper, bollinger(c).upper],
    ] as const) {
      for (let i = 0; i < 60; i++) expect(a[i]).toBe(b[i]);
    }
  });
  it("rejects invalid parameters instead of returning garbage", () => {
    expect(() => sma(c, 0)).toThrow(RangeError);
    expect(() => ema(c, 1.5)).toThrow(RangeError);
    expect(() => macd(c, 26, 12)).toThrow(RangeError);
  });
  it("VWAP resets at anchors and refuses unknown volume", () => {
    const day = (x: Candle) => x.openTime.slice(0, 10);
    const v = vwap(candles, day);
    expect(v[24]).toBeCloseTo((candles[24]!.high + candles[24]!.low + candles[24]!.close) / 3, 9); // first bar of day 2
    const noVol = candles.map((x, i) => (i === 3 ? { ...x, volume: null } : x));
    expect(vwap(noVol)[3]).toBeNull();
    expect(vwap(noVol)[4]).toBeNull(); // run is broken, not silently continued
  });
  it("volume MA and volatility are null until enough data, then finite and non-negative", () => {
    const vm = volumeMovingAverage(candles, 20);
    expect(vm[18]).toBeNull();
    expect(vm[19]).not.toBeNull();
    const hv = historicalVolatility(c, 20);
    expect(hv[19]).toBeNull();
    expect(hv[79]!).toBeGreaterThan(0);
  });
  it("closedCandles drops the forming candle", () => {
    expect(closedCandles([{ ...candles[0]!, closed: true }, { ...candles[1]!, closed: false }])).toHaveLength(1);
  });
});
