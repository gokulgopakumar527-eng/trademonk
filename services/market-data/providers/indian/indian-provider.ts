import type { Market } from "@/types/domain";
import type {
  AssetRef,
  AssetSearchHit,
  CandleSeries,
  HistoricalRequest,
  MarketStatus,
  ProviderCapabilities,
  Quote,
  Result,
} from "@/types/market";
import { EMPTY_INDIA_CALENDAR, type IndiaHolidayCalendar } from "@/config/market-calendars/india";
import { NO_CAPABILITIES, type MarketDataProvider } from "../../provider";
import { computeIndiaMarketStatus } from "../../india-market-status";
import { notConfigured, ok, unsupported } from "../../result";

/**
 * What a licensed broker/vendor adapter (Kite Connect, Upstox, Angel One, Dhan, or a paid data
 * vendor) must implement. Vendor instrument tokens, auth/session refresh and payload shapes live
 * INSIDE the adapter. Adapters return canonical types and honour the same rules as any provider.
 *
 * Exchange-data licensing: redistributing NSE/BSE data to end users typically needs a vendor or
 * exchange licence that covers display/redistribution. Confirm before enabling for real users.
 */
export interface IndianVendorAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;
  getQuote(asset: AssetRef): Promise<Result<Quote>>;
  getHistoricalData(req: HistoricalRequest): Promise<Result<CandleSeries>>;
  searchAssets?(query: string): Promise<Result<AssetSearchHit[]>>;
}

export const INDIAN_MARKETS: readonly Market[] = ["NSE", "BSE"];

export interface IndianMarketProviderOptions {
  adapter?: IndianVendorAdapter;
  calendar?: IndiaHolidayCalendar;
  now?: () => Date;
}

/**
 * IndianMarketProvider: market-status logic is TradeMonk's own (schedule + verified calendar);
 * quotes/candles come only from a plugged-in vendor adapter. With no adapter every data call
 * returns NOT_CONFIGURED ("Data unavailable" in the UI): never a placeholder number.
 */
export class IndianMarketProvider implements MarketDataProvider {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;
  private readonly adapter?: IndianVendorAdapter;
  private readonly calendar: IndiaHolidayCalendar;
  private readonly now: () => Date;

  constructor(opts: IndianMarketProviderOptions = {}) {
    this.adapter = opts.adapter;
    this.calendar = opts.calendar ?? EMPTY_INDIA_CALENDAR;
    this.now = opts.now ?? (() => new Date());
    this.id = opts.adapter ? `indian:${opts.adapter.id}` : "indian:unconfigured";
    this.displayName = opts.adapter ? opts.adapter.displayName : "Indian markets (no data vendor configured)";
    this.capabilities = {
      markets: INDIAN_MARKETS,
      supports: {
        ...NO_CAPABILITIES,
        marketStatus: true,
        quote: opts.adapter?.capabilities.supports.quote ?? false,
        historical: opts.adapter?.capabilities.supports.historical ?? false,
        search: Boolean(opts.adapter?.searchAssets && opts.adapter.capabilities.supports.search),
      },
      timeframes: opts.adapter?.capabilities.timeframes ?? [],
      maxCandlesPerRequest: opts.adapter?.capabilities.maxCandlesPerRequest ?? 0,
    };
  }

  getQuote(asset: AssetRef): Promise<Result<Quote>> {
    if (!INDIAN_MARKETS.includes(asset.market)) return Promise.resolve(unsupported(this.id, "quote"));
    if (!this.adapter) return Promise.resolve(this.missingVendor());
    return this.adapter.getQuote(asset);
  }

  getHistoricalData(req: HistoricalRequest): Promise<Result<CandleSeries>> {
    if (!INDIAN_MARKETS.includes(req.asset.market)) return Promise.resolve(unsupported(this.id, "historical"));
    if (!this.adapter) return Promise.resolve(this.missingVendor());
    return this.adapter.getHistoricalData(req);
  }

  async getMarketStatus(market: Market): Promise<Result<MarketStatus>> {
    if (!INDIAN_MARKETS.includes(market)) return unsupported(this.id, "marketStatus");
    return ok(computeIndiaMarketStatus(market, this.now(), this.calendar, `${this.id}:schedule`));
  }

  async searchAssets(query: string): Promise<Result<AssetSearchHit[]>> {
    if (!this.adapter?.searchAssets) return unsupported(this.id, "search");
    return this.adapter.searchAssets(query);
  }

  private missingVendor<T>(): Result<T> {
    return notConfigured<T>(
      this.id,
      "No licensed Indian market-data vendor is configured (set INDIAN_MARKET_PROVIDER once an adapter exists).",
    );
  }
}
