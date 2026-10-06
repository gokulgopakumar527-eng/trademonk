import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import type { DataView } from "@/services/market-data/market-data-service";
import type { Asset } from "@/services/market-data/types";
import {
  isPredictionIdempotencyViolation,
  PREDICTION_IDEMPOTENCY_INDEX,
  PredictionIdempotencyConflictError,
  PredictionRejectedError,
} from "@/services/predictions/errors";
import { createEnginePrediction, type PredictionDeps, type PredictionStore } from "@/services/predictions/prediction-service";
import type { InsertedPredictionRow, NewPredictionRow, StoredPredictionRecord } from "@/services/predictions/types";
import type { CandleSeries, Quote } from "@/types/market";
import { quoteAt } from "../market/helpers";
import { build, downCloses, T0, upCloses } from "./helpers";

// Phase 5D-A3: prediction-create persistence and replay, against an in-memory store that enforces the
// same (user_id, idempotency_key) uniqueness as the A1 index.

const ASSET_A = "3f0c6a52-6f0e-4e63-9c53-2f5a1c1d9b10";
const ASSET_B = "7a1d2c3e-5b4f-4a6b-8c7d-9e0f1a2b3c4d";
const USER = "c2b7f0a4-1d2e-4c8a-9f11-0a7b5d6e8f90";
const OTHER_USER = "d3c8a1b5-2e3f-4d9b-a022-1b8c6e7f9a01";
const KEY = "tm-idem-key-0123456789";
const NOW = new Date(T0);
const iso = (ms: number) => new Date(ms).toISOString();
const asset = (id: string, symbol: string): Asset => ({ id, market: "CRYPTO", symbol, currency: "USDT", kind: "CRYPTO", name: symbol });
const ASSETS = new Map([[ASSET_A, asset(ASSET_A, "BTC")], [ASSET_B, asset(ASSET_B, "ETH")]]);

const view = <T,>(data: T): DataView<T> => ({ ok: true, data, freshness: { status: "FRESH", ageMs: 0, label: "" }, servedFrom: "PROVIDER" });
const series = (closes: number[]): CandleSeries => ({
  source: "test", asOf: iso(T0 - 5_000), fetchedAt: iso(T0 - 5_000), isMock: false,
  market: "CRYPTO", symbol: "BTC", currency: "USDT", timeframe: "1h", candles: build(closes),
});
const quote = (price: number): Quote => quoteAt(iso(T0 - 5_000), { price, source: "binance-public", fetchedAt: iso(T0 - 4_000) });

/** In-memory PredictionStore with the same uniqueness rule as the database index. */
class MemoryStore implements PredictionStore {
  rows: Array<NewPredictionRow & { id: string }> = [];
  insertCalls = 0;
  failNextInsertWith: Error | null = null;
  /** When set, every lookup waits until this many lookups have arrived, then all proceed together. */
  lookupBarrier: { size: number; arrived: number; release: () => void; gate: Promise<void> } | null = null;
  private seq = 0;

  async getAssetById(id: string) {
    return ASSETS.get(id) ?? null;
  }

  async insert(row: NewPredictionRow): Promise<InsertedPredictionRow> {
    this.insertCalls++;
    if (this.failNextInsertWith) {
      const e = this.failNextInsertWith;
      this.failNextInsertWith = null;
      throw e;
    }
    if (this.rows.some((r) => r.user_id === row.user_id && r.idempotency_key === row.idempotency_key)) {
      throw new PredictionIdempotencyConflictError();
    }
    const id = `00000000-0000-4000-8000-${String(++this.seq).padStart(12, "0")}`;
    this.rows.push({ ...row, id });
    return {
      id,
      created_at: `2026-09-29T00:00:0${this.seq}.000000+00:00`,
      expires_at: `2026-09-30T00:00:0${this.seq}.000000+00:00`,
      content_hash: String(this.seq).repeat(64).slice(0, 64),
      hash_version: 2,
    };
  }

  async findByIdempotencyKey(userId: string, key: string): Promise<StoredPredictionRecord | null> {
    const b = this.lookupBarrier;
    if (b) {
      b.arrived++;
      if (b.arrived >= b.size) b.release();
      await b.gate;
    }
    const i = this.rows.findIndex((r) => r.user_id === userId && r.idempotency_key === key);
    if (i < 0) return null;
    const r = this.rows[i]!;
    return {
      id: r.id,
      asset_id: r.asset_id,
      direction: r.direction,
      timeframe: r.timeframe,
      horizon_hours: r.horizon_hours,
      entry_reference_price: r.entry_reference_price,
      target_price: r.target_price,
      invalidation_price: r.invalidation_price,
      engine_version: r.engine_version,
      signal_agreement: r.signal_agreement,
      entry_quote_source: r.entry_quote_source,
      entry_quote_as_of: r.entry_quote_as_of,
      entry_quote_fetched_at: r.entry_quote_fetched_at,
      entry_quote_is_mock: r.entry_quote_is_mock,
      engine_snapshot: r.engine_snapshot,
      created_at: `2026-09-29T00:00:0${i + 1}.000000+00:00`,
      expires_at: `2026-09-30T00:00:0${i + 1}.000000+00:00`,
      content_hash: String(i + 1).repeat(64).slice(0, 64),
      hash_version: 2,
      evaluated: false,
    };
  }
}

function makeBarrier(size: number) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  return { size, arrived: 0, release, gate };
}

function setup(o: { closes?: number[]; store?: MemoryStore; quoteDown?: boolean } = {}) {
  const store = o.store ?? new MemoryStore();
  const closes = o.closes ?? upCloses();
  const audits: Array<Parameters<PredictionDeps["audit"]>[0]> = [];
  const getQuote = vi.fn(async () =>
    o.quoteDown
      ? ({ ok: false, error: { code: "UPSTREAM_ERROR", message: "down", provider: "fake", retryable: true }, message: "down" } as DataView<Quote>)
      : view(quote(closes.at(-1)!)),
  );
  const getCandles = vi.fn(async () => view(series(closes)));
  const deps: PredictionDeps = {
    marketData: { getQuote, getCandles } as unknown as PredictionDeps["marketData"],
    store,
    audit: async (e) => void audits.push(e),
    now: () => NOW,
    allowMockData: false,
  };
  return { deps, store, audits, getQuote, getCandles };
}

const input = (over: Record<string, unknown> = {}) => ({ assetId: ASSET_A, timeframe: "1h", idempotencyKey: KEY, ...over });
const reason = async (p: Promise<unknown>) => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(PredictionRejectedError);
  return (e as PredictionRejectedError).reason;
};

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("fetch must not be called"));
});
afterEach(() => vi.restoreAllMocks());

describe("first create", () => {
  it("creates exactly one prediction, replayed=false, and persists the idempotency key", async () => {
    const h = setup();
    const p = await createEnginePrediction(USER, input(), h.deps);
    expect(p.replayed).toBe(false);
    expect(h.store.rows).toHaveLength(1);
    expect(h.store.rows[0]!.idempotency_key).toBe(KEY);
    expect(h.store.rows[0]!.user_id).toBe(USER);
    expect(p.id).toBe(h.store.rows[0]!.id);
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({ action: "prediction.created", entityId: p.id });
  });
});

describe("same key, same intent: replay", () => {
  it("returns the original prediction with replayed=true and writes nothing", async () => {
    const h = setup();
    const first = await createEnginePrediction(USER, input(), h.deps);
    const second = await createEnginePrediction(USER, input(), h.deps);
    expect(second.replayed).toBe(true);
    expect(second.id).toBe(first.id);
    expect(h.store.rows).toHaveLength(1);
    expect(h.store.insertCalls).toBe(1);
    expect(h.audits).toHaveLength(1);
    // Everything except the replay flag and the derived lifecycle is the stored original, byte for byte.
    expect({ ...second, replayed: false, lifecycle: first.lifecycle }).toEqual(first);
  });

  it("returns the stored values even when the market has moved to the opposite direction", async () => {
    const store = new MemoryStore();
    const a = setup({ store, closes: upCloses() });
    const first = await createEnginePrediction(USER, input(), a.deps);
    expect(first.direction).toBe("BULLISH");
    const b = setup({ store, closes: downCloses() });
    const second = await createEnginePrediction(USER, input(), b.deps);
    expect(second.replayed).toBe(true);
    expect(second.direction).toBe("BULLISH");
    expect(second.entryReferencePrice).toBe(first.entryReferencePrice);
    expect(second.targetPrice).toBe(first.targetPrice);
    expect(second.invalidationPrice).toBe(first.invalidationPrice);
    expect(second.contentHash).toBe(first.contentHash);
    expect(second.createdAt).toBe(first.createdAt);
    expect(store.rows).toHaveLength(1);
    expect(b.audits).toHaveLength(0);
  });

  it("does not re-quote, recompute or call the market at all on replay", async () => {
    const store = new MemoryStore();
    await createEnginePrediction(USER, input(), setup({ store }).deps);
    const b = setup({ store });
    await createEnginePrediction(USER, input(), b.deps);
    expect(b.getQuote).not.toHaveBeenCalled();
    expect(b.getCandles).not.toHaveBeenCalled();
  });

  it("still replays when the market data is now unavailable", async () => {
    const store = new MemoryStore();
    const first = await createEnginePrediction(USER, input(), setup({ store }).deps);
    const down = setup({ store, quoteDown: true });
    const replay = await createEnginePrediction(USER, input(), down.deps);
    expect(replay).toMatchObject({ replayed: true, id: first.id });
  });

  it("scopes keys per user: another user with the same key creates their own prediction", async () => {
    const store = new MemoryStore();
    const mine = await createEnginePrediction(USER, input(), setup({ store }).deps);
    const theirs = await createEnginePrediction(OTHER_USER, input(), setup({ store }).deps);
    expect(theirs.replayed).toBe(false);
    expect(theirs.id).not.toBe(mine.id);
    expect(store.rows).toHaveLength(2);
  });

  it("a different key creates a new prediction", async () => {
    const h = setup();
    await createEnginePrediction(USER, input(), h.deps);
    const p = await createEnginePrediction(USER, input({ idempotencyKey: "tm-idem-key-other-0001" }), h.deps);
    expect(p.replayed).toBe(false);
    expect(h.store.rows).toHaveLength(2);
  });
});

describe("same key, different intent: IDEMPOTENCY_KEY_REUSED", () => {
  it("rejects a different asset", async () => {
    const h = setup();
    await createEnginePrediction(USER, input(), h.deps);
    expect(await reason(createEnginePrediction(USER, input({ assetId: ASSET_B }), h.deps))).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(h.store.rows).toHaveLength(1);
    expect(h.store.insertCalls).toBe(1);
  });

  it("rejects a different timeframe", async () => {
    const h = setup();
    await createEnginePrediction(USER, input(), h.deps);
    expect(await reason(createEnginePrediction(USER, input({ timeframe: "4h" }), h.deps))).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(h.store.rows).toHaveLength(1);
  });

  it("a conflict writes no audit event and does not touch the stored row", async () => {
    const h = setup();
    await createEnginePrediction(USER, input(), h.deps);
    const before = JSON.stringify(h.store.rows);
    await reason(createEnginePrediction(USER, input({ assetId: ASSET_B }), h.deps));
    expect(h.audits).toHaveLength(1);
    expect(JSON.stringify(h.store.rows)).toBe(before);
  });
});

describe("failed creation does not consume the key", () => {
  it("leaves no row, then the same key succeeds on retry", async () => {
    const h = setup();
    h.store.failNextInsertWith = new Error("connection reset");
    const err = (await createEnginePrediction(USER, input(), h.deps).catch((e: unknown) => e)) as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("INTERNAL");
    expect(err.message).toBe("Could not save the prediction");
    expect(h.store.rows).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
    const retry = await createEnginePrediction(USER, input(), h.deps);
    expect(retry.replayed).toBe(false);
    expect(h.store.rows).toHaveLength(1);
  });

  it("a rejected prediction (market data failure) leaves the key usable", async () => {
    const store = new MemoryStore();
    await expect(createEnginePrediction(USER, input(), setup({ store, quoteDown: true }).deps)).rejects.toBeInstanceOf(PredictionRejectedError);
    expect(store.rows).toHaveLength(0);
    const ok = await createEnginePrediction(USER, input(), setup({ store }).deps);
    expect(ok.replayed).toBe(false);
  });

  it("does not leak a non-idempotency database error", async () => {
    const h = setup();
    h.store.failNextInsertWith = Object.assign(new Error('duplicate key value violates unique constraint "predictions_pkey"'), { code: "23505" });
    const err = (await createEnginePrediction(USER, input(), h.deps).catch((e: unknown) => e)) as AppError;
    expect(err.code).toBe("INTERNAL");
    expect(err.message).not.toMatch(/predictions_pkey|duplicate/);
  });
});

describe("concurrent requests with the same user and key", () => {
  it("creates exactly one prediction; the other request replays it", async () => {
    const store = new MemoryStore();
    store.lookupBarrier = makeBarrier(2); // both pre-insert lookups see 'no row' before either inserts
    const a = setup({ store });
    const b = setup({ store });
    const [r1, r2] = await Promise.all([createEnginePrediction(USER, input(), a.deps), createEnginePrediction(USER, input(), b.deps)]);
    expect(store.rows).toHaveLength(1);
    expect(store.insertCalls).toBe(2); // both really raced to the insert; the index decided
    expect([r1.replayed, r2.replayed].sort()).toEqual([false, true]);
    expect(r1.id).toBe(r2.id);
    expect(r1.contentHash).toBe(r2.contentHash);
    expect(a.audits.length + b.audits.length).toBe(1);
  });

  it("three racers: one original, two replays, one row", async () => {
    const store = new MemoryStore();
    store.lookupBarrier = makeBarrier(3);
    const results = await Promise.all([1, 2, 3].map(() => createEnginePrediction(USER, input(), setup({ store }).deps)));
    expect(store.rows).toHaveLength(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(results.filter((r) => r.replayed)).toHaveLength(2);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
  });

  it("a racer whose winning row has a different intent gets IDEMPOTENCY_KEY_REUSED", async () => {
    const store = new MemoryStore();
    store.lookupBarrier = makeBarrier(2);
    const settled = await Promise.allSettled([
      createEnginePrediction(USER, input(), setup({ store }).deps),
      createEnginePrediction(USER, input({ assetId: ASSET_B }), setup({ store }).deps),
    ]);
    expect(store.rows).toHaveLength(1);
    const ok = settled.filter((s) => s.status === "fulfilled");
    const bad = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(bad[0]!.reason).toBeInstanceOf(PredictionRejectedError);
    expect((bad[0]!.reason as PredictionRejectedError).reason).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("a lost race whose winner cannot be read back fails as INTERNAL, never as a raw error", async () => {
    const store = new MemoryStore();
    store.insert = async () => {
      throw new PredictionIdempotencyConflictError();
    };
    const err = (await createEnginePrediction(USER, input(), setup({ store }).deps).catch((e: unknown) => e)) as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("INTERNAL");
    expect(err.message).toBe("Could not save the prediction");
  });
});

describe("lookup failures", () => {
  it("surface as INTERNAL and create nothing", async () => {
    const h = setup();
    h.store.findByIdempotencyKey = async () => {
      throw new Error("db down");
    };
    const err = (await createEnginePrediction(USER, input(), h.deps).catch((e: unknown) => e)) as AppError;
    expect(err.code).toBe("INTERNAL");
    expect(h.store.insertCalls).toBe(0);
    expect(h.audits).toHaveLength(0);
  });
});

describe("a replayed row that is evaluated reports EVALUATED", () => {
  it("derives the lifecycle from the stored row, not 'CREATED'", async () => {
    const store = new MemoryStore();
    await createEnginePrediction(USER, input(), setup({ store }).deps);
    const real = store.findByIdempotencyKey.bind(store);
    store.findByIdempotencyKey = async (u, k) => {
      const r = await real(u, k);
      return r && { ...r, evaluated: true };
    };
    const replay = await createEnginePrediction(USER, input(), setup({ store }).deps);
    expect(replay).toMatchObject({ replayed: true, lifecycle: "EVALUATED" });
  });
});

describe("unique-violation classification", () => {
  const e = (over: Record<string, unknown>) => ({ code: "23505", message: "", details: "", ...over });
  it("recognises the idempotency index in the message", () => {
    expect(isPredictionIdempotencyViolation(e({ message: `duplicate key value violates unique constraint "${PREDICTION_IDEMPOTENCY_INDEX}"` }))).toBe(true);
  });
  it("recognises the idempotency index in the details", () => {
    expect(isPredictionIdempotencyViolation(e({ details: `Key (user_id, idempotency_key)=(x, y) already exists. ${PREDICTION_IDEMPOTENCY_INDEX}` }))).toBe(true);
  });
  it("ignores other unique violations", () => {
    expect(isPredictionIdempotencyViolation(e({ message: 'duplicate key value violates unique constraint "predictions_pkey"' }))).toBe(false);
  });
  it("ignores other SQLSTATEs even when the index is named", () => {
    expect(isPredictionIdempotencyViolation(e({ code: "23514", message: PREDICTION_IDEMPOTENCY_INDEX }))).toBe(false);
  });
  it.each([null, undefined, "23505", 42, new Error("x")])("ignores non-database errors (%s)", (v) => {
    expect(isPredictionIdempotencyViolation(v)).toBe(false);
  });
  it("the constant matches the A1 migration's index name", () => {
    const sql = readFileSync(path.join(process.cwd(), "supabase/migrations/20261006000010_prediction_create_idempotency.sql"), "utf8");
    expect(sql).toContain(`create unique index ${PREDICTION_IDEMPOTENCY_INDEX}`);
  });
});

describe("store wiring (static)", () => {
  const src = readFileSync(path.join(process.cwd(), "services/predictions/supabase-store.ts"), "utf8");
  it("looks up by BOTH user_id and idempotency_key", () => {
    expect(src).toMatch(/\.eq\("user_id", userId\)\s*\.eq\("idempotency_key", idempotencyKey\)/);
  });
  it("maps only the idempotency unique violation to the typed conflict", () => {
    expect(src).toMatch(/isPredictionIdempotencyViolation\(error\)\) throw new PredictionIdempotencyConflictError\(\)/);
    expect(src).toMatch(/throw error;\s*\}\s*return data as InsertedPredictionRow/);
  });
});
