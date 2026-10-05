import { logger } from "@/lib/logger";
import type { Market } from "@/types/domain";
import {
  TIMEFRAME_MS,
  type CandleSeries,
  type MarketStatus,
  type ProviderError,
  type Quote,
  type Result,
  type Timeframe,
} from "@/types/market";
import { TtlCache } from "./cache";
import {
  assessFreshness,
  assessSeriesFreshness,
  type Freshness,
} from "./freshness";
import type { MarketDataRegistry } from "./registry";
import { userMessageFor } from "./result";
import type { MarketDataStore } from "./store";
import type { Asset } from "./types";

export type Served = "PROVIDER" | "STORE";

export type DataView<T> =
  | { ok: true; data: T; freshness: Freshness; servedFrom: Served }
  | { ok: false; error: ProviderError; message: string };

export interface MarketDataServiceOptions {
  registry: MarketDataRegistry;
  store?: MarketDataStore;
  now?: () => Date;
  /** Max acceptable age of a quote before it is flagged stale. */
  quoteMaxAgeMs?: number;
  quoteTtlMs?: number;
  failureTtlMs?: number;
  allowMockData?: boolean;
}

const FORMING_CANDLE_TTL_MS = 15_000;
const MAX_CLOSED_TTL_MS = 10 * 60_000;

/**
 * Facade the app talks to. Owns caching, staleness flagging and the store fallback.
 * Never fabricates: if the provider fails and the store has nothing, the answer is an error view.
 */
export class MarketDataService {
  private readonly registry: MarketDataRegistry;
  private readonly store?: MarketDataStore;
  private readonly now: () => Date;
  private readonly quoteMaxAgeMs: number;
  private readonly quoteTtlMs: number;
  private readonly failureTtlMs: number;
  private readonly allowMock: boolean;
  private readonly quotes: TtlCache<Result<Quote>>;
  private readonly candles: TtlCache<Result<CandleSeries>>;
  private readonly statuses: TtlCache<Result<MarketStatus>>;

  constructor(opts: MarketDataServiceOptions) {
    this.registry = opts.registry;
    this.store = opts.store;
    this.now = opts.now ?? (() => new Date());
    this.quoteMaxAgeMs = opts.quoteMaxAgeMs ?? 2 * 60_000;
    this.quoteTtlMs = opts.quoteTtlMs ?? 10_000;
    this.failureTtlMs = opts.failureTtlMs ?? 5_000;
    this.allowMock = opts.allowMockData ?? false;
    const clock = () => this.now().getTime();
    this.quotes = new TtlCache(500, clock);
    this.candles = new TtlCache(200, clock);
    this.statuses = new TtlCache(20, clock);
  }

  async getMarketStatus(market: Market): Promise<Result<MarketStatus>> {
    return this.statuses.getOrLoad(
      market,
      (r) => (r.ok ? 30_000 : this.failureTtlMs),
      () => this.registry.execute(market, "marketStatus", (p) => p.getMarketStatus(market)),
    );
  }

  async getQuote(asset: Asset): Promise<DataView<Quote>> {
    const key = `q:${asset.market}:${asset.symbol}`;
    const live = await this.quotes.getOrLoad(
      key,
      (r) => (r.ok ? this.quoteTtlMs : this.failureTtlMs),
      () => this.registry.execute(asset.market, "quote", (p) => p.getQuote(asset)),
    );

    const status = await this.stateFor(asset.market);
    if (live.ok && this.acceptable(live.data.isMock)) {
      void this.persist(() => this.store?.saveQuote(asset, live.data));
      return this.view(live.data, "PROVIDER", assessFreshness(live.data, this.freshOpts(status)));
    }
    if (live.ok) return this.rejectMock<Quote>();

    // Provider failed: serve the last stored quote, clearly flagged, or nothing.
    const stored = await this.safeRead(() => this.store?.readQuote(asset));
    if (stored && this.acceptable(stored.isMock)) {
      const f = assessFreshness(stored, this.freshOpts(status));
      // A stored value after a live failure is never presented as fresh.
      const freshness: Freshness = f.status === "FRESH" ? { ...f, status: "STALE" } : f;
      return this.view(stored, "STORE", freshness);
    }
    return this.errorView(live.error);
  }

  async getCandles(asset: Asset, timeframe: Timeframe, limit = 300): Promise<DataView<CandleSeries>> {
    const key = `c:${asset.market}:${asset.symbol}:${timeframe}:${limit}`;
    const live = await this.candles.getOrLoad(
      key,
      (r) => {
        if (!r.ok) return this.failureTtlMs;
        const last = r.data.candles.at(-1);
        return last && !last.closed
          ? FORMING_CANDLE_TTL_MS
          : Math.min(TIMEFRAME_MS[timeframe] / 4, MAX_CLOSED_TTL_MS);
      },
      () =>
        this.registry.execute(asset.market, "historical", (p) =>
          p.getHistoricalData({ asset, timeframe, limit }),
        ),
    );

    const status = await this.stateFor(asset.market);
    if (live.ok && this.acceptable(live.data.isMock)) {
      void this.persist(() => this.store?.saveCandles(asset, live.data));
      return this.view(live.data, "PROVIDER", assessSeriesFreshness(live.data, this.seriesOpts(status)));
    }
    if (live.ok) return this.rejectMock<CandleSeries>();

    const stored = await this.safeRead(() => this.store?.readCandles(asset, timeframe, limit));
    if (stored && this.acceptable(stored.isMock)) {
      const f = assessSeriesFreshness(stored, this.seriesOpts(status));
      const freshness: Freshness = f.status === "FRESH" ? { ...f, status: "STALE" } : f;
      return this.view(stored, "STORE", freshness);
    }
    return this.errorView(live.error);
  }

  // ── helpers ──
  private acceptable(isMock: boolean): boolean {
    return !isMock || this.allowMock;
  }

  private rejectMock<T>(): DataView<T> {
    logger.error("market_data.mock_rejected", {});
    return {
      ok: false,
      error: { code: "UNSUPPORTED", message: "mock data not allowed in this environment", provider: "service", retryable: false },
      message: "Data unavailable",
    };
  }

  private view<T>(data: T, servedFrom: Served, freshness: Freshness): DataView<T> {
    return { ok: true, data, freshness, servedFrom };
  }

  private errorView<T>(error: ProviderError): DataView<T> {
    return { ok: false, error, message: userMessageFor(error) };
  }

  private async stateFor(market: Market) {
    const s = await this.getMarketStatus(market);
    return s.ok ? s.data.state : undefined;
  }

  private freshOpts(state: MarketStatus["state"] | undefined) {
    return { now: this.now(), maxAgeMs: this.quoteMaxAgeMs, marketState: state };
  }
  private seriesOpts(state: MarketStatus["state"] | undefined) {
    return { now: this.now(), marketState: state };
  }

  private async persist(fn: () => Promise<void> | undefined): Promise<void> {
    try {
      await fn();
    } catch (e) {
      logger.warn("market_data.persist_failed", { error: e });
    }
  }

  private async safeRead<T>(fn: () => Promise<T | null> | undefined): Promise<T | null> {
    try {
      return (await fn()) ?? null;
    } catch (e) {
      logger.warn("market_data.store_read_failed", { error: e });
      return null;
    }
  }
}
