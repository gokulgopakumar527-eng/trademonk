import type {
  AssetRef,
  AssetSearchHit,
  Candle,
  CandleSeries,
  HistoricalRequest,
  MarketStatus,
  ProviderCapabilities,
  Quote,
  Result,
} from "@/types/market";
import { TIMEFRAMES, TIMEFRAME_MS } from "@/types/market";
import { NO_CAPABILITIES, type MarketDataProvider } from "../../provider";
import { ok, unsupported } from "../../result";

export const MOCK_SOURCE = "mock";

/** Deterministic pseudo-random in [0,1) from a string + integer. Not cryptographic. */
function rand(seed: string, n: number): number {
  let h = 2166136261 ^ n;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/**
 * DEVELOPMENT ONLY. Produces synthetic random-walk data, always flagged isMock: true, so the UI
 * labels it "MOCK DATA". The constructor refuses to run outside development: it can never leak
 * into staging/production through misconfiguration.
 */
export class MockMarketProvider implements MarketDataProvider {
  readonly id = MOCK_SOURCE;
  readonly displayName = "MOCK DATA (development only)";
  readonly capabilities: ProviderCapabilities = {
    markets: ["CRYPTO", "NSE", "BSE"],
    supports: { ...NO_CAPABILITIES, quote: true, historical: true, marketStatus: false },
    timeframes: TIMEFRAMES,
    maxCandlesPerRequest: 1000,
  };
  private readonly now: () => Date;

  constructor(opts: { appEnv: string; now?: () => Date }) {
    if (opts.appEnv !== "development") {
      throw new Error("MockMarketProvider is only available when APP_ENV=development");
    }
    this.now = opts.now ?? (() => new Date());
  }

  private basePrice(asset: AssetRef): number {
    return 50 + Math.floor(rand(asset.symbol, 1) * 5000);
  }

  private priceAt(asset: AssetRef, bucket: number): number {
    // Bounded random walk around the base price.
    const base = this.basePrice(asset);
    let p = base;
    const start = bucket - 300;
    for (let i = start; i <= bucket; i++) p *= 1 + (rand(asset.symbol, i) - 0.5) * 0.01;
    return p;
  }

  async getQuote(asset: AssetRef): Promise<Result<Quote>> {
    const now = this.now();
    const bucket = Math.floor(now.getTime() / 60_000);
    const price = this.priceAt(asset, bucket);
    const prev = this.priceAt(asset, bucket - 1440);
    return ok({
      source: MOCK_SOURCE,
      asOf: now.toISOString(),
      fetchedAt: now.toISOString(),
      isMock: true,
      market: asset.market,
      symbol: asset.symbol,
      currency: asset.currency,
      price,
      change: price - prev,
      changePct: ((price - prev) / prev) * 100,
      high: null,
      low: null,
      volume: null,
    });
  }

  async getHistoricalData(req: HistoricalRequest): Promise<Result<CandleSeries>> {
    const now = this.now();
    const tf = TIMEFRAME_MS[req.timeframe];
    const limit = Math.min(Math.max(req.limit ?? 200, 1), 1000);
    const endMs = req.endTime ? Date.parse(req.endTime) : now.getTime();
    const lastOpen = Math.floor((endMs - 1) / tf) * tf;
    const candles: Candle[] = [];
    for (let i = limit - 1; i >= 0; i--) {
      const open = lastOpen - i * tf;
      const b = Math.floor(open / tf);
      const o = this.priceAt(req.asset, b);
      const c = this.priceAt(req.asset, b + 1);
      const spread = Math.abs(c - o) + o * 0.002 * rand(req.asset.symbol, b + 7);
      candles.push({
        openTime: new Date(open).toISOString(),
        open: o,
        high: Math.max(o, c) + spread * 0.3,
        low: Math.min(o, c) - spread * 0.3,
        close: c,
        volume: null,
        closed: open + tf <= now.getTime(),
      });
    }
    return ok({
      source: MOCK_SOURCE,
      asOf: now.toISOString(),
      fetchedAt: now.toISOString(),
      isMock: true,
      market: req.asset.market,
      symbol: req.asset.symbol,
      currency: req.asset.currency,
      timeframe: req.timeframe,
      candles,
    });
  }

  async getMarketStatus(): Promise<Result<MarketStatus>> {
    return unsupported(this.id, "marketStatus");
  }

  async searchAssets(): Promise<Result<AssetSearchHit[]>> {
    return unsupported(this.id, "search");
  }
}
