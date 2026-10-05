import { describe, expect, it, vi } from "vitest";
import { MarketDataRegistry } from "@/services/market-data/registry";
import { MarketDataService } from "@/services/market-data/market-data-service";
import type { MarketDataStore } from "@/services/market-data/store";
import { fail, ok } from "@/services/market-data/result";
import { BTC, NIFTY, fakeProvider, quoteAt, seriesAt } from "./helpers";

const NOW = new Date("2026-09-28T05:02:00.000Z");
const iso = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

describe("registry", () => {
  it("refuses to route a market to a provider that does not declare it", () => {
    expect(() => new MarketDataRegistry({ NSE: [fakeProvider({ markets: ["CRYPTO"] })] })).toThrow(/does not support market NSE/);
  });
  it("falls through to the next provider and returns the first success", async () => {
    const bad = fakeProvider({ id: "bad", quote: async () => fail("bad", "UPSTREAM_ERROR", "x") });
    const good = fakeProvider({ id: "good" });
    const r = await new MarketDataRegistry({ CRYPTO: [bad, good] }).execute("CRYPTO", "quote", (p) => p.getQuote(BTC));
    expect(r.ok && r.data.source).toBe("test");
    expect(bad.calls.quote).toBe(1);
    expect(good.calls.quote).toBe(1);
  });
  it("returns the PRIMARY's error when everything fails", async () => {
    const a = fakeProvider({ id: "a", quote: async () => fail("a", "GEO_RESTRICTED", "geo", { retryable: false }) });
    const b = fakeProvider({ id: "b", quote: async () => fail("b", "TIMEOUT", "slow") });
    const r = await new MarketDataRegistry({ CRYPTO: [a, b] }).execute("CRYPTO", "quote", (p) => p.getQuote(BTC));
    expect(!r.ok && r.error.code).toBe("GEO_RESTRICTED");
  });
  it("skips providers lacking the capability without calling them", async () => {
    const noQuote = fakeProvider({ supports: { quote: false } });
    const r = await new MarketDataRegistry({ CRYPTO: [noQuote] }).execute("CRYPTO", "quote", (p) => p.getQuote(BTC));
    expect(!r.ok && r.error.code).toBe("UNSUPPORTED");
    expect(noQuote.calls.quote).toBe(0);
  });
  it("contains a throwing provider and reports NOT_CONFIGURED for an empty chain", async () => {
    const r = await new MarketDataRegistry({ CRYPTO: [fakeProvider({ throws: true })] }).execute("CRYPTO", "quote", (p) => p.getQuote(BTC));
    expect(!r.ok && r.error.code).toBe("UPSTREAM_ERROR");
    const empty = await new MarketDataRegistry({}).execute("NSE", "quote", (p) => p.getQuote(NIFTY));
    expect(!empty.ok && empty.error.code).toBe("NOT_CONFIGURED");
  });
});

function fakeStore(over: Partial<MarketDataStore> = {}) {
  return {
    saveQuote: vi.fn(async () => {}),
    saveCandles: vi.fn(async () => {}),
    readQuote: vi.fn(async () => null),
    readCandles: vi.fn(async () => null),
    ...over,
  } as MarketDataStore & { saveQuote: ReturnType<typeof vi.fn>; saveCandles: ReturnType<typeof vi.fn> };
}
const svc = (p: ReturnType<typeof fakeProvider>, store?: MarketDataStore, extra = {}) =>
  new MarketDataService({ registry: new MarketDataRegistry({ CRYPTO: [p] }), store, now: () => NOW, ...extra });

describe("MarketDataService", () => {
  it("serves a fresh quote, caches it, and writes through to the store", async () => {
    const p = fakeProvider({ quote: async () => ok(quoteAt(iso(-10_000))) });
    const store = fakeStore();
    const s = svc(p, store);
    const a = await s.getQuote(BTC);
    const b = await s.getQuote(BTC);
    expect(a.ok && a.freshness.status).toBe("FRESH");
    expect(a.ok && a.freshness.label).toBe("Data updated 10:31 IST");
    expect(b.ok).toBe(true);
    expect(p.calls.quote).toBe(1); // second call served from cache
    expect(store.saveQuote).toHaveBeenCalledTimes(2); // persisted on each served view; upsert is idempotent
  });

  it("flags an old provider quote as STALE rather than live", async () => {
    const p = fakeProvider({ quote: async () => ok(quoteAt(iso(-10 * 60_000))) });
    const r = await svc(p).getQuote(BTC);
    expect(r.ok && r.freshness.status).toBe("STALE");
  });

  it("on provider failure serves the stored quote, never as FRESH", async () => {
    const p = fakeProvider({ quote: async () => fail("fake", "UPSTREAM_ERROR", "down") });
    const store = fakeStore({ readQuote: vi.fn(async () => quoteAt(iso(-5_000))) });
    const r = await svc(p, store).getQuote(BTC);
    expect(r.ok && r.servedFrom).toBe("STORE");
    expect(r.ok && r.freshness.status).toBe("STALE");
  });

  it("with no provider data and nothing stored, returns 'Data unavailable' (no placeholder)", async () => {
    const p = fakeProvider({ quote: async () => fail("fake", "NOT_FOUND", "nope") });
    const r = await svc(p, fakeStore()).getQuote(BTC);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe("Data unavailable");
  });

  it("survives a store that throws", async () => {
    const p = fakeProvider({ quote: async () => fail("fake", "UPSTREAM_ERROR", "down") });
    const store = fakeStore({ readQuote: vi.fn(async () => { throw new Error("db down"); }), saveQuote: vi.fn(async () => { throw new Error("db down"); }) });
    const r = await svc(p, store).getQuote(BTC);
    expect(r.ok).toBe(false);
  });

  it("rejects mock data unless explicitly allowed", async () => {
    const mockQuote = async () => ok(quoteAt(iso(-1000), { isMock: true }));
    const denied = await svc(fakeProvider({ quote: mockQuote })).getQuote(BTC);
    expect(denied.ok).toBe(false);
    const allowed = await svc(fakeProvider({ quote: mockQuote }), undefined, { allowMockData: true }).getQuote(BTC);
    expect(allowed.ok && allowed.freshness.label.startsWith("MOCK DATA")).toBe(true);
  });

  it("candles: caches, flags stale, and persists via the store", async () => {
    const forming = seriesAt(iso(0), { openTime: iso(-60_000), closed: false });
    const p = fakeProvider({ candles: async () => ok(forming) });
    const store = fakeStore();
    const s = svc(p, store);
    const r = await s.getCandles(BTC, "1h", 100);
    await s.getCandles(BTC, "1h", 100);
    expect(r.ok && r.freshness.status).toBe("FRESH");
    expect(p.calls.candles).toBe(1);
    expect(store.saveCandles).toHaveBeenCalled();

    const old = seriesAt(iso(0), { openTime: iso(-5 * 3600_000), closed: true });
    const stale = await svc(fakeProvider({ candles: async () => ok(old) })).getCandles(BTC, "1h", 100);
    expect(stale.ok && stale.freshness.status).toBe("STALE");
  });

  it("unsupported market data (no Indian vendor) => 'Data unavailable'", async () => {
    const reg = new MarketDataRegistry({ NSE: [fakeProvider({ markets: ["NSE"], supports: { quote: false, historical: false } })] });
    const r = await new MarketDataService({ registry: reg, now: () => NOW }).getQuote(NIFTY);
    expect(!r.ok && r.message).toBe("Data unavailable");
  });
});
