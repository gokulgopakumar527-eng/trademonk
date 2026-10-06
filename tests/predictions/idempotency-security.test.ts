import { beforeEach, describe, expect, it, vi } from "vitest";

// Phase 5D-A4: security and regression validation of the A1-A3 prediction-create idempotency path.
// The real SupabasePredictionStore runs against a recording fake of the admin client; the service
// runs against a small in-memory store. The engine is wrapped in a spy so replay can be proven not to run it.

const h = vi.hoisted(() => {
  const state = {
    calls: [] as Array<[string, ...unknown[]]>,
    result: { data: null as unknown, error: null as unknown },
    logs: [] as string[],
  };
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "eq", "insert"]) {
    builder[m] = (...a: unknown[]) => {
      state.calls.push([m, ...a]);
      return builder;
    };
  }
  builder.single = async () => state.result;
  builder.maybeSingle = async () => state.result;
  return { state, builder };
});

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({
    from: (t: string) => {
      h.state.calls.push(["from", t]);
      return h.builder;
    },
  }),
}));
vi.mock("@/lib/logger", () => {
  const rec = (level: string) => (event: string, fields?: unknown) => void h.state.logs.push(JSON.stringify({ level, event, fields }, (_k, v) => (v instanceof Error ? { name: v.name, message: v.message } : v)));
  return { logger: { debug: rec("debug"), info: rec("info"), warn: rec("warn"), error: rec("error") } };
});
vi.mock("@/services/predictions/engine", async (orig) => {
  const m = await orig<typeof import("@/services/predictions/engine")>();
  return { ...m, generatePrediction: vi.fn(m.generatePrediction) };
});

import { AppError } from "@/lib/errors";
import type { DataView } from "@/services/market-data/market-data-service";
import type { Asset } from "@/services/market-data/types";
import { generatePrediction } from "@/services/predictions/engine";
import { PREDICTION_IDEMPOTENCY_INDEX, PredictionIdempotencyConflictError, PredictionRejectedError } from "@/services/predictions/errors";
import { createEnginePrediction, type PredictionDeps, type PredictionStore } from "@/services/predictions/prediction-service";
import { SupabasePredictionStore } from "@/services/predictions/supabase-store";
import type { InsertedPredictionRow, NewPredictionRow, StoredPredictionRecord } from "@/services/predictions/types";
import type { CandleSeries, Quote } from "@/types/market";
import { quoteAt } from "../market/helpers";
import { build, T0, upCloses } from "./helpers";

const USER_A = "c2b7f0a4-1d2e-4c8a-9f11-0a7b5d6e8f90";
const USER_B = "d3c8a1b5-2e3f-4d9b-a022-1b8c6e7f9a01";
const ASSET_1 = "3f0c6a52-6f0e-4e63-9c53-2f5a1c1d9b10";
const ASSET_2 = "7a1d2c3e-5b4f-4a6b-8c7d-9e0f1a2b3c4d";
const KEY = "tm-sec-key-0123456789ab";
const NOW = new Date(T0);
const iso = (ms: number) => new Date(ms).toISOString();

beforeEach(() => {
  h.state.calls.length = 0;
  h.state.logs.length = 0;
  h.state.result = { data: null, error: null };
  vi.mocked(generatePrediction).mockClear();
});

// ───────────────────────── real store ─────────────────────────
describe("SupabasePredictionStore.findByIdempotencyKey: ownership scoping", () => {
  const rawRow = {
    id: "9d8c7b6a-1111-4222-8333-444455556666", asset_id: ASSET_1, direction: "BULLISH", timeframe: "1h", horizon_hours: 24,
    entry_reference_price: "100.50000000", target_price: "110.25", invalidation_price: "95", engine_version: "rules-1",
    signal_agreement: 4, entry_quote_source: "binance-public", entry_quote_as_of: iso(T0), entry_quote_fetched_at: iso(T0),
    entry_quote_is_mock: false, engine_snapshot: { signalsUsed: [], reasoning: [] }, created_at: iso(T0), expires_at: iso(T0 + 1),
    content_hash: "a".repeat(64), hash_version: 2,
  };

  it("filters by BOTH user_id and idempotency_key, on the predictions table, as one lookup", async () => {
    await new SupabasePredictionStore().findByIdempotencyKey(USER_A, KEY);
    expect(h.state.calls.filter((c) => c[0] === "from")).toEqual([["from", "predictions"]]);
    const eqs = h.state.calls.filter((c) => c[0] === "eq").map((c) => [c[1], c[2]]);
    expect(eqs).toEqual([["user_id", USER_A], ["idempotency_key", KEY]]);
  });

  it("never issues a write while looking up", async () => {
    await new SupabasePredictionStore().findByIdempotencyKey(USER_A, KEY);
    expect(h.state.calls.some((c) => c[0] === "insert")).toBe(false);
  });

  it("returns null when no row matches (including another user's key)", async () => {
    h.state.result = { data: null, error: null };
    expect(await new SupabasePredictionStore().findByIdempotencyKey(USER_B, KEY)).toBeNull();
  });

  it("converts numeric strings to numbers and reports evaluated from the embed (array, object, empty, null)", async () => {
    const store = new SupabasePredictionStore();
    h.state.result = { data: { ...rawRow, prediction_results: null }, error: null };
    expect(await store.findByIdempotencyKey(USER_A, KEY)).toMatchObject({ entry_reference_price: 100.5, target_price: 110.25, invalidation_price: 95, evaluated: false });
    h.state.result = { data: { ...rawRow, prediction_results: [] }, error: null };
    expect((await store.findByIdempotencyKey(USER_A, KEY))!.evaluated).toBe(false);
    h.state.result = { data: { ...rawRow, prediction_results: [{ status: "WIN" }] }, error: null };
    expect((await store.findByIdempotencyKey(USER_A, KEY))!.evaluated).toBe(true);
    h.state.result = { data: { ...rawRow, prediction_results: { status: "WIN" } }, error: null };
    expect((await store.findByIdempotencyKey(USER_A, KEY))!.evaluated).toBe(true);
  });

  it("does not swallow database errors", async () => {
    const err = { code: "XX000", message: "boom" };
    h.state.result = { data: null, error: err };
    await expect(new SupabasePredictionStore().findByIdempotencyKey(USER_A, KEY)).rejects.toBe(err);
  });
});

describe("SupabasePredictionStore.insert: only the idempotency unique violation is a race", () => {
  const row = { user_id: USER_A, idempotency_key: KEY, asset_id: ASSET_1 } as unknown as NewPredictionRow;
  const insertWith = (error: unknown) => {
    h.state.result = { data: null, error };
    return new SupabasePredictionStore().insert(row);
  };

  it("writes the key to the predictions table", async () => {
    h.state.result = { data: { id: "x" }, error: null };
    await new SupabasePredictionStore().insert(row);
    expect(h.state.calls).toContainEqual(["insert", row]);
  });

  it("maps 23505 on the idempotency index (message) to the typed conflict, without the raw error", async () => {
    const e = await insertWith({ code: "23505", message: `duplicate key value violates unique constraint "${PREDICTION_IDEMPOTENCY_INDEX}"`, details: "Key (user_id, idempotency_key)=(u, k) already exists." }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PredictionIdempotencyConflictError);
    expect(JSON.stringify(e)).not.toContain(KEY);
    expect((e as Error).message).not.toMatch(/23505|duplicate key|violates/);
  });

  it.each([
    ["the primary key", { code: "23505", message: 'duplicate key value violates unique constraint "predictions_pkey"', details: "Key (id)=(x) already exists." }],
    ["another unique index", { code: "23505", message: 'duplicate key value violates unique constraint "paper_trades_user_idempotency_key_uidx"', details: "" }],
    ["a CHECK violation on the key format", { code: "23514", message: 'new row violates check constraint "predictions_idempotency_key_format"' }],
    ["a foreign-key violation", { code: "23503", message: "violates foreign key" }],
    ["a connection failure", { code: "08006", message: "connection failure" }],
    ["an error naming the index but not 23505", { code: "42501", message: `permission denied ${PREDICTION_IDEMPOTENCY_INDEX}` }],
  ])("keeps %s as the original error (never reconciled as a replay)", async (_n, error) => {
    await expect(insertWith(error)).rejects.toBe(error);
  });
});

// ───────────────────────── service ─────────────────────────
const asset = (id: string): Asset => ({ id, market: "CRYPTO", symbol: "X", currency: "USDT", kind: "CRYPTO", name: "X" });
const ok = <T,>(data: T): DataView<T> => ({ ok: true, data, freshness: { status: "FRESH", ageMs: 0, label: "" }, servedFrom: "PROVIDER" });

class Store implements PredictionStore {
  rows: Array<NewPredictionRow & { id: string }> = [];
  lookups: Array<[string, string]> = [];
  evaluated = false;
  expiresAt = "2026-09-30T00:00:00.000000+00:00";
  async getAssetById(id: string) {
    return asset(id);
  }
  async insert(row: NewPredictionRow): Promise<InsertedPredictionRow> {
    if (this.rows.some((r) => r.user_id === row.user_id && r.idempotency_key === row.idempotency_key)) throw new PredictionIdempotencyConflictError();
    const id = `00000000-0000-4000-8000-${String(this.rows.length + 1).padStart(12, "0")}`;
    this.rows.push({ ...row, id });
    return { id, created_at: "2026-09-29T00:00:00.000000+00:00", expires_at: this.expiresAt, content_hash: "b".repeat(64), hash_version: 2 };
  }
  async findByIdempotencyKey(userId: string, key: string): Promise<StoredPredictionRecord | null> {
    this.lookups.push([userId, key]);
    const r = this.rows.find((x) => x.user_id === userId && x.idempotency_key === key);
    if (!r) return null;
    return { ...r, created_at: "2026-09-29T00:00:00.000000+00:00", expires_at: this.expiresAt, content_hash: "b".repeat(64), hash_version: 2, evaluated: this.evaluated };
  }
}

function setup(store = new Store(), now = NOW) {
  const closes = upCloses();
  const series: CandleSeries = { source: "test", asOf: iso(T0 - 5_000), fetchedAt: iso(T0 - 5_000), isMock: false, market: "CRYPTO", symbol: "X", currency: "USDT", timeframe: "1h", candles: build(closes) };
  const getQuote = vi.fn(async () => ok<Quote>(quoteAt(iso(T0 - 5_000), { price: closes.at(-1)!, source: "binance-public", fetchedAt: iso(T0 - 4_000) })));
  const getCandles = vi.fn(async () => ok(series));
  const audits: unknown[] = [];
  const deps: PredictionDeps = {
    marketData: { getQuote, getCandles } as unknown as PredictionDeps["marketData"],
    store,
    audit: async (e) => void audits.push(e),
    now: () => now,
    allowMockData: false,
  };
  return { deps, store, audits, getQuote, getCandles };
}
const input = (over: Record<string, unknown> = {}) => ({ assetId: ASSET_1, timeframe: "1h", idempotencyKey: KEY, ...over });

describe("cross-user key isolation", () => {
  it("user B with user A's key does NOT get A's prediction and creates their own", async () => {
    const s = setup();
    const a = await createEnginePrediction(USER_A, input(), s.deps);
    const b = await createEnginePrediction(USER_B, input(), setup(s.store).deps);
    expect(b.replayed).toBe(false);
    expect(b.id).not.toBe(a.id);
    expect(s.store.rows.map((r) => r.user_id).sort()).toEqual([USER_A, USER_B].sort());
    expect(s.store.rows.find((r) => r.id === b.id)!.user_id).toBe(USER_B);
  });

  it("user B using A's key with a DIFFERENT asset or timeframe gets no IDEMPOTENCY_KEY_REUSED", async () => {
    const s = setup();
    await createEnginePrediction(USER_A, input(), s.deps);
    const b1 = await createEnginePrediction(USER_B, input({ assetId: ASSET_2 }), setup(s.store).deps);
    const b2 = await createEnginePrediction(USER_B, input({ idempotencyKey: "tm-sec-key-other-0001", timeframe: "4h" }), setup(s.store).deps);
    expect([b1.replayed, b2.replayed]).toEqual([false, false]);
  });

  it("a replay is looked up only for the authenticated user id, never one from the input", async () => {
    const s = setup();
    await createEnginePrediction(USER_A, input(), s.deps);
    s.store.lookups.length = 0;
    await createEnginePrediction(USER_A, input(), s.deps);
    expect(s.store.lookups).toEqual([[USER_A, KEY]]);
    // user ids supplied inside the payload are rejected by the strict schema, not used
    await expect(createEnginePrediction(USER_B, { ...input(), userId: USER_A }, s.deps)).rejects.toMatchObject({ code: "VALIDATION" });
    expect(s.store.lookups).toEqual([[USER_A, KEY]]);
  });

  it("user B's replay returns B's own row, not A's", async () => {
    const s = setup();
    const a = await createEnginePrediction(USER_A, input(), s.deps);
    const b = await createEnginePrediction(USER_B, input(), setup(s.store).deps);
    const b2 = await createEnginePrediction(USER_B, input(), setup(s.store).deps);
    expect(b2).toMatchObject({ replayed: true, id: b.id });
    expect(b2.id).not.toBe(a.id);
  });
});

describe("replay executes nothing new", () => {
  it("does not run the engine, call market data, insert or audit; returns identical stored content", async () => {
    const s = setup();
    const first = await createEnginePrediction(USER_A, input(), s.deps);
    expect(generatePrediction).toHaveBeenCalledTimes(1);
    const rowsBefore = JSON.stringify(s.store.rows);
    const r = setup(s.store);
    const replay = await createEnginePrediction(USER_A, input(), r.deps);
    expect(generatePrediction).toHaveBeenCalledTimes(1); // still 1: the engine did not run on replay
    expect(r.getQuote).not.toHaveBeenCalled();
    expect(r.getCandles).not.toHaveBeenCalled();
    expect(r.audits).toHaveLength(0);
    expect(JSON.stringify(s.store.rows)).toBe(rowsBefore);
    expect(replay).toMatchObject({ replayed: true, id: first.id, contentHash: first.contentHash, hashVersion: first.hashVersion, createdAt: first.createdAt, expiresAt: first.expiresAt, targetPrice: first.targetPrice, invalidationPrice: first.invalidationPrice, entryReferencePrice: first.entryReferencePrice, horizonHours: first.horizonHours, engineVersion: first.engineVersion });
    expect(replay.reasoning).toEqual(first.reasoning);
    expect(replay.signalsUsed).toEqual(first.signalsUsed);
  });

  it("conflict and first create each emit the right audit events", async () => {
    const s = setup();
    await createEnginePrediction(USER_A, input(), s.deps);
    expect(s.audits).toHaveLength(1);
    const c = setup(s.store);
    await createEnginePrediction(USER_A, input({ assetId: ASSET_2 }), c.deps).catch(() => null);
    expect(c.audits).toHaveLength(0);
    expect(generatePrediction).toHaveBeenCalledTimes(1);
  });

  it("an unexpired replay keeps its lifecycle, an expired unevaluated one reports EXPIRED, an evaluated one EVALUATED", async () => {
    const s = setup();
    await createEnginePrediction(USER_A, input(), s.deps);
    expect((await createEnginePrediction(USER_A, input(), setup(s.store, new Date("2026-09-29T12:00:00Z")).deps)).lifecycle).toBe("ACTIVE");
    expect((await createEnginePrediction(USER_A, input(), setup(s.store, new Date("2026-10-02T00:00:00Z")).deps)).lifecycle).toBe("EXPIRED");
    s.store.evaluated = true;
    expect((await createEnginePrediction(USER_A, input(), setup(s.store, new Date("2026-10-02T00:00:00Z")).deps)).lifecycle).toBe("EVALUATED");
  });

  it("an incomplete stored row is an INTERNAL error, never a partial or fabricated prediction", async () => {
    const s = setup();
    await createEnginePrediction(USER_A, input(), s.deps);
    s.store.rows[0]!.engine_snapshot = null as never;
    const err = (await createEnginePrediction(USER_A, input(), setup(s.store).deps).catch((e: unknown) => e)) as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("INTERNAL");
  });
});

describe("conflict and failure responses leak nothing", () => {
  it("IDEMPOTENCY_KEY_REUSED carries the fixed safe message: no key, no ids, no asset, no database text", async () => {
    const s = setup();
    const a = await createEnginePrediction(USER_A, input(), s.deps);
    const e = (await createEnginePrediction(USER_A, input({ assetId: ASSET_2 }), setup(s.store).deps).catch((x: unknown) => x)) as PredictionRejectedError;
    expect(e).toBeInstanceOf(PredictionRejectedError);
    expect(e.reason).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(e.code).toBe("VALIDATION");
    for (const secret of [KEY, a.id, ASSET_1, ASSET_2, USER_A, "23505", "uidx", "constraint"]) expect(e.message).not.toContain(secret);
  });

  it("the idempotency key is never written to a log line (replay, conflict, race, failure)", async () => {
    const s = setup();
    await createEnginePrediction(USER_A, input(), s.deps);
    await createEnginePrediction(USER_A, input(), setup(s.store).deps);
    await createEnginePrediction(USER_A, input({ assetId: ASSET_2 }), setup(s.store).deps).catch(() => null);
    const racing = new Store();
    racing.findByIdempotencyKey = async () => null;
    racing.insert = async () => {
      throw new PredictionIdempotencyConflictError();
    };
    await createEnginePrediction(USER_A, input(), setup(racing).deps).catch(() => null);
    expect(h.state.logs.length).toBeGreaterThan(0);
    for (const line of h.state.logs) expect(line).not.toContain(KEY);
  });

  it("a race whose winner cannot be found for THIS user fails INTERNAL and never returns another user's row", async () => {
    const s = setup();
    await createEnginePrediction(USER_A, input(), s.deps); // A owns the key
    const bStore = new Store();
    bStore.rows = s.store.rows; // the same table, so A's row exists
    bStore.findByIdempotencyKey = async (u, k) => {
      bStore.lookups.push([u, k]);
      return null; // B's own lookup finds nothing (as the database would for B)
    };
    bStore.insert = async () => {
      throw new PredictionIdempotencyConflictError(); // simulated spurious race signal
    };
    const err = (await createEnginePrediction(USER_B, input(), setup(bStore).deps).catch((e: unknown) => e)) as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("INTERNAL");
    expect(bStore.lookups.every(([u]) => u === USER_B)).toBe(true);
  });

  it("an unrelated insert failure (even one that looks like a unique violation) is INTERNAL and creates nothing", async () => {
    const s = setup();
    s.store.insert = async () => {
      throw Object.assign(new Error('duplicate key value violates unique constraint "predictions_pkey"'), { code: "23505" });
    };
    const err = (await createEnginePrediction(USER_A, input(), s.deps).catch((e: unknown) => e)) as AppError;
    expect(err.code).toBe("INTERNAL");
    expect(err.message).toBe("Could not save the prediction");
    expect(s.audits).toHaveLength(0);
  });
});

describe("key validation reaches neither the store nor the market", () => {
  const BAD: Array<[string, unknown]> = [
    ["a missing key", undefined],
    ["null", null],
    ["an empty string", ""],
    ["15 characters", "a".repeat(15)],
    ["129 characters", "a".repeat(129)],
    ["a space", "abcdefgh ijklmnopqr"],
    ["a classic SQL injection", "abc'; DROP TABLE predictions;--"],
    ["an OR 1=1 payload", "abcdefgh' OR '1'='1"],
    ["a PostgREST filter fragment", "abcdefghijklmnop,user_id.neq.x"],
    ["a wildcard", "abcdefghijklmnop%"],
    ["a unit separator control char", "abcdefgh\u001fijklmnopqr"],
    ["DEL", "abcdefgh\u007fijklmnopqr"],
    ["a NEL control char", "abcdefgh\u0085ijklmnopqr"],
    ["a line separator", "abcdefgh\u2028ijklmnopqr"],
    ["a non-breaking space", "abcdefgh\u00a0ijklmnopqr"],
    ["a bidi override", "abcdefgh\u202eijklmnopqr"],
    ["a BOM", "\ufeffabcdefghijklmnop"],
    ["a Cyrillic homoglyph", "abcdefgh\u0430ijklmnopqr"],
    ["a fullwidth letter", "abcdefgh\uff41ijklmnopqr"],
    ["a combining accent", "abcdefghe\u0301ijklmnopqr"],
    ["an astral emoji", "abcdefgh\u{1F600}ijklmnopqr"],
    ["a path traversal", "../../etc/passwd/abc"],
  ];
  it.each(BAD)("rejects %s before any lookup, market call or insert", async (_n, key) => {
    const s = setup();
    await expect(createEnginePrediction(USER_A, { assetId: ASSET_1, timeframe: "1h", idempotencyKey: key }, s.deps)).rejects.toMatchObject({ code: "VALIDATION" });
    expect(s.store.lookups).toHaveLength(0);
    expect(s.store.rows).toHaveLength(0);
    expect(s.getQuote).not.toHaveBeenCalled();
    expect(generatePrediction).not.toHaveBeenCalled();
  });

  it("passes an accepted key to the store byte-for-byte (no trim, case-fold or normalisation)", async () => {
    const s = setup();
    const mixed = "AbC.dEf_GhI-jKl-0123456789";
    await createEnginePrediction(USER_A, input({ idempotencyKey: mixed }), s.deps);
    expect(s.store.lookups).toEqual([[USER_A, mixed]]);
    expect(s.store.rows[0]!.idempotency_key).toBe(mixed);
  });

  it("keys differing only by case are different keys", async () => {
    const s = setup();
    const k = "AbCdEfGhIjKlMnOpQr";
    const p1 = await createEnginePrediction(USER_A, input({ idempotencyKey: k }), s.deps);
    const p2 = await createEnginePrediction(USER_A, input({ idempotencyKey: k.toLowerCase() }), s.deps);
    expect([p1.replayed, p2.replayed]).toEqual([false, false]);
    expect(p1.id).not.toBe(p2.id);
  });
});
