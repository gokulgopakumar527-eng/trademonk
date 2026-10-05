import { describe, expect, it } from "vitest";
import {
  AGREEMENT_DISCLAIMER,
  ENGINE_PARAMS,
  ENGINE_VERSION,
  HORIZON_HOURS,
  generatePrediction,
  type EngineOutcome,
  type EngineResult,
} from "@/services/predictions/engine";
import { analyzeMarketStructure } from "@/services/indicators/structure";
import { build, downCloses, flatCloses, HOUR, T0, upCloses, zigzag } from "./helpers";

const NOW = new Date(T0);
const run = (closes: number[], price = closes.at(-1)!, over: { forming?: boolean; timeframe?: "15m" | "1h" | "4h" | "1d" } = {}): EngineOutcome =>
  generatePrediction({
    timeframe: over.timeframe ?? "1h",
    candles: build(closes, { forming: over.forming }),
    quote: { price },
    now: NOW,
  });
const ok = (o: EngineOutcome): EngineResult => {
  if (o.status !== "OK") throw new Error(`expected OK, got ${o.status}`);
  return o.result;
};

describe("bullish conditions", () => {
  const r = ok(run(upCloses()));
  it("returns BULLISH with at least 4 of 5 signals agreeing", () => {
    expect(r.direction).toBe("BULLISH");
    expect(r.signalAgreement.side).toBe("BULLISH");
    expect(r.signalAgreement.agreeing).toBeGreaterThanOrEqual(ENGINE_PARAMS.minAgreement);
    expect(r.signalAgreement.total).toBe(5);
  });
  it("orders levels: invalidation < entry < target, all positive", () => {
    expect(r.invalidationPrice!).toBeGreaterThan(0);
    expect(r.invalidationPrice!).toBeLessThan(r.entryReferencePrice);
    expect(r.entryReferencePrice).toBeLessThan(r.targetPrice!);
  });
  it("target distance is rewardToRisk times the invalidation distance", () => {
    const risk = r.entryReferencePrice - r.invalidationPrice!;
    expect((r.targetPrice! - r.entryReferencePrice) / risk).toBeCloseTo(ENGINE_PARAMS.rewardToRisk, 6);
  });
  it("sizes invalidation from ATR when no structure level is near", () => {
    expect(r.snapshot.levelBasis.invalidation).toBe("ATR");
    const atr = r.snapshot.levelBasis.atr!;
    expect(r.entryReferencePrice - r.invalidationPrice!).toBeCloseTo(ENGINE_PARAMS.invalidationAtr * atr, 3);
  });
  it("carries engine metadata and timeframe horizon", () => {
    expect(r.engineVersion).toBe(ENGINE_VERSION);
    expect(r.timeframe).toBe("1h");
    expect(r.horizonHours).toBe(HORIZON_HOURS["1h"]);
    expect(r.createdAt).toBe(NOW.toISOString());
    expect(r.expiresAt).toBe(new Date(NOW.getTime() + 24 * HOUR).toISOString());
  });
  it("uses the supplied server quote as the entry reference, not a candle close", () => {
    const px = upCloses().at(-1)! + 0.37;
    expect(ok(run(upCloses(), px)).entryReferencePrice).toBe(px);
  });
});

describe("bearish conditions", () => {
  const r = ok(run(downCloses()));
  it("returns BEARISH with mirrored levels", () => {
    expect(r.direction).toBe("BEARISH");
    expect(r.signalAgreement.side).toBe("BEARISH");
    expect(r.signalAgreement.agreeing).toBeGreaterThanOrEqual(ENGINE_PARAMS.minAgreement);
    expect(r.targetPrice!).toBeLessThan(r.entryReferencePrice);
    expect(r.entryReferencePrice).toBeLessThan(r.invalidationPrice!);
    expect(r.targetPrice!).toBeGreaterThan(0);
  });
});

describe("neutral conditions", () => {
  it("returns NEUTRAL with no levels when signals do not agree", () => {
    const r = ok(run(flatCloses()));
    expect(r.direction).toBe("NEUTRAL");
    expect(r.targetPrice).toBeNull();
    expect(r.invalidationPrice).toBeNull();
    expect(r.signalAgreement.agreeing).toBeLessThan(ENGINE_PARAMS.minAgreement);
    expect(r.reasoning.join(" ")).toMatch(/withheld/);
  });
  it("withholds direction on RSI exhaustion even when 4 of 5 agree", () => {
    const r = ok(run(zigzag(10, 4)));
    expect(r.direction).toBe("NEUTRAL");
    expect(r.signalAgreement.agreeing).toBeGreaterThanOrEqual(ENGINE_PARAMS.minAgreement);
    expect(r.snapshot.guards.find((g) => g.id === "MOMENTUM_EXHAUSTION")!.triggered).toBe(true);
  });
  it("mirrors the exhaustion guard on the bearish side", () => {
    const r = ok(run(zigzag(10, 4).map((p) => 900 - p)));
    expect(r.direction).toBe("NEUTRAL");
    expect(r.snapshot.guards.find((g) => g.id === "MOMENTUM_EXHAUSTION")!.triggered).toBe(true);
  });
});

describe("insufficient and invalid data", () => {
  it("returns INSUFFICIENT_DATA below 60 closed candles instead of guessing", () => {
    expect(run(upCloses().slice(0, 30))).toEqual({ status: "INSUFFICIENT_DATA", needed: 60, have: 30 });
  });
  it("does not count the forming candle toward the minimum", () => {
    const closes = upCloses().slice(0, 60);
    expect(run(closes).status).toBe("OK");
    expect(run(closes, closes.at(-1), { forming: true })).toEqual({ status: "INSUFFICIENT_DATA", needed: 60, have: 59 });
  });
  it("rejects non-positive or non-finite quote prices", () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(run(upCloses(), bad).status).toBe("INVALID_INPUT");
    }
  });
  it("rejects a quote that disagrees wildly with the last closed candle", () => {
    const o = run(upCloses(), upCloses().at(-1)! * 1.4);
    expect(o).toMatchObject({ status: "INVALID_INPUT" });
  });
  it("rejects levels that would be non-positive instead of saving them", () => {
    // Low-priced downtrend with wide candles: 1.5 x risk below entry would be below zero.
    const closes = downCloses().map((p) => p / 20);
    const o = generatePrediction({
      timeframe: "1h",
      candles: build(closes, { half: 3 }),
      quote: { price: closes.at(-1)! },
      now: NOW,
    });
    expect(o).toEqual({ status: "INVALID_INPUT", reason: expect.stringMatching(/levels/i) });
  });
});

describe("forming candle", () => {
  it("never influences the result", () => {
    const closes = upCloses();
    const a = generatePrediction({ timeframe: "1h", candles: build(closes), quote: { price: 212 }, now: NOW });
    const withForming = [...build(closes), { ...build([9999], { endMs: T0 + HOUR })[0]!, closed: false, high: 99999 }];
    const b = generatePrediction({ timeframe: "1h", candles: withForming, quote: { price: 212 }, now: NOW });
    expect(b).toEqual(a);
  });
});

describe("determinism", () => {
  it("produces identical output for identical input, including across fresh copies", () => {
    const a = run(upCloses());
    const b = run(upCloses());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a).toEqual(b);
  });
  it("depends on `now` only through createdAt / expiresAt", () => {
    const a = ok(generatePrediction({ timeframe: "4h", candles: build(upCloses()), quote: { price: 212 }, now: NOW }));
    const b = ok(generatePrediction({ timeframe: "4h", candles: build(upCloses()), quote: { price: 212 }, now: new Date(T0 + 5 * HOUR) }));
    expect({ ...a, createdAt: "", expiresAt: "" }).toEqual({ ...b, createdAt: "", expiresAt: "" });
    expect(a.expiresAt).toBe(new Date(T0 + 96 * HOUR).toISOString());
  });
  it("uses the horizon of the requested timeframe", () => {
    for (const tf of ["15m", "1h", "4h", "1d"] as const) {
      const r = ok(run(upCloses(), undefined, { timeframe: tf }));
      expect(r.horizonHours).toBe(HORIZON_HOURS[tf]);
      expect(r.snapshot.timeframe).toBe(tf);
    }
  });
  it("does not use VWAP on the daily timeframe", () => {
    expect(ok(run(upCloses(), undefined, { timeframe: "1d" })).snapshot.indicators.vwap).toBeNull();
    expect(ok(run(upCloses(), undefined, { timeframe: "1h" })).snapshot.indicators.vwap).not.toBeNull();
  });
});

describe("signal agreement", () => {
  const series: Array<[string, number[]]> = [
    ["up", upCloses()],
    ["down", downCloses()],
    ["flat", flatCloses()],
    ["hot", zigzag(10, 4)],
    ["weak up", zigzag(10, 0.3)],
    ["weak down", zigzag(10, 0.3).map((p) => 300 - p)],
    ["long up", zigzag(30, 1.2)],
  ];
  it.each(series)("matches the market-structure engine's vote count (%s)", (_n, closes) => {
    const s = analyzeMarketStructure(build(closes));
    if (s.status !== "OK") throw new Error("fixture too short");
    const r = ok(run(closes));
    expect(r.snapshot.votes).toEqual({ bullish: s.signals.bullish, bearish: s.signals.bearish, total: 5 });
    expect(r.signalAgreement.agreeing).toBe(Math.max(s.signals.bullish, s.signals.bearish));
  });
  it("exposes exactly five VOTE signals and their readings sum to the counts", () => {
    const r = ok(run(upCloses()));
    const votes = r.signalsUsed.filter((s) => s.group === "VOTE");
    expect(votes).toHaveLength(5);
    expect(votes.filter((v) => v.reading === "BULLISH")).toHaveLength(r.snapshot.votes.bullish);
    expect(votes.filter((v) => v.reading === "BEARISH")).toHaveLength(r.snapshot.votes.bearish);
  });
  it("states agreement as 'N of 5 signals agree' in the reasoning", () => {
    expect(ok(run(upCloses())).reasoning[0]).toMatch(/^\d of 5 signals agree \(bullish\)/);
  });
  it("uses a split-vote headline instead of a misleading count on ties", () => {
    const r = ok(run(flatCloses()));
    expect(r.signalAgreement.side).toBe("NONE");
    expect(r.reasoning[0]).toMatch(/^Signals are split/);
  });
  it("records the disclaimer and never uses probability-of-outcome language", () => {
    const r = ok(run(upCloses()));
    expect(r.snapshot.agreementNote).toBe(AGREEMENT_DISCLAIMER);
    const text = JSON.stringify(r).replace(AGREEMENT_DISCLAIMER, "");
    expect(text).not.toMatch(/probab|likelihood|chance of|guarantee|will (rise|fall|win)|win rate|success/i);
  });
});

describe("signals_used", () => {
  it("lists every required input with observed values only", () => {
    const r = ok(run(upCloses()));
    const ids = r.signalsUsed.map((s) => s.id);
    for (const id of [
      "STRUCTURE", "PRICE_VS_EMA20", "EMA20_VS_EMA50", "MACD_HISTOGRAM", "RSI_14",
      "BREAKOUT_STATE", "VOLATILITY_REGIME", "ATR_14", "VOLUME_VS_20_AVG", "PRICE_VS_VWAP",
      "BOLLINGER_PERCENT_B", "STOCH_RSI_K_MINUS_D", "PRICE_VS_SMA200",
    ]) expect(ids).toContain(id);
    // 80 candles: not enough for SMA(200), so the value is null, not invented.
    expect(r.signalsUsed.find((s) => s.id === "PRICE_VS_SMA200")).toMatchObject({ reading: "N/A", value: null });
  });
  it("records volume as unavailable rather than inventing it when candles have none", () => {
    const o = generatePrediction({ timeframe: "1h", candles: build(upCloses(), { volume: null }), quote: { price: 212 }, now: NOW });
    expect(ok(o).signalsUsed.find((s) => s.id === "VOLUME_VS_20_AVG")!.value).toBeNull();
  });
  it("stays within the database rationale limit", () => {
    expect(ok(run(upCloses())).reasoning.join("\n").length).toBeLessThan(4000);
  });
});
