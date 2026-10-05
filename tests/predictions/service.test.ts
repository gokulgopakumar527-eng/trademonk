import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import type { DataView } from "@/services/market-data/market-data-service";
import type { Asset } from "@/services/market-data/types";
import {
  createEnginePrediction,
  MAX_ENTRY_QUOTE_AGE_MS,
  type PredictionDeps,
} from "@/services/predictions/prediction-service";
import { PredictionRejectedError, type PredictionRejectionReason } from "@/services/predictions/errors";
import type { InsertedPredictionRow, NewPredictionRow } from "@/services/predictions/types";
import type { CandleSeries, Quote } from "@/types/market";
import { quoteAt } from "../market/helpers";
import { build, downCloses, flatCloses, T0, upCloses } from "./helpers";

const ASSET_ID = "3f0c6a52-6f0e-4e63-9c53-2f5a1c1d9b10";
const USER_ID = "c2b7f0a4-1d2e-4c8a-9f11-0a7b5d6e8f90";
const ASSET: Asset = { id: ASSET_ID, market: "CRYPTO", symbol: "BTC", currency: "USDT", kind: "CRYPTO", name: "Bitcoin" };
const NOW = new Date(T0);
const iso = (ms: number) => new Date(ms).toISOString();

const DB_ROW: InsertedPredictionRow = {
  id: "9d8c7b6a-1111-4222-8333-444455556666",
  created_at: "2026-09-29T00:00:00.123456+00:00",
  expires_at: "2026-09-30T00:00:00.123456+00:00",
  content_hash: "a".repeat(64),
  hash_version: 2,
};

type Fresh = "FRESH" | "STALE" | "LAST_CLOSE";
const view = <T,>(data: T, status: Fresh = "FRESH", servedFrom: "PROVIDER" | "STORE" = "PROVIDER"): DataView<T> => ({
  ok: true,
  data,
  freshness: { status, ageMs: 0, label: "" },
  servedFrom,
});
const failed = <T,>(): DataView<T> => ({
  ok: false,
  error: { code: "UPSTREAM_ERROR", message: "down", provider: "fake", retryable: true },
  message: "Data temporarily unavailable",
});

function series(closes: number[], over: Partial<CandleSeries> = {}): CandleSeries {
  return {
    source: "test", asOf: iso(T0 - 5_000), fetchedAt: iso(T0 - 5_000), isMock: false,
    market: "CRYPTO", symbol: "BTC", currency: "USDT", timeframe: "1h", candles: build(closes), ...over,
  };
}
const quote = (price: number, over: Partial<Quote> = {}): Quote =>
  quoteAt(iso(T0 - 5_000), { price, source: "binance-public", fetchedAt: iso(T0 - 4_000), ...over });

interface Harness {
  deps: PredictionDeps;
  inserted: NewPredictionRow[];
  audits: Array<Parameters<PredictionDeps["audit"]>[0]>;
  getQuote: ReturnType<typeof vi.fn>;
  getCandles: ReturnType<typeof vi.fn>;
}

function harness(o: {
  closes?: number[];
  price?: number;
  quoteView?: DataView<Quote>;
  candleView?: DataView<CandleSeries>;
  asset?: Asset | null;
  allowMock?: boolean;
  insertError?: Error;
} = {}): Harness {
  const closes = o.closes ?? upCloses();
  const inserted: NewPredictionRow[] = [];
  const audits: Harness["audits"] = [];
  const getQuote = vi.fn(async () => o.quoteView ?? view(quote(o.price ?? closes.at(-1)!)));
  const getCandles = vi.fn(async () => o.candleView ?? view(series(closes)));
  const deps: PredictionDeps = {
    marketData: { getQuote, getCandles } as unknown as PredictionDeps["marketData"],
    store: {
      getAssetById: async () => (o.asset === undefined ? ASSET : o.asset),
      insert: async (row) => {
        if (o.insertError) throw o.insertError;
        inserted.push(row);
        return DB_ROW;
      },
    },
    audit: async (e) => void audits.push(e),
    now: () => NOW,
    allowMockData: o.allowMock ?? false,
  };
  return { deps, inserted, audits, getQuote, getCandles };
}

const INPUT = { assetId: ASSET_ID, timeframe: "1h" };
const expectRejected = async (p: Promise<unknown>, reason: PredictionRejectionReason) => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PredictionRejectedError);
  expect((err as PredictionRejectedError).reason).toBe(reason);
};

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  // The engine and service must get all data through the injected facade, never fetch().
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("fetch must not be called"));
});
afterEach(() => vi.restoreAllMocks());

describe("server-generated entry price", () => {
  it("uses the server quote as entry_reference_price and records its provenance", async () => {
    const h = harness({ price: 212.5 });
    const p = await createEnginePrediction(USER_ID, INPUT, h.deps);
    expect(h.getQuote).toHaveBeenCalledTimes(1);
    expect(h.inserted).toHaveLength(1);
    const row = h.inserted[0]!;
    expect(row.entry_reference_price).toBe(212.5);
    expect(row).toMatchObject({
      entry_quote_source: "binance-public",
      entry_quote_as_of: iso(T0 - 5_000),
      entry_quote_fetched_at: iso(T0 - 4_000),
      entry_quote_is_mock: false,
      user_id: USER_ID,
      origin: "USER",
      engine_version: expect.stringMatching(/^rules-/),
      signal_total: 5,
    });
    expect(p.entryReferencePrice).toBe(212.5);
    expect(p.entryQuote).toEqual({ source: "binance-public", asOf: iso(T0 - 5_000), fetchedAt: iso(T0 - 4_000), isMock: false });
  });

  it.each([
    ["entryPrice", 1],
    ["entry_reference_price", 1],
    ["price", 1],
    ["targetPrice", 999],
    ["invalidationPrice", 1],
    ["createdAt", "2020-01-01T00:00:00Z"],
    ["expiresAt", "2099-01-01T00:00:00Z"],
    ["userId", "00000000-0000-4000-8000-000000000000"],
    ["result", "WIN"],
    ["contentHash", "x"],
    ["direction", "BULLISH"],
  ])("rejects a client-supplied %s and touches nothing", async (key, value) => {
    const h = harness();
    await expect(createEnginePrediction(USER_ID, { ...INPUT, [key]: value }, h.deps)).rejects.toMatchObject({ code: "VALIDATION" });
    expect(h.getQuote).not.toHaveBeenCalled();
    expect(h.inserted).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  });

  it("never calls fetch()", async () => {
    await createEnginePrediction(USER_ID, INPUT, harness().deps);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("timestamp integrity", () => {
  it("never sends created_at, expires_at, content_hash or hash_version to the database", async () => {
    const h = harness();
    await createEnginePrediction(USER_ID, INPUT, h.deps);
    const keys = Object.keys(h.inserted[0]!);
    for (const k of ["created_at", "expires_at", "content_hash", "hash_version", "id"]) expect(keys).not.toContain(k);
  });
  it("returns the database's timestamps and hash, not the engine's preview", async () => {
    const p = await createEnginePrediction(USER_ID, INPUT, harness().deps);
    expect(p.createdAt).toBe(DB_ROW.created_at);
    expect(p.expiresAt).toBe(DB_ROW.expires_at);
    expect(p.contentHash).toBe(DB_ROW.content_hash);
    expect(p.hashVersion).toBe(2);
    expect(p.id).toBe(DB_ROW.id);
    expect(p.createdAt).not.toBe(NOW.toISOString());
  });
  it("reports lifecycle CREATED at creation", async () => {
    expect((await createEnginePrediction(USER_ID, INPUT, harness().deps)).lifecycle).toBe("CREATED");
  });
});

describe("persisted content", () => {
  it("stores levels, horizon, timeframe, rationale and a frozen engine snapshot", async () => {
    const h = harness();
    const p = await createEnginePrediction(USER_ID, INPUT, h.deps);
    const row = h.inserted[0]!;
    expect(row.direction).toBe("BULLISH");
    expect(row.invalidation_price).toBeLessThan(row.entry_reference_price);
    expect(row.target_price).toBeGreaterThan(row.entry_reference_price);
    expect(row.timeframe).toBe("1h");
    expect(row.horizon_hours).toBe(24);
    expect(row.signal_agreement).toBeGreaterThanOrEqual(4);
    expect(row.rationale).toBe(p.reasoning.join("\n"));
    expect(row.engine_snapshot.signalsUsed.length).toBeGreaterThan(10);
    expect(row.engine_snapshot.agreementNote).toMatch(/not a forecast/);
    expect(p.signalAgreement.total).toBe(5);
  });
  it("creates a bearish prediction from bearish conditions", async () => {
    const h = harness({ closes: downCloses() });
    const p = await createEnginePrediction(USER_ID, INPUT, h.deps);
    expect(p.direction).toBe("BEARISH");
    expect(h.inserted[0]!.target_price).toBeLessThan(h.inserted[0]!.invalidation_price);
  });
  it("is deterministic: same market state gives the same stored content", async () => {
    const a = harness();
    const b = harness();
    await createEnginePrediction(USER_ID, INPUT, a.deps);
    await createEnginePrediction(USER_ID, INPUT, b.deps);
    expect(JSON.stringify(a.inserted[0])).toBe(JSON.stringify(b.inserted[0]));
  });
  it("writes an audit entry for the creation, without the full snapshot", async () => {
    const h = harness();
    await createEnginePrediction(USER_ID, INPUT, h.deps);
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({
      actorId: USER_ID,
      action: "prediction.created",
      entityType: "prediction",
      entityId: DB_ROW.id,
      metadata: { assetId: ASSET_ID, direction: "BULLISH", contentHash: DB_ROW.content_hash },
    });
    expect(JSON.stringify(h.audits[0])).not.toContain("signalsUsed");
  });
});

describe("invalid inputs", () => {
  it.each([
    ["missing asset", { timeframe: "1h" }],
    ["missing timeframe", { assetId: ASSET_ID }],
    ["seed catalogue id", { assetId: "seed:btc", timeframe: "1h" }],
    ["non-uuid id", { assetId: "btc", timeframe: "1h" }],
    ["unsupported timeframe 1w", { assetId: ASSET_ID, timeframe: "1w" }],
    ["unsupported timeframe 1m", { assetId: ASSET_ID, timeframe: "1m" }],
    ["unknown timeframe", { assetId: ASSET_ID, timeframe: "2h" }],
    ["numeric timeframe", { assetId: ASSET_ID, timeframe: 60 }],
    ["null", null],
    ["string", "BTC"],
    ["array", []],
    ["undefined", undefined],
  ])("rejects %s with a validation error and no side effects", async (_n, input) => {
    const h = harness();
    const err = await createEnginePrediction(USER_ID, input, h.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("VALIDATION");
    expect(h.getQuote).not.toHaveBeenCalled();
    expect(h.inserted).toHaveLength(0);
  });
  it("rejects an unknown asset", async () => {
    const h = harness({ asset: null });
    await expectRejected(createEnginePrediction(USER_ID, INPUT, h.deps), "ASSET_NOT_FOUND");
    expect(h.getQuote).not.toHaveBeenCalled();
  });
});

describe("unavailable and stale market data", () => {
  const nothingSaved = (h: Harness) => {
    expect(h.inserted).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  };
  it("rejects when the quote is unavailable", async () => {
    const h = harness({ quoteView: failed<Quote>() });
    await expectRejected(createEnginePrediction(USER_ID, INPUT, h.deps), "QUOTE_UNAVAILABLE");
    nothingSaved(h);
  });
  it("rejects a quote the facade flags STALE", async () => {
    const h = harness({ quoteView: view(quote(212), "STALE") });
    await expectRejected(createEnginePrediction(USER_ID, INPUT, h.deps), "QUOTE_STALE");
    nothingSaved(h);
  });
  it("rejects an old quote even if the facade still calls it FRESH", async () => {
    const old = quote(212, { asOf: iso(T0 - MAX_ENTRY_QUOTE_AGE_MS - 1_000) });
    const h = harness({ quoteView: view(old, "FRESH") });
    await expectRejected(createEnginePrediction(USER_ID, INPUT, h.deps), "QUOTE_STALE");
    nothingSaved(h);
  });
  it("accepts a quote exactly at the age limit", async () => {
    const edge = quote(212, { asOf: iso(T0 - MAX_ENTRY_QUOTE_AGE_MS) });
    const h = harness({ quoteView: view(edge) });
    await expect(createEnginePrediction(USER_ID, INPUT, h.deps)).resolves.toMatchObject({ direction: "BULLISH" });
  });
  it("rejects a quote with an unparseable timestamp", async () => {
    const h = harness({ quoteView: view(quote(212, { asOf: "not-a-date" })) });
    await expectRejected(createEnginePrediction(USER_ID, INPUT, h.deps), "QUOTE_STALE");
  });
  it("rejects a quote stamped in the future", async () => {
    const h = harness({ quoteView: view(quote(212, { asOf: iso(T0 + 10 * 60_000) })) });
    await expectRejected(createEnginePrediction(USER_ID, INPUT, h.deps), "DATA_INCONSISTENT");
  });
  it("rejects a quote served from the store after a live failure", async () => {
    const h = harness({ quoteView: view(quote(212), "FRESH", "STORE") });
    await expectRejected(createEnginePrediction(USER_ID, INPUT, h.deps), "QUOTE_NOT_LIVE");
    nothingSaved(h);
  });
  it("rejects a last-close quote from a closed market", async () => {
    const h = harness({ quoteView: view(quote(212), "LAST_CLOSE") });
    await expectRejected(createEnginePrediction(USER_ID, INPUT, h.deps), "MARKET_CLOSED");
    nothingSaved(h);
  });
  it("rejects mock quotes unless mock data is explicitly allowed (development)", async () => {
    const mock = quote(212, { isMock: true, source: "mock" });
    await expectRejected(createEnginePrediction(USER_ID, INPUT, harness({ quoteView: view(mock) }).deps), "MOCK_DATA_NOT_ALLOWED");
    const dev = harness({ quoteView: view(mock), allowMock: true });
    await createEnginePrediction(USER_ID, INPUT, dev.deps);
    expect(dev.inserted[0]!.entry_quote_is_mock).toBe(true);
  });
  it("rejects mock candles in production", async () => {
    const h = harness({ candleView: view(series(upCloses(), { isMock: true })) });
    await expectRejected(createEnginePrediction(USER_ID, INPUT, h.deps), "MOCK_DATA_NOT_ALLOWED");
  });
  it("rejects when candles are unavailable", async () => {
    const h = harness({ candleView: failed<CandleSeries>() });
    await expectRejected(createEnginePrediction(USER_ID, INPUT, h.deps), "CANDLES_UNAVAILABLE");
    nothingSaved(h);
  });
  it("rejects stale candles", async () => {
    const h = harness({ candleView: view(series(upCloses()), "STALE") });
    await expectRejected(createEnginePrediction(USER_ID, INPUT, h.deps), "CANDLES_STALE");
    nothingSaved(h);
  });
  it("rejects insufficient history rather than guessing", async () => {
    const h = harness({ closes: upCloses().slice(0, 40) });
    await expectRejected(createEnginePrediction(USER_ID, INPUT, h.deps), "INSUFFICIENT_DATA");
    nothingSaved(h);
  });
  it("saves nothing when the engine reads NEUTRAL", async () => {
    const h = harness({ closes: flatCloses() });
    await expectRejected(createEnginePrediction(USER_ID, INPUT, h.deps), "NO_DIRECTIONAL_SIGNAL");
    nothingSaved(h);
  });
  it("saves nothing when quote and candles are inconsistent", async () => {
    const h = harness({ price: upCloses().at(-1)! * 2 });
    await expectRejected(createEnginePrediction(USER_ID, INPUT, h.deps), "DATA_INCONSISTENT");
    nothingSaved(h);
  });
  it("maps rejections to safe error codes and user-safe messages", async () => {
    const err = (await createEnginePrediction(USER_ID, INPUT, harness({ quoteView: failed<Quote>() }).deps).catch((e: unknown) => e)) as PredictionRejectedError;
    expect(err.code).toBe("PROVIDER_UNAVAILABLE");
    expect(err.message).not.toMatch(/binance|upstream|provider|fake/i);
  });
});

describe("persistence failures", () => {
  it("surfaces INTERNAL without an audit entry and without leaking the database error", async () => {
    const h = harness({ insertError: new Error('duplicate key value violates constraint "predictions_pkey"') });
    const err = (await createEnginePrediction(USER_ID, INPUT, h.deps).catch((e: unknown) => e)) as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("INTERNAL");
    expect(err.message).toBe("Could not save the prediction");
    expect(h.audits).toHaveLength(0);
  });
});
