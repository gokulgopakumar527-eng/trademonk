import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import type { DataView } from "@/services/market-data/market-data-service";
import type { Asset } from "@/services/market-data/types";
import {
  DuplicateResultError,
  evaluateDuePredictions,
  evaluatePrediction,
  type EvaluablePrediction,
  type EvaluatorDeps,
  type EvaluatorStore,
  type NewResultRow,
  type StoredResult,
} from "@/services/predictions/evaluator";
import { EVALUATOR_VERSION } from "@/services/predictions/evaluation-rules";
import type { CandleSeries, Quote } from "@/types/market";
import { quoteAt } from "../market/helpers";
import { flatHourly, iso } from "./eval-helpers";

const ASSET: Asset = { id: "3f0c6a52-6f0e-4e63-9c53-2f5a1c1d9b10", market: "CRYPTO", symbol: "BTC", currency: "USDT", kind: "CRYPTO", name: "Bitcoin" };
const NSE_ASSET: Asset = { id: "4a1d7b63-7a1f-4f74-8d64-3a6b2d2e0c21", market: "NSE", symbol: "NIFTY 50", currency: "INR", kind: "INDEX", name: "Nifty 50" };

// DB-style timestamps (microseconds, +00:00). Horizon = 24h, created mid-candle.
const CREATED = "2026-09-28T00:00:30.123456+00:00";
const EXPIRES = "2026-09-29T00:00:30.123456+00:00";
const NOW = new Date("2026-09-29T00:02:00.000Z");
const DB_CLOSED_AT = "2026-09-29T00:02:00.777+00:00"; // what the database would stamp: distinct from the app clock
const at = (h: string) => `2026-09-28T${h}:00:00.000Z`;

const BULLISH: EvaluablePrediction = {
  id: "9d8c7b6a-1111-4222-8333-444455556666",
  assetId: ASSET.id,
  direction: "BULLISH",
  targetPrice: 110,
  invalidationPrice: 95,
  horizonHours: 24,
  timeframe: "1h",
  entryReferencePrice: 100,
  engineVersion: "rules-1.0.0",
  entryQuoteIsMock: false,
  createdAt: CREATED,
  expiresAt: EXPIRES,
  contentHash: "a".repeat(64),
};
const BEARISH: EvaluablePrediction = { ...BULLISH, id: "9d8c7b6a-2222-4222-8333-444455556666", direction: "BEARISH", targetPrice: 90, invalidationPrice: 105 };

type Fresh = "FRESH" | "STALE" | "LAST_CLOSE";
const view = <T,>(data: T, status: Fresh = "FRESH", servedFrom: "PROVIDER" | "STORE" = "PROVIDER"): DataView<T> => ({
  ok: true,
  data,
  freshness: { status, ageMs: 0, label: "" },
  servedFrom,
});
const failed = <T,>(code: "TIMEOUT" | "UPSTREAM_ERROR" | "RATE_LIMITED" = "UPSTREAM_ERROR"): DataView<T> => ({
  ok: false,
  error: { code, message: "down", provider: "fake", retryable: true },
  message: "Data temporarily unavailable",
});

const quote = (price: number, over: Partial<Quote> = {}): Quote =>
  quoteAt(iso(NOW.getTime() - 60_000), { price, source: "binance-public", fetchedAt: iso(NOW.getTime() - 59_000), ...over });
const series = (candles = flatHourly(), over: Partial<CandleSeries> = {}): CandleSeries => ({
  source: "binance-public",
  asOf: iso(NOW.getTime() - 5_000),
  fetchedAt: iso(NOW.getTime() - 4_000),
  isMock: false,
  market: "CRYPTO",
  symbol: "BTC",
  currency: "USDT",
  timeframe: "1h",
  candles,
  ...over,
});

/** In-memory store with the same uniqueness rule as the database. */
class MemStore implements EvaluatorStore {
  results = new Map<string, StoredResult>();
  inserts: NewResultRow[] = [];
  insertError: Error | null = null;
  constructor(
    public predictions: EvaluablePrediction[] = [BULLISH],
    private asset: Asset | null = ASSET,
  ) {}
  async listDue(limit: number) {
    return this.predictions
      .filter((p) => p.engineVersion !== null && Date.parse(p.expiresAt) <= NOW.getTime() && !this.results.has(p.id))
      .slice(0, limit);
  }
  async getPrediction(id: string) {
    return this.predictions.find((p) => p.id === id) ?? null;
  }
  async getAssetById() {
    return this.asset;
  }
  async getResult(id: string) {
    await Promise.resolve();
    return this.results.get(id) ?? null;
  }
  async insertResult(row: NewResultRow): Promise<StoredResult> {
    await Promise.resolve();
    if (this.insertError) throw this.insertError;
    if (this.results.has(row.prediction_id)) throw new DuplicateResultError(row.prediction_id);
    const stored: StoredResult = {
      id: `result-${this.results.size + 1}`,
      predictionId: row.prediction_id,
      status: row.status,
      closedAt: DB_CLOSED_AT,
      exitPrice: row.exit_price,
      contentHash: "b".repeat(64),
    };
    this.results.set(row.prediction_id, stored);
    this.inserts.push(row);
    return stored;
  }
}

interface Harness {
  deps: EvaluatorDeps;
  store: MemStore;
  audits: Array<Parameters<EvaluatorDeps["audit"]>[0]>;
  getQuote: ReturnType<typeof vi.fn>;
  getCandles: ReturnType<typeof vi.fn>;
}

function harness(o: {
  candles?: CandleSeries["candles"];
  price?: number;
  quoteView?: DataView<Quote>;
  candleView?: DataView<CandleSeries>;
  store?: MemStore;
  allowMock?: boolean;
  now?: Date;
} = {}): Harness {
  const store = o.store ?? new MemStore();
  const audits: Harness["audits"] = [];
  const getQuote = vi.fn(async () => o.quoteView ?? view(quote(o.price ?? 108)));
  const getCandles = vi.fn(async () => o.candleView ?? view(series(o.candles)));
  const deps: EvaluatorDeps = {
    marketData: { getQuote, getCandles } as unknown as EvaluatorDeps["marketData"],
    store,
    audit: async (e) => void audits.push(e),
    now: () => o.now ?? NOW,
    allowMockData: o.allowMock ?? false,
  };
  return { deps, store, audits, getQuote, getCandles };
}

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  // The evaluator must get all data through the injected facade, never fetch().
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("fetch must not be called"));
});
afterEach(() => vi.restoreAllMocks());

describe("correct outcomes", () => {
  it("BULLISH correct: target reached first -> WIN / CORRECT", async () => {
    const h = harness({ candles: flatHourly({ [at("10")]: { high: 111 } }) });
    const out = await evaluatePrediction(BULLISH, h.deps);
    expect(out).toMatchObject({ kind: "EVALUATED", status: "WIN", label: "CORRECT" });
    expect(h.store.inserts).toHaveLength(1);
    expect(h.store.inserts[0]).toMatchObject({ prediction_id: BULLISH.id, status: "WIN", exit_price: 108 });
    expect(h.store.inserts[0]!.evaluation_meta.touch).toEqual({ kind: "TARGET", level: 110, barOpenTime: at("10"), ambiguousWithinBar: false });
  });
  it("BEARISH correct: target reached first -> WIN / CORRECT", async () => {
    const h = harness({ candles: flatHourly({ [at("10")]: { low: 89 } }), price: 92 });
    const out = await evaluatePrediction(BEARISH, h.deps);
    expect(out).toMatchObject({ kind: "EVALUATED", status: "WIN", label: "CORRECT" });
  });
  it("neither level reached -> EXPIRED / NO_CLEAR_RESULT (not correct, not incorrect)", async () => {
    const h = harness();
    const out = await evaluatePrediction(BULLISH, h.deps);
    expect(out).toMatchObject({ kind: "EVALUATED", status: "EXPIRED", label: "NO_CLEAR_RESULT" });
    expect(h.store.inserts[0]!.evaluation_meta.touch).toBeNull();
  });
});

describe("incorrect outcomes", () => {
  it("BULLISH incorrect: invalidation reached first -> INVALIDATED / INCORRECT", async () => {
    const h = harness({ candles: flatHourly({ [at("10")]: { low: 94 } }), price: 96 });
    expect(await evaluatePrediction(BULLISH, h.deps)).toMatchObject({ kind: "EVALUATED", status: "INVALIDATED", label: "INCORRECT" });
  });
  it("BEARISH incorrect: invalidation reached first -> INVALIDATED / INCORRECT", async () => {
    const h = harness({ candles: flatHourly({ [at("10")]: { high: 106 } }), price: 104 });
    expect(await evaluatePrediction(BEARISH, h.deps)).toMatchObject({ kind: "EVALUATED", status: "INVALIDATED", label: "INCORRECT" });
  });
  it("a target reached AFTER invalidation is still INVALIDATED", async () => {
    const h = harness({ candles: flatHourly({ [at("08")]: { low: 90 }, [at("12")]: { high: 111 } }) });
    expect(await evaluatePrediction(BULLISH, h.deps)).toMatchObject({ status: "INVALIDATED" });
  });
  it("records an ambiguous same-candle touch as INVALIDATED and says so", async () => {
    const h = harness({ candles: flatHourly({ [at("10")]: { high: 111, low: 94 } }) });
    expect(await evaluatePrediction(BULLISH, h.deps)).toMatchObject({ status: "INVALIDATED" });
    expect(h.store.inserts[0]!.evaluation_meta.touch).toMatchObject({ ambiguousWithinBar: true });
  });
});

describe("data failures never become CORRECT or INCORRECT", () => {
  const expectUnavailable = async (h: Harness, reason: string) => {
    const out = await evaluatePrediction(BULLISH, h.deps);
    expect(out).toMatchObject({ kind: "UNAVAILABLE", label: "UNAVAILABLE", reason });
    expect(h.store.inserts).toHaveLength(0);
    expect(h.store.results.size).toBe(0);
    // The attempt is audited (and starts the discovery cooldown); it is not audited as an evaluation.
    expect(h.audits.map((a) => a.action)).toEqual(["prediction.evaluation_deferred"]);
    expect(h.audits[0]).toMatchObject({ entityType: "prediction", entityId: BULLISH.id, metadata: { reason } });
  };

  it("unavailable quote", async () => expectUnavailable(harness({ quoteView: failed() }), "QUOTE_UNAVAILABLE"));
  it("provider timeout on the quote", async () => expectUnavailable(harness({ quoteView: failed("TIMEOUT") }), "QUOTE_UNAVAILABLE"));
  it("provider error on the candles", async () => expectUnavailable(harness({ candleView: failed() }), "CANDLES_UNAVAILABLE"));
  it("provider timeout on the candles", async () => expectUnavailable(harness({ candleView: failed("TIMEOUT") }), "CANDLES_UNAVAILABLE"));
  it("stale quote (facade says STALE)", async () => expectUnavailable(harness({ quoteView: view(quote(108), "STALE") }), "QUOTE_STALE"));
  it("stale quote (FRESH flag but older than the allowed age)", async () => {
    const old = quote(108, { asOf: iso(NOW.getTime() - 5 * 60_000) });
    await expectUnavailable(harness({ quoteView: view(old) }), "QUOTE_STALE");
  });
  it("quote served from the store rather than live", async () => {
    await expectUnavailable(harness({ quoteView: view(quote(108), "STALE", "STORE") }), "QUOTE_NOT_LIVE");
  });
  it("live quote observed before the horizon ended", async () => {
    // Evaluation at 00:00:40, quote as of 00:00:10 (< expires 00:00:30): not an end-of-horizon price.
    const now = new Date("2026-09-29T00:00:40.000Z");
    const early = quote(108, { asOf: "2026-09-29T00:00:10.000Z" });
    await expectUnavailable(harness({ now, quoteView: view(early) }), "QUOTE_BEFORE_HORIZON");
  });
  it("quote stamped in the future", async () => {
    const future = quote(108, { asOf: iso(NOW.getTime() + 10 * 60_000) });
    await expectUnavailable(harness({ quoteView: view(future) }), "DATA_INCONSISTENT");
  });
  it.each([0, -5, Number.NaN])("non-positive/NaN quote price %s", async (price) => {
    await expectUnavailable(harness({ quoteView: view(quote(price)) }), "DATA_INCONSISTENT");
  });
  it("stale candles", async () => expectUnavailable(harness({ candleView: view(series(), "STALE") }), "CANDLES_STALE"));
  it("candle history that does not reach the horizon", async () => {
    await expectUnavailable(harness({ candles: flatHourly({}, { endOpen: at("20") }) }), "CANDLES_INCOMPLETE");
  });
  it("candle history with a hole in a continuous market", async () => {
    await expectUnavailable(harness({ candles: flatHourly({}, { skip: [at("10")] }) }), "CANDLES_INCOMPLETE");
  });
  it("candles for the wrong timeframe", async () => {
    await expectUnavailable(harness({ candleView: view(series(flatHourly(), { timeframe: "4h" })) }), "DATA_INCONSISTENT");
  });
  it("inactive / missing asset", async () => {
    await expectUnavailable(harness({ store: new MemStore([BULLISH], null) }), "ASSET_UNAVAILABLE");
  });
  it("mock quote outside development", async () => {
    await expectUnavailable(harness({ quoteView: view(quote(108, { isMock: true })) }), "MOCK_DATA_NOT_ALLOWED");
  });
  it("mock candles outside development", async () => {
    await expectUnavailable(harness({ candleView: view(series(flatHourly(), { isMock: true })) }), "MOCK_DATA_NOT_ALLOWED");
  });
  it("mock data IS accepted in development, and recorded as mock", async () => {
    const h = harness({ allowMock: true, quoteView: view(quote(108, { isMock: true })), candleView: view(series(flatHourly(), { isMock: true })) });
    expect(await evaluatePrediction({ ...BULLISH, entryQuoteIsMock: true }, h.deps)).toMatchObject({ kind: "EVALUATED" });
    expect(h.store.inserts[0]!.evaluation_meta.quote.isMock).toBe(true);
    expect(h.store.inserts[0]!.evaluation_meta.candles.isMock).toBe(true);
  });
  it("a deferred prediction can be evaluated on a later run once data is back", async () => {
    const store = new MemStore();
    expect(await evaluatePrediction(BULLISH, harness({ store, quoteView: failed() }).deps)).toMatchObject({ kind: "UNAVAILABLE" });
    expect(await evaluatePrediction(BULLISH, harness({ store }).deps)).toMatchObject({ kind: "EVALUATED" });
    expect(store.results.size).toBe(1);
  });
});

describe("a closed market (LAST_CLOSE) is a real observed price", () => {
  const NSE_PRED: EvaluablePrediction = { ...BULLISH, assetId: NSE_ASSET.id };
  it("evaluates with a LAST_CLOSE quote, records the freshness, and tolerates session gaps", async () => {
    const old = quote(108, { asOf: "2026-09-28T10:00:00.000Z", market: "NSE", symbol: "NIFTY 50", currency: "INR" });
    const h = harness({
      store: new MemStore([NSE_PRED], NSE_ASSET),
      quoteView: view(old, "LAST_CLOSE"),
      candleView: view(series(flatHourly({}, { skip: [at("10"), at("11")] }), { market: "NSE" }), "LAST_CLOSE"),
    });
    expect(await evaluatePrediction(NSE_PRED, h.deps)).toMatchObject({ kind: "EVALUATED", status: "EXPIRED" });
    expect(h.store.inserts[0]!.evaluation_meta.quote).toMatchObject({ freshness: "LAST_CLOSE", asOf: "2026-09-28T10:00:00.000Z" });
  });
});

describe("server-generated evaluation price and provenance", () => {
  it("the evaluation price is the server quote, with source / asOf / fetchedAt recorded", async () => {
    const h = harness({ price: 108.25 });
    await evaluatePrediction(BULLISH, h.deps);
    expect(h.getQuote).toHaveBeenCalledTimes(1);
    const row = h.store.inserts[0]!;
    expect(row.exit_price).toBe(108.25);
    expect(row.evaluation_meta.quote).toEqual({
      price: 108.25,
      source: "binance-public",
      asOf: iso(NOW.getTime() - 60_000),
      fetchedAt: iso(NOW.getTime() - 59_000),
      isMock: false,
      freshness: "FRESH",
      servedFrom: "PROVIDER",
    });
    expect(row.evaluation_meta.candles).toMatchObject({ source: "binance-public", timeframe: "1h", barsEvaluated: 23, servedFrom: "PROVIDER" });
    expect(row.evaluation_meta).toMatchObject({ evaluatorVersion: EVALUATOR_VERSION, rule: "TOUCH_WITHIN_HORIZON_V1" });
  });
  it("evaluates the ORIGINAL immutable terms and records them (with the prediction hash)", async () => {
    const h = harness();
    await evaluatePrediction(BULLISH, h.deps);
    expect(h.store.inserts[0]!.evaluation_meta.prediction).toEqual({
      direction: "BULLISH", timeframe: "1h", entryReferencePrice: 100, targetPrice: 110, invalidationPrice: 95,
      horizonHours: 24, createdAt: CREATED, expiresAt: EXPIRES, contentHash: "a".repeat(64),
    });
  });
  it("sends the database exactly the fields the evaluator owns: no timestamps, no hash, no id", async () => {
    const h = harness();
    await evaluatePrediction(BULLISH, h.deps);
    expect(Object.keys(h.store.inserts[0]!).sort()).toEqual(["evaluation_meta", "exit_price", "prediction_id", "return_pct", "status"]);
  });
  it("the evaluation timestamp is the database's (closed_at), not the app clock's", async () => {
    const out = await evaluatePrediction(BULLISH, harness().deps);
    if (out.kind !== "EVALUATED") throw new Error("expected EVALUATED");
    expect(out.result.closedAt).toBe(DB_CLOSED_AT);
    expect(out.result.closedAt).not.toBe(NOW.toISOString());
  });
  it("audits an evaluation without any user actor (system action)", async () => {
    const h = harness();
    await evaluatePrediction(BULLISH, h.deps);
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({
      actorId: null,
      action: "prediction.evaluated",
      entityId: BULLISH.id,
      metadata: { status: "EXPIRED", label: "NO_CLEAR_RESULT", resultHash: "b".repeat(64) },
    });
  });
  it("requests enough candle history to cover a late evaluation, within bounds", async () => {
    const late = new Date("2026-09-29T20:00:00.000Z");
    const h = harness({ now: late, quoteView: view(quote(108, { asOf: iso(late.getTime() - 60_000) })) });
    await evaluatePrediction(BULLISH, h.deps).catch(() => undefined);
    expect(h.getCandles).toHaveBeenCalledTimes(1);
    const limit = h.getCandles.mock.calls[0]![2] as number;
    expect(limit).toBeGreaterThanOrEqual(44); // ~44h since creation
    expect(limit).toBeLessThanOrEqual(1000);
  });
  it("never calls fetch()", async () => {
    await evaluatePrediction(BULLISH, harness().deps);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("idempotency", () => {
  it("an existing result is returned; no market calls, no insert, no audit", async () => {
    const store = new MemStore();
    const first = await evaluatePrediction(BULLISH, harness({ store }).deps);
    if (first.kind !== "EVALUATED") throw new Error("expected EVALUATED");

    const h = harness({ store, price: 500 });
    const again = await evaluatePrediction(BULLISH, h.deps);
    expect(again).toMatchObject({ kind: "ALREADY_EVALUATED", status: first.status, result: first.result });
    expect(h.getQuote).not.toHaveBeenCalled();
    expect(h.getCandles).not.toHaveBeenCalled();
    expect(h.audits).toHaveLength(0);
    expect(store.inserts).toHaveLength(1);
  });
  it("never overwrites: a different market view on the second run cannot change the stored result", async () => {
    const store = new MemStore();
    await evaluatePrediction(BULLISH, harness({ store, candles: flatHourly({ [at("10")]: { high: 111 } }) }).deps);
    const second = await evaluatePrediction(BULLISH, harness({ store, candles: flatHourly({ [at("10")]: { low: 90 } }) }).deps);
    expect(second).toMatchObject({ kind: "ALREADY_EVALUATED", status: "WIN" });
    expect(store.results.get(BULLISH.id)!.status).toBe("WIN");
  });
  it("concurrent runs: exactly one result is stored, the loser reports ALREADY_EVALUATED", async () => {
    const store = new MemStore();
    const a = harness({ store });
    const b = harness({ store });
    const [x, y] = await Promise.all([evaluatePrediction(BULLISH, a.deps), evaluatePrediction(BULLISH, b.deps)]);
    expect([x.kind, y.kind].sort()).toEqual(["ALREADY_EVALUATED", "EVALUATED"]);
    expect(store.results.size).toBe(1);
    expect(store.inserts).toHaveLength(1);
    // Only the winner audits an evaluation.
    expect([...a.audits, ...b.audits].filter((e) => e.action === "prediction.evaluated")).toHaveLength(1);
  });
  it("a duplicate insert whose winner cannot be read back is an error, not a silent success", async () => {
    const store = new MemStore();
    store.insertError = new DuplicateResultError(BULLISH.id);
    await expect(evaluatePrediction(BULLISH, harness({ store }).deps)).rejects.toBeInstanceOf(AppError);
  });
  it("any other insert failure surfaces as INTERNAL and audits nothing", async () => {
    const store = new MemStore();
    store.insertError = new Error("connection reset");
    const h = harness({ store });
    const err = await evaluatePrediction(BULLISH, h.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("INTERNAL");
    expect(h.audits).toHaveLength(0);
  });
});

describe("lifecycle and eligibility", () => {
  const untouched = (h: Harness) => {
    expect(h.getQuote).not.toHaveBeenCalled();
    expect(h.getCandles).not.toHaveBeenCalled();
    expect(h.store.inserts).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  };
  it("an ACTIVE prediction (horizon not reached) is left untouched", async () => {
    const h = harness({ now: new Date("2026-09-28T12:00:00.000Z") });
    expect(await evaluatePrediction(BULLISH, h.deps)).toMatchObject({ kind: "SKIPPED", reason: "NOT_EXPIRED" });
    untouched(h);
  });
  it("is not eligible at the last millisecond before expiry, and is at expiry", async () => {
    const before = harness({ now: new Date(Date.parse(EXPIRES) - 1) });
    expect(await evaluatePrediction(BULLISH, before.deps)).toMatchObject({ reason: "NOT_EXPIRED" });
    const exactly = harness({ now: new Date(Date.parse(EXPIRES)), quoteView: view(quote(108, { asOf: EXPIRES })) });
    expect(await evaluatePrediction(BULLISH, exactly.deps)).toMatchObject({ kind: "EVALUATED" });
  });
  it.each<[string, Partial<EvaluablePrediction>]>([
    ["a manual prediction (no engine version)", { engineVersion: null }],
    ["no server-observed entry price", { entryReferencePrice: null }],
    ["a zero entry price", { entryReferencePrice: 0 }],
    ["a missing timeframe", { timeframe: null }],
    ["an unsupported timeframe", { timeframe: "1m" }],
    ["a NEUTRAL direction (not storable, defended anyway)", { direction: "NEUTRAL" as unknown as "BULLISH" }],
    ["non-positive levels", { invalidationPrice: 0 }],
    ["an entry price taken from mock data", { entryQuoteIsMock: true }],
    ["garbage timestamps", { createdAt: "not a date" }],
  ])("skips %s", async (_label, over) => {
    const h = harness();
    expect(await evaluatePrediction({ ...BULLISH, ...over }, h.deps)).toMatchObject({ kind: "SKIPPED", reason: "NOT_ELIGIBLE" });
    untouched(h);
  });
});

describe("evaluateDuePredictions (one scheduler tick)", () => {
  const second: EvaluablePrediction = { ...BEARISH };

  it("evaluates every due prediction and summarises", async () => {
    const store = new MemStore([BULLISH, second]);
    const h = harness({ store });
    const s = await evaluateDuePredictions({}, h.deps);
    expect(s).toMatchObject({ scanned: 2, evaluated: 2, alreadyEvaluated: 0, unavailable: 0, skipped: 0, failed: 0 });
    expect(s.outcomes.map((o) => o.kind)).toEqual(["EVALUATED", "EVALUATED"]);
    expect(store.results.size).toBe(2);
  });
  it("is repeatable: a second run finds nothing due and writes nothing", async () => {
    const store = new MemStore([BULLISH, second]);
    await evaluateDuePredictions({}, harness({ store }).deps);
    const again = await evaluateDuePredictions({}, harness({ store }).deps);
    expect(again).toMatchObject({ scanned: 0, evaluated: 0 });
    expect(store.inserts).toHaveLength(2);
  });
  it("already-evaluated predictions that slip into the batch are skipped safely", async () => {
    const store = new MemStore([BULLISH]);
    await evaluatePrediction(BULLISH, harness({ store }).deps);
    const raced: EvaluatorStore = { ...store, listDue: async () => [BULLISH], getResult: (id) => store.getResult(id), getAssetById: () => store.getAssetById(), getPrediction: (id) => store.getPrediction(id), insertResult: (r) => store.insertResult(r) };
    const h = harness({ store });
    h.deps.store = raced;
    const s = await evaluateDuePredictions({}, h.deps);
    expect(s).toMatchObject({ scanned: 1, alreadyEvaluated: 1, evaluated: 0 });
    expect(store.inserts).toHaveLength(1);
  });
  it("counts unavailable data as unavailable and keeps going", async () => {
    const store = new MemStore([BULLISH, second]);
    const h = harness({ store });
    let call = 0;
    h.getQuote.mockImplementation(async () => (call++ === 0 ? failed() : view(quote(92))));
    const s = await evaluateDuePredictions({}, h.deps);
    expect(s).toMatchObject({ scanned: 2, evaluated: 1, unavailable: 1, failed: 0 });
    expect(s.outcomes[0]).toMatchObject({ kind: "UNAVAILABLE", label: "UNAVAILABLE", reason: "QUOTE_UNAVAILABLE" });
  });
  it("one prediction throwing does not stop the rest", async () => {
    const store = new MemStore([BULLISH, second]);
    const h = harness({ store });
    let call = 0;
    h.getQuote.mockImplementation(async () => {
      if (call++ === 0) throw new Error("boom");
      return view(quote(92));
    });
    const s = await evaluateDuePredictions({}, h.deps);
    expect(s).toMatchObject({ scanned: 2, evaluated: 1, failed: 1 });
    expect(s.outcomes[0]).toEqual({ predictionId: BULLISH.id, kind: "ERROR" });
  });
  it("defaults to 25 and passes the validated limit to discovery", async () => {
    const store = new MemStore([]);
    const listDue = vi.spyOn(store, "listDue");
    await evaluateDuePredictions(undefined, harness({ store }).deps);
    await evaluateDuePredictions({ limit: "7" }, harness({ store }).deps);
    expect(listDue.mock.calls.map((c) => c[0])).toEqual([25, 7]);
  });
});

describe("run input is validated and cannot name a prediction, a price or a time", () => {
  it.each<[string, unknown]>([
    ["limit 0", { limit: 0 }],
    ["limit above the cap", { limit: 101 }],
    ["fractional limit", { limit: 1.5 }],
    ["non-numeric limit", { limit: "many" }],
    ["empty limit", { limit: "" }],
    ["a prediction id", { predictionId: "9d8c7b6a-1111-4222-8333-444455556666" }],
    ["an id alias", { id: "9d8c7b6a-1111-4222-8333-444455556666" }],
    ["an evaluation price", { price: 1 }],
    ["an exit price", { exitPrice: 1 }],
    ["a timestamp", { evaluatedAt: "2020-01-01T00:00:00Z" }],
    ["a result", { status: "WIN" }],
  ])("rejects %s", async (_label, input) => {
    const store = new MemStore();
    const listDue = vi.spyOn(store, "listDue");
    const err = await evaluateDuePredictions(input, harness({ store }).deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("VALIDATION");
    expect(listDue).not.toHaveBeenCalled();
    expect(store.inserts).toHaveLength(0);
  });
});
