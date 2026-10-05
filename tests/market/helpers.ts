import type { Asset } from "@/services/market-data/types";
import type { CandleSeries, ProviderCapabilities, Quote, Result } from "@/types/market";
import type { MarketDataProvider } from "@/services/market-data/provider";
import { NO_CAPABILITIES } from "@/services/market-data/provider";
import { ok } from "@/services/market-data/result";
import type { Market } from "@/types/domain";

export const BTC: Asset = { id: "a-btc", market: "CRYPTO", symbol: "BTC", currency: "USDT", kind: "CRYPTO", name: "Bitcoin" };
export const NIFTY: Asset = { id: "a-nifty", market: "NSE", symbol: "NIFTY 50", currency: "INR", kind: "INDEX", name: "Nifty 50" };

export const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

export function quoteAt(asOf: string, over: Partial<Quote> = {}): Quote {
  return {
    source: "test", asOf, fetchedAt: asOf, isMock: false, market: "CRYPTO", symbol: "BTC", currency: "USDT",
    price: 100, change: 1, changePct: 1, high: 101, low: 99, volume: 10, ...over,
  };
}

export function seriesAt(asOf: string, last: { openTime: string; closed: boolean }, over: Partial<CandleSeries> = {}): CandleSeries {
  return {
    source: "test", asOf, fetchedAt: asOf, isMock: false, market: "CRYPTO", symbol: "BTC", currency: "USDT",
    timeframe: "1h",
    candles: [{ openTime: last.openTime, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1, closed: last.closed }],
    ...over,
  };
}

export interface FakeOpts {
  id?: string;
  markets?: readonly Market[];
  quote?: () => Promise<Result<Quote>>;
  candles?: () => Promise<Result<CandleSeries>>;
  supports?: Partial<ProviderCapabilities["supports"]>;
  throws?: boolean;
}

export function fakeProvider(o: FakeOpts = {}): MarketDataProvider & { calls: { quote: number; candles: number } } {
  const calls = { quote: 0, candles: 0 };
  return {
    id: o.id ?? "fake",
    displayName: "fake",
    calls,
    capabilities: {
      markets: o.markets ?? ["CRYPTO"],
      supports: { ...NO_CAPABILITIES, quote: true, historical: true, marketStatus: true, ...o.supports },
      timeframes: ["1h"],
      maxCandlesPerRequest: 100,
    },
    async getQuote() {
      calls.quote++;
      if (o.throws) throw new Error("boom");
      return o.quote ? o.quote() : ok(quoteAt(new Date().toISOString()));
    },
    async getHistoricalData() {
      calls.candles++;
      return o.candles ? o.candles() : ok(seriesAt(new Date().toISOString(), { openTime: new Date().toISOString(), closed: false }));
    },
    async getMarketStatus(market) {
      const now = new Date().toISOString();
      return ok({ source: "fake", asOf: now, fetchedAt: now, isMock: false, market, state: "ALWAYS_OPEN", basis: "RULE", nextChangeAt: null, note: null });
    },
    async searchAssets() {
      return ok([]);
    },
  };
}
