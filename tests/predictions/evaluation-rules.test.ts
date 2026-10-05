import { describe, expect, it } from "vitest";
import { evaluatePath, OUTCOME_LABEL, type PathInput } from "@/services/predictions/evaluation-rules";
import { flatHourly } from "./eval-helpers";

const CREATED = "2026-09-28T00:00:30.000Z"; // mid-bar: the 00:00 candle straddles creation
const EXPIRES = "2026-09-29T00:00:30.000Z"; // 24h horizon
const candles = flatHourly;

const bullish = (over: Partial<PathInput> = {}): PathInput => ({
  direction: "BULLISH",
  targetPrice: 110,
  invalidationPrice: 95,
  createdAt: CREATED,
  expiresAt: EXPIRES,
  timeframe: "1h",
  candles: candles(),
  continuous: true,
  ...over,
});
const bearish = (over: Partial<PathInput> = {}): PathInput => bullish({ direction: "BEARISH", targetPrice: 90, invalidationPrice: 105, ...over });

const at = (h: string) => `2026-09-28T${h}:00:00.000Z`;
const outcomeOf = (i: PathInput) => {
  const r = evaluatePath(i);
  if (r.status !== "OK") throw new Error(`expected OK, got ${r.reason}`);
  return r;
};

describe("outcome vocabulary", () => {
  it("maps stored statuses to the product labels", () => {
    expect(OUTCOME_LABEL).toEqual({ WIN: "CORRECT", INVALIDATED: "INCORRECT", EXPIRED: "NO_CLEAR_RESULT" });
  });
});

describe("BULLISH", () => {
  it("is a WIN when a candle high reaches the target", () => {
    const r = outcomeOf(bullish({ candles: candles({ [at("10")]: { high: 111 } }) }));
    expect(r.outcome).toBe("WIN");
    expect(r.detail.firstTouch).toEqual({ kind: "TARGET", level: 110, barOpenTime: at("10"), ambiguousWithinBar: false });
  });
  it("counts an exact touch of the target (inclusive)", () => {
    expect(outcomeOf(bullish({ candles: candles({ [at("10")]: { high: 110 } }) })).outcome).toBe("WIN");
  });
  it("is INVALIDATED when a candle low reaches the invalidation level", () => {
    const r = outcomeOf(bullish({ candles: candles({ [at("10")]: { low: 94 } }) }));
    expect(r.outcome).toBe("INVALIDATED");
    expect(r.detail.firstTouch).toMatchObject({ kind: "INVALIDATION", level: 95, ambiguousWithinBar: false });
  });
  it("counts an exact touch of the invalidation level (inclusive)", () => {
    expect(outcomeOf(bullish({ candles: candles({ [at("10")]: { low: 95 } }) })).outcome).toBe("INVALIDATED");
  });
  it("is EXPIRED (no clear result) when neither level is reached", () => {
    const r = outcomeOf(bullish({ candles: candles({ [at("10")]: { high: 109.99, low: 95.01 } }) }));
    expect(r.outcome).toBe("EXPIRED");
    expect(r.detail.firstTouch).toBeNull();
  });
});

describe("BEARISH", () => {
  it("is a WIN when a candle low reaches the target", () => {
    expect(outcomeOf(bearish({ candles: candles({ [at("10")]: { low: 89 } }) })).outcome).toBe("WIN");
  });
  it("is INVALIDATED when a candle high reaches the invalidation level", () => {
    expect(outcomeOf(bearish({ candles: candles({ [at("10")]: { high: 106 } }) })).outcome).toBe("INVALIDATED");
  });
  it("is EXPIRED when neither level is reached", () => {
    expect(outcomeOf(bearish()).outcome).toBe("EXPIRED");
  });
});

describe("ordering and ambiguity", () => {
  it("the first candle to reach a level decides (target then invalidation = WIN)", () => {
    const c = candles({ [at("08")]: { high: 111 }, [at("12")]: { low: 90 } });
    expect(outcomeOf(bullish({ candles: c })).outcome).toBe("WIN");
  });
  it("the first candle to reach a level decides (invalidation then target = INVALIDATED)", () => {
    const c = candles({ [at("08")]: { low: 90 }, [at("12")]: { high: 111 } });
    expect(outcomeOf(bullish({ candles: c })).outcome).toBe("INVALIDATED");
  });
  it("one candle reaching both levels is resolved against the prediction and flagged", () => {
    const r = outcomeOf(bullish({ candles: candles({ [at("10")]: { high: 111, low: 94 } }) }));
    expect(r.outcome).toBe("INVALIDATED");
    expect(r.detail.firstTouch).toMatchObject({ kind: "INVALIDATION", ambiguousWithinBar: true });
  });
});

describe("only candles fully inside the horizon count", () => {
  it("ignores a spike in the candle that was already forming at creation", () => {
    // 00:00 opens BEFORE created_at (00:00:30): part of it predates the prediction.
    const r = outcomeOf(bullish({ candles: candles({ [at("00")]: { high: 500 } }) }));
    expect(r.outcome).toBe("EXPIRED");
    expect(r.detail.windowStart).toBe(at("01"));
  });
  it("ignores candles before creation", () => {
    expect(outcomeOf(bullish({ candles: candles({ "2026-09-27T20:00:00.000Z": { high: 500 } }) })).outcome).toBe("EXPIRED");
  });
  it("ignores the candle that opens after the horizon (and any forming candle)", () => {
    const c = candles({ "2026-09-29T00:00:00.000Z": { high: 500 } }, { endOpen: "2026-09-29T01:00:00.000Z" });
    const r = outcomeOf(bullish({ candles: c }));
    expect(r.outcome).toBe("EXPIRED");
    expect(r.detail.windowEnd).toBe("2026-09-29T00:00:00.000Z");
    expect(r.detail.barsEvaluated).toBe(23);
  });
  it("never uses a forming candle: mid-horizon it is inconsistent data and is refused", () => {
    const c = candles({ [at("10")]: { high: 500, closed: false } });
    const r = evaluatePath(bullish({ candles: c }));
    expect(r).toMatchObject({ status: "INCOMPLETE", reason: "GAP_IN_SERIES" });
  });
  it("never uses a forming candle: where gaps are legitimate its spike is simply ignored", () => {
    const c = candles({ [at("10")]: { high: 500, closed: false } });
    expect(outcomeOf(bullish({ continuous: false, candles: c })).outcome).toBe("EXPIRED");
  });
});

describe("incomplete data is refused, never guessed", () => {
  const reason = (i: PathInput) => {
    const r = evaluatePath(i);
    return r.status === "INCOMPLETE" ? r.reason : `OK:${r.outcome}`;
  };
  it("no candles at all", () => expect(reason(bullish({ candles: [] }))).toBe("NO_BARS_IN_WINDOW"));
  it("history that starts after creation", () => {
    const c = candles().filter((x) => Date.parse(x.openTime) > Date.parse(CREATED));
    expect(reason(bullish({ candles: c }))).toBe("SERIES_STARTS_AFTER_CREATION");
  });
  it("history that ends before the horizon does", () => {
    expect(reason(bullish({ candles: candles({}, { endOpen: at("20") }) }))).toBe("SERIES_ENDS_BEFORE_EXPIRY");
  });
  it("a missing candle inside the horizon of a continuous market", () => {
    expect(reason(bullish({ candles: candles({}, { skip: [at("10")] }) }))).toBe("GAP_IN_SERIES");
  });
  it("a missing candle right after creation", () => {
    expect(reason(bullish({ candles: candles({}, { skip: [at("01")] }) }))).toBe("GAP_IN_SERIES");
  });
  it("a missing last candle of a continuous market", () => {
    expect(reason(bullish({ candles: candles({}, { skip: ["2026-09-28T23:00:00.000Z"] }) }))).toBe("GAP_IN_SERIES");
  });
  it("gaps are legitimate for markets with sessions (continuous = false)", () => {
    expect(reason(bullish({ continuous: false, candles: candles({}, { skip: [at("10"), at("11")] }) }))).toBe("OK:EXPIRED");
  });
  it.each([
    ["inverted timestamps", { createdAt: EXPIRES, expiresAt: CREATED }],
    ["garbage timestamps", { createdAt: "nope" }],
    ["bullish levels the wrong way round", { targetPrice: 90, invalidationPrice: 110 }],
    ["bearish-shaped levels on a bullish prediction", { targetPrice: 95, invalidationPrice: 95 }],
    ["non-positive level", { invalidationPrice: 0 }],
    ["NaN level", { targetPrice: Number.NaN }],
  ] as Array<[string, Partial<PathInput>]>)("invalid input: %s", (_l, over) => {
    expect(reason(bullish(over))).toBe("INVALID_INPUT");
  });
  it("a malformed candle", () => {
    const c = candles({ [at("10")]: { high: 98, low: 99 } });
    expect(reason(bullish({ candles: c }))).toBe("INVALID_INPUT");
  });
});

describe("determinism", () => {
  it("returns identical output for identical input, and does not mutate it", () => {
    const input = bullish({ candles: candles({ [at("10")]: { high: 111 } }) });
    const snapshot = JSON.stringify(input);
    expect(evaluatePath(input)).toEqual(evaluatePath(input));
    expect(JSON.stringify(input)).toBe(snapshot);
  });
  it("is independent of the wall clock", () => {
    const input = bullish({ candles: candles({ [at("10")]: { high: 111 } }) });
    const a = evaluatePath(input);
    const later = new Date("2031-01-01T00:00:00Z").getTime();
    const realNow = Date.now;
    Date.now = () => later;
    try {
      expect(evaluatePath(input)).toEqual(a);
    } finally {
      Date.now = realNow;
    }
  });
});
