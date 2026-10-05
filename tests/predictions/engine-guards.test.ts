import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MarketStructure } from "@/services/indicators/structure";
import { build, upCloses, downCloses, T0 } from "./helpers";

// Wrap the real structure engine so a single field can be overridden per test.
const override = vi.hoisted(() => ({ patch: null as null | ((s: MarketStructure) => MarketStructure) }));
vi.mock("@/services/indicators/structure", async (importActual) => {
  const actual = await importActual<typeof import("@/services/indicators/structure")>();
  return {
    ...actual,
    analyzeMarketStructure: (...args: Parameters<typeof actual.analyzeMarketStructure>) => {
      const r = actual.analyzeMarketStructure(...args);
      return r.status === "OK" && override.patch ? override.patch(r) : r;
    },
  };
});

import { generatePrediction } from "@/services/predictions/engine";

const run = (closes: number[]) =>
  generatePrediction({ timeframe: "1h", candles: build(closes), quote: { price: closes.at(-1)! }, now: new Date(T0) });

beforeEach(() => {
  override.patch = null;
});

describe("guards and level selection", () => {
  it("withholds a bullish call when price has broken DOWN through the prior range", () => {
    override.patch = (s) => ({ ...s, breakout: "BREAKDOWN" });
    const o = run(upCloses());
    expect(o.status === "OK" && o.result.direction).toBe("NEUTRAL");
    expect(o.status === "OK" && o.result.snapshot.guards.find((g) => g.id === "CONFLICTING_BREAKOUT")!.triggered).toBe(true);
  });
  it("withholds a bearish call when price has broken UP through the prior range", () => {
    override.patch = (s) => ({ ...s, breakout: "BREAKOUT" });
    const o = run(downCloses());
    expect(o.status === "OK" && o.result.direction).toBe("NEUTRAL");
  });
  it("keeps the call when the breakout agrees with the direction", () => {
    override.patch = (s) => ({ ...s, breakout: "BREAKOUT" });
    const o = run(upCloses());
    expect(o.status === "OK" && o.result.direction).toBe("BULLISH");
  });
  it("places a bullish invalidation just below a nearby support level", () => {
    const closes = upCloses();
    const entry = closes.at(-1)!;
    override.patch = (s) => ({
      ...s,
      levels: [{ price: entry - 4, kind: "SUPPORT", touches: 3, lastTouch: "t", distancePct: 0.02 }],
    });
    const o = run(closes);
    if (o.status !== "OK") throw new Error("expected OK");
    const atr = o.result.snapshot.levelBasis.atr!;
    expect(o.result.snapshot.levelBasis.invalidation).toBe("STRUCTURE_LEVEL");
    expect(o.result.invalidationPrice!).toBeCloseTo(entry - 4 - ENGINE_BUFFER * atr, 3);
  });
  it("ignores a level outside the ATR band and falls back to ATR", () => {
    const closes = upCloses();
    const entry = closes.at(-1)!;
    override.patch = (s) => ({
      ...s,
      levels: [{ price: entry - 60, kind: "SUPPORT", touches: 3, lastTouch: "t", distancePct: 0.3 }],
    });
    const o = run(closes);
    expect(o.status === "OK" && o.result.snapshot.levelBasis.invalidation).toBe("ATR");
  });
  it("notes a resistance level that lies between entry and target", () => {
    const closes = upCloses();
    const entry = closes.at(-1)!;
    override.patch = (s) => ({
      ...s,
      levels: [{ price: entry + 3, kind: "RESISTANCE", touches: 2, lastTouch: "t", distancePct: 0.01 }],
    });
    const o = run(closes);
    expect(o.status === "OK" && o.result.reasoning.join(" ")).toMatch(/resistance near .* lies between entry and target/);
  });
  it("returns INVALID_INPUT if the votes ever disagree with the structure engine", () => {
    override.patch = (s) => ({ ...s, signals: { bullish: 1, bearish: 0, total: 5 } });
    expect(run(upCloses()).status).toBe("INVALID_INPUT");
  });
});

const ENGINE_BUFFER = 0.25;
