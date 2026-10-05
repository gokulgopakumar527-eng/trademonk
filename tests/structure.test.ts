import { describe, expect, it } from "vitest";
import { analyzeMarketStructure, classifyStructure, findLevels, findSwings, MIN_STRUCTURE_CANDLES } from "@/services/indicators/structure";
import type { Candle } from "@/types/market";

/** Build candles from a close path with a fixed +/- half-range around each close. */
function build(closes: number[], half = 1, closedAll = true): Candle[] {
  return closes.map((close, i) => ({
    openTime: new Date(Date.UTC(2026, 0, 1, i)).toISOString(),
    open: i === 0 ? close : closes[i - 1]!,
    high: close + half,
    low: close - half,
    close,
    volume: 100,
    closed: closedAll || i < closes.length - 1,
  }));
}
/** Zig-zag with a drift: `drift` per wave, waves of 8 candles (up 5, down 3). */
function zigzag(waves: number, drift: number, start = 100): number[] {
  const out: number[] = [];
  let p = start;
  for (let w = 0; w < waves; w++) {
    for (let i = 0; i < 5; i++) out.push((p += 2 + drift));
    for (let i = 0; i < 3; i++) out.push((p -= 2 - drift / 3));
  }
  return out;
}

describe("swings", () => {
  it("finds strict fractal pivots and never flags the newest k candles", () => {
    const s = findSwings(build([1, 2, 3, 10, 3, 2, 1, 2, 3, 4, 5]), 3);
    // The spike at index 3 is a swing high; the trough at index 6 is a genuine swing low.
    expect(s).toEqual([
      expect.objectContaining({ index: 3, kind: "HIGH", price: 11 }),
      expect.objectContaining({ index: 6, kind: "LOW", price: 0 }),
    ]);
    // A spike on the very last candle cannot be confirmed yet.
    expect(findSwings(build([1, 2, 3, 4, 5, 6, 50]), 3)).toEqual([]);
  });
  it("ties are not pivots", () => {
    expect(findSwings(build([1, 2, 5, 5, 2, 1, 1]), 2).filter((x) => x.kind === "HIGH")).toEqual([]);
  });
});

describe("structure classification", () => {
  const sw = (kind: "HIGH" | "LOW", price: number, index: number) => ({ index, time: "t", price, kind });
  it("labels HH/HL, LH/LL, expanding and contracting ranges", () => {
    expect(classifyStructure([sw("HIGH", 10, 1), sw("LOW", 5, 2), sw("HIGH", 12, 3), sw("LOW", 6, 4)])).toBe("HIGHER_HIGH_HIGHER_LOW");
    expect(classifyStructure([sw("HIGH", 12, 1), sw("LOW", 6, 2), sw("HIGH", 10, 3), sw("LOW", 5, 4)])).toBe("LOWER_HIGH_LOWER_LOW");
    expect(classifyStructure([sw("HIGH", 10, 1), sw("LOW", 6, 2), sw("HIGH", 12, 3), sw("LOW", 5, 4)])).toBe("EXPANDING_RANGE");
    expect(classifyStructure([sw("HIGH", 12, 1), sw("LOW", 5, 2), sw("HIGH", 10, 3), sw("LOW", 6, 4)])).toBe("CONTRACTING_RANGE");
  });
  it("is UNDEFINED without two highs and two lows", () => {
    expect(classifyStructure([sw("HIGH", 1, 1), sw("LOW", 0, 2)])).toBe("UNDEFINED");
  });
});

describe("levels", () => {
  it("clusters touches, splits by side of price, and requires >= 2 touches", () => {
    const sw = (price: number, index: number, kind: "HIGH" | "LOW") => ({ index, time: `t${index}`, price, kind });
    const levels = findLevels([sw(100, 1, "LOW"), sw(100.2, 9, "LOW"), sw(120, 3, "HIGH"), sw(119.9, 12, "HIGH"), sw(90, 5, "LOW")], 110, 0.5);
    expect(levels).toHaveLength(2);
    expect(levels.find((l) => l.kind === "SUPPORT")).toMatchObject({ touches: 2, lastTouch: "t9" });
    expect(levels.find((l) => l.kind === "RESISTANCE")!.price).toBeCloseTo(119.95, 6);
  });
});

describe("analyzeMarketStructure", () => {
  it("returns INSUFFICIENT_DATA instead of guessing", () => {
    const r = analyzeMarketStructure(build(zigzag(3, 0.5)));
    expect(r).toEqual({ status: "INSUFFICIENT_DATA", needed: MIN_STRUCTURE_CANDLES, have: 24 });
  });
  it("ignores the forming candle when counting data", () => {
    const r = analyzeMarketStructure(build(zigzag(8, 1), 1, false));
    expect(r.status === "OK" && r.candlesUsed).toBe(63);
  });
  it("identifies an uptrend with HH/HL and bullish agreement", () => {
    const r = analyzeMarketStructure(build(zigzag(10, 1.2)));
    expect(r.status).toBe("OK");
    if (r.status !== "OK") return;
    expect(r.structure).toBe("HIGHER_HIGH_HIGHER_LOW");
    expect(r.trend).toBe("BULLISH");
    expect(r.confidence).toBeGreaterThanOrEqual(0.8);
    expect(r.regime).toBe("TRENDING");
  });
  it("identifies a downtrend", () => {
    const down = zigzag(10, 1.2).map((p) => 400 - p);
    const r = analyzeMarketStructure(build(down));
    expect(r.status === "OK" && r.trend).toBe("BEARISH");
    expect(r.status === "OK" && r.structure).toBe("LOWER_HIGH_LOWER_LOW");
  });
  it("detects a breakout above the prior range and a breakdown below it", () => {
    const flat = Array.from({ length: 70 }, (_, i) => 100 + Math.sin(i) * 0.5);
    const up = analyzeMarketStructure(build([...flat, 115]));
    const dn = analyzeMarketStructure(build([...flat, 85]));
    expect(up.status === "OK" && up.breakout).toBe("BREAKOUT");
    expect(dn.status === "OK" && dn.breakout).toBe("BREAKDOWN");
    expect(analyzeMarketStructure(build(flat)).status === "OK" && (analyzeMarketStructure(build(flat)) as { breakout: string }).breakout).toBe("NONE");
  });
  it("flags volatility expansion and contraction via ATR regime", () => {
    const calm = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 3) * 0.3);
    const expanding = [...calm, ...Array.from({ length: 15 }, (_, i) => 100 + (i % 2 ? 6 : -6))];
    const calmC = build(calm, 0.3);
    const wildC = [...build(calm, 0.3), ...build(expanding.slice(80), 6).map((c, i) => ({ ...c, openTime: new Date(Date.UTC(2026, 0, 10, i)).toISOString() }))];
    const e = analyzeMarketStructure(wildC);
    expect(e.status === "OK" && e.volatility).toBe("EXPANDING");
    const s = analyzeMarketStructure(calmC);
    expect(s.status === "OK" && s.volatility).toBe("STABLE");
    // contraction: wide then narrow
    const contract = [...build(Array.from({ length: 50 }, (_, i) => 100 + (i % 2 ? 5 : -5)), 5), ...build(Array.from({ length: 25 }, () => 100), 0.2).map((c, i) => ({ ...c, openTime: new Date(Date.UTC(2026, 0, 20, i)).toISOString() }))];
    const c = analyzeMarketStructure(contract);
    expect(c.status === "OK" && c.volatility).toBe("CONTRACTING");
  });
  it("confidence is an agreement fraction in [0.2, 1] and is not a probability label", () => {
    const r = analyzeMarketStructure(build(zigzag(10, 1.2)));
    expect(r.status === "OK" && [0.2, 0.4, 0.6, 0.8, 1]).toContain(r.status === "OK" ? r.confidence : -1);
  });
  it("is deterministic", () => {
    const a = analyzeMarketStructure(build(zigzag(10, 0.7)));
    const b = analyzeMarketStructure(build(zigzag(10, 0.7)));
    expect(a).toEqual(b);
  });
});
