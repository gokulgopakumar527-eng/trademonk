import { describe, expect, it } from "vitest";
import { buildRowAnalytics, buildTechnicalView, describeRsi, describeVolume } from "@/features/markets/technical";
import type { Candle } from "@/types/market";

/** Deterministic synthetic test candles (test data only; nothing here is shown in the product). */
function candles(n: number, opts: { forming?: boolean; step?: number; hours?: number } = {}): Candle[] {
  const step = opts.step ?? 0.5;
  return Array.from({ length: n }, (_, i) => {
    const wave = Math.sin(i / 4) * 3;
    const close = 100 + i * step + wave;
    return {
      openTime: new Date(Date.UTC(2026, 0, 1, 0, 0) + i * (opts.hours ?? 1) * 3_600_000).toISOString(),
      open: close - 0.3,
      high: close + 1,
      low: close - 1,
      close,
      volume: 100 + (i % 7),
      closed: !(opts.forming && i === n - 1),
    };
  });
}

describe("buildTechnicalView", () => {
  it("passes the forming candle to the chart but excludes it from every indicator", () => {
    const cs = candles(120, { forming: true });
    const v = buildTechnicalView(cs, "1h");
    expect(v.chartCandles).toHaveLength(120);
    expect(v.chartCandles.at(-1)!.closed).toBe(false);
    const lastClosedTime = Math.floor(new Date(cs[118]!.openTime).getTime() / 1000);
    expect(v.overlays.ema20.at(-1)!.time).toBe(lastClosedTime);
    expect(v.snapshot.closedCount).toBe(119);
    expect(v.snapshot.asOf).toBe(cs[118]!.openTime);
    expect(v.snapshot.lastClose).toBe(cs[118]!.close);
  });

  it("changing only the forming candle cannot change any indicator or the structure", () => {
    const a = candles(120, { forming: true });
    const b = a.map((c, i) => (i === 119 ? { ...c, close: c.close + 500, high: c.high + 500 } : c));
    const va = buildTechnicalView(a, "1h");
    const vb = buildTechnicalView(b, "1h");
    expect(vb.snapshot).toEqual(va.snapshot);
    expect(vb.structure).toEqual(va.structure);
  });

  it("offers VWAP on intraday timeframes and not on 1d/1w", () => {
    const cs = candles(100);
    expect(buildTechnicalView(cs, "1h").overlays.vwap).not.toBeNull();
    expect(buildTechnicalView(cs, "1h").snapshot.vwap).not.toBeNull();
    expect(buildTechnicalView(cs, "1d").overlays.vwap).toBeNull();
    expect(buildTechnicalView(cs, "1d").snapshot.vwap).toBeNull();
    expect(buildTechnicalView(cs, "1w").overlays.vwap).toBeNull();
  });

  it("reports INSUFFICIENT_DATA rather than inventing a structure for short series", () => {
    const v = buildTechnicalView(candles(30), "1h");
    expect(v.structure).toEqual({ status: "INSUFFICIENT_DATA", needed: 60, have: 30 });
    expect(v.snapshot.sma200).toBeNull();
  });

  it("produces structure with a bounded agreement score for enough candles", () => {
    const v = buildTechnicalView(candles(250), "1h");
    expect(v.structure.status).toBe("OK");
    if (v.structure.status === "OK") {
      expect(v.structure.confidence).toBeGreaterThanOrEqual(0);
      expect(v.structure.confidence).toBeLessThanOrEqual(1);
      expect(v.structure.confidence * v.structure.signals.total).toBeCloseTo(
        Math.max(v.structure.signals.bullish, v.structure.signals.bearish),
      );
    }
    expect(v.snapshot.sma200).not.toBeNull();
  });

  it("handles an empty series without throwing or fabricating values", () => {
    const v = buildTechnicalView([], "1h");
    expect(v.chartCandles).toEqual([]);
    expect(v.snapshot.rsi14).toBeNull();
    expect(v.snapshot.lastClose).toBeNull();
    expect(v.snapshot.closedCount).toBe(0);
  });

  it("overlay points are strictly ascending in time", () => {
    const v = buildTechnicalView(candles(200), "4h");
    for (const line of [v.overlays.ema20, v.overlays.ema50, v.overlays.bbUpper, v.overlays.bbLower]) {
      for (let i = 1; i < line.length; i++) expect(line[i]!.time).toBeGreaterThan(line[i - 1]!.time);
    }
  });
});

describe("buildRowAnalytics", () => {
  it("returns nulls with an explanatory note when there are too few candles", () => {
    const r = buildRowAnalytics(candles(20));
    expect(r.trend).toBeNull();
    expect(r.note).toMatch(/needs 60/);
    expect(r.rsi14).not.toBeNull();
  });
  it("returns no RSI at all with 14 or fewer candles", () => {
    expect(buildRowAnalytics(candles(10)).rsi14).toBeNull();
  });
  it("returns a trend with enough data", () => {
    const r = buildRowAnalytics(candles(120));
    expect(["BULLISH", "BEARISH", "NEUTRAL"]).toContain(r.trend);
    expect(r.note).toBeNull();
  });
});

describe("descriptive labels", () => {
  it("describes RSI zones factually", () => {
    expect(describeRsi(75)).toBe("At or above 70");
    expect(describeRsi(25)).toBe("At or below 30");
    expect(describeRsi(50)).toBe("Between 30 and 70");
    expect(describeRsi(null)).toBe("Not enough data");
    expect(describeVolume(null)).toMatch(/not available/);
    expect(describeVolume(1.5)).toContain("1.50");
  });
});
