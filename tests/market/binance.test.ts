import { describe, expect, it, vi } from "vitest";
import ticker from "../fixtures/binance/ticker24hr-btcusdt.json";
import klines from "../fixtures/binance/klines-btcusdt-1h.json";
import { BinanceCryptoProvider } from "@/services/market-data/providers/crypto/binance-provider";
import {
  NormaliseError,
  normaliseKlines,
  toBinanceSymbol,
} from "@/services/market-data/providers/crypto/binance-normalise";
import type { MarketDataProvider } from "@/services/market-data/provider";
import { BTC, NIFTY, jsonResponse } from "./helpers";

const NOW = new Date(1790086400000 + 5_000); // shortly after the fixture ticker closeTime
const mk = (fetchImpl: typeof fetch, extra = {}) =>
  new BinanceCryptoProvider({ fetchImpl, now: () => NOW, timeoutMs: 50, maxRetries: 1, ...extra });

describe("symbol mapping", () => {
  it("maps canonical BTC/USDT to BTCUSDT", () => expect(toBinanceSymbol(BTC)).toBe("BTCUSDT"));
  it("rejects characters that could alter the URL", () => {
    expect(toBinanceSymbol({ symbol: "BTC&limit=1", currency: "USDT" })).toBeNull();
    expect(toBinanceSymbol({ symbol: "NIFTY 50", currency: "INR" })).toBeNull();
  });
});

describe("quote normalisation", () => {
  it("returns a canonical quote with provenance", async () => {
    const f = vi.fn<typeof fetch>(async () => jsonResponse(ticker));
    const r = await mk(f as unknown as typeof fetch).getQuote(BTC);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toMatchObject({
      source: "binance-public", isMock: false, market: "CRYPTO", symbol: "BTC", currency: "USDT",
      price: 99800, change: -250.5, changePct: -0.25, high: 100500, low: 99000,
    });
    expect(r.data.asOf).toBe(new Date(ticker.closeTime).toISOString());
    expect(r.data.fetchedAt).toBe(NOW.toISOString());
    expect(String(f.mock.calls[0]![0])).toContain("https://data-api.binance.vision/api/v3/ticker/24hr?symbol=BTCUSDT");
  });

  it("rejects non-finite / non-positive / inverted payloads as INVALID_RESPONSE", async () => {
    for (const bad of [
      { ...ticker, lastPrice: "NaN" },
      { ...ticker, lastPrice: "0" },
      { ...ticker, highPrice: "1", lowPrice: "2" },
      { symbol: "BTCUSDT" },
    ]) {
      const r = await mk((async () => jsonResponse(bad)) as unknown as typeof fetch).getQuote(BTC);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_RESPONSE");
    }
  });
});

describe("candle normalisation", () => {
  const rows = klines as unknown as [number, string, string, string, string, string, number][];

  it("orders ascending, flags closed vs forming, and sets asOf sensibly", () => {
    const fetchedAt = new Date(rows[2]![0] + 60_000); // inside the last candle
    const s = normaliseKlines([rows[2]!, rows[0]!, rows[1]!], BTC, "1h", fetchedAt);
    expect(s.candles.map((c) => c.close)).toEqual([105, 108, 101]);
    expect(s.candles.map((c) => c.closed)).toEqual([true, true, false]);
    expect(s.asOf).toBe(fetchedAt.toISOString()); // forming candle => as of fetch
    const later = normaliseKlines(rows, BTC, "1h", new Date(rows[2]![6] + 1000));
    expect(later.candles.every((c) => c.closed)).toBe(true);
    expect(later.asOf).toBe(new Date(rows[2]![6]).toISOString()); // all closed => as of last close
  });

  it("drops duplicate open times", () => {
    const s = normaliseKlines([rows[0]!, rows[0]!], BTC, "1h", NOW);
    expect(s.candles).toHaveLength(1);
  });

  it("throws on inconsistent OHLC", () => {
    const bad: typeof rows[number] = [rows[0]![0], "100", "90", "95", "105", "1", rows[0]![6]];
    expect(() => normaliseKlines([bad], BTC, "1h", NOW)).toThrow(NormaliseError);
  });

  it("provider returns candles and passes interval/limit; empty => NOT_FOUND", async () => {
    const f = vi.fn<typeof fetch>(async () => jsonResponse(klines));
    const r = await mk(f as unknown as typeof fetch).getHistoricalData({ asset: BTC, timeframe: "1h", limit: 5000 });
    expect(r.ok && r.data.candles).toHaveLength(3);
    const url = String(f.mock.calls[0]![0]);
    expect(url).toContain("interval=1h");
    expect(url).toContain("limit=1000"); // clamped
    const empty = await mk((async () => jsonResponse([])) as unknown as typeof fetch).getHistoricalData({ asset: BTC, timeframe: "1h" });
    expect(!empty.ok && empty.error.code).toBe("NOT_FOUND");
  });

  it("malformed kline rows => INVALID_RESPONSE", async () => {
    const r = await mk((async () => jsonResponse([[1, "x"]])) as unknown as typeof fetch).getHistoricalData({ asset: BTC, timeframe: "1h" });
    expect(!r.ok && r.error.code).toBe("INVALID_RESPONSE");
  });
});

describe("provider failures", () => {
  const status = (code: number, headers: Record<string, string> = {}, body: unknown = {}) =>
    vi.fn(async () => jsonResponse(body, { status: code, headers }));

  it("HTTP 451 => GEO_RESTRICTED, not retried", async () => {
    const f = status(451);
    const r = await mk(f as unknown as typeof fetch).getQuote(BTC);
    expect(!r.ok && r.error).toMatchObject({ code: "GEO_RESTRICTED", retryable: false });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("HTTP 429 => RATE_LIMITED with retry-after, not retried in-request", async () => {
    const f = status(429, { "retry-after": "30" });
    const r = await mk(f as unknown as typeof fetch).getQuote(BTC);
    expect(!r.ok && r.error).toMatchObject({ code: "RATE_LIMITED", retryable: true, retryAfterMs: 30_000 });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("HTTP 5xx is retried once then reported as UPSTREAM_ERROR", async () => {
    const f = status(503);
    const r = await mk(f as unknown as typeof fetch).getQuote(BTC);
    expect(!r.ok && r.error.code).toBe("UPSTREAM_ERROR");
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("a transient failure followed by success returns data", async () => {
    const f = vi.fn().mockResolvedValueOnce(jsonResponse({}, { status: 502 })).mockResolvedValueOnce(jsonResponse(ticker));
    const r = await mk(f as unknown as typeof fetch).getQuote(BTC);
    expect(r.ok).toBe(true);
  });

  it("times out => TIMEOUT", async () => {
    const hang = ((_u: string, init: RequestInit) =>
      new Promise((_res, rej) => init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))))) as unknown as typeof fetch;
    const r = await mk(hang, { maxRetries: 0 }).getQuote(BTC);
    expect(!r.ok && r.error.code).toBe("TIMEOUT");
  });

  it("network failure => UPSTREAM_ERROR; invalid JSON => INVALID_RESPONSE; -1121 => NOT_FOUND", async () => {
    const net = await mk((async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch, { maxRetries: 0 }).getQuote(BTC);
    expect(!net.ok && net.error.code).toBe("UPSTREAM_ERROR");
    const notJson = await mk((async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch).getQuote(BTC);
    expect(!notJson.ok && notJson.error.code).toBe("INVALID_RESPONSE");
    const nf = await mk((async () => jsonResponse({ code: -1121, msg: "Invalid symbol." }, { status: 400 })) as unknown as typeof fetch).getQuote(BTC);
    expect(!nf.ok && nf.error.code).toBe("NOT_FOUND");
  });
});

describe("unsupported capabilities", () => {
  const p = mk((async () => jsonResponse(ticker)) as unknown as typeof fetch);
  it("declares what it supports", () => {
    expect(p.capabilities.supports).toMatchObject({ quote: true, historical: true, orderBook: false, fundingRate: false, openInterest: false, news: false, search: false });
    expect((p as MarketDataProvider).getOrderBook).toBeUndefined();
  });
  it("rejects non-crypto assets and search without calling the network", async () => {
    const f = vi.fn();
    const q = await mk(f as unknown as typeof fetch).getQuote(NIFTY);
    expect(!q.ok && q.error.code).toBe("UNSUPPORTED");
    const s = await p.searchAssets();
    expect(!s.ok && s.error.code).toBe("UNSUPPORTED");
    const st = await p.getMarketStatus("NSE");
    expect(!st.ok && st.error.code).toBe("UNSUPPORTED");
    expect(f).not.toHaveBeenCalled();
  });
  it("crypto market status is an explicit rule, not a feed", async () => {
    const st = await p.getMarketStatus("CRYPTO");
    expect(st.ok && st.data).toMatchObject({ state: "ALWAYS_OPEN", basis: "RULE" });
  });
});
