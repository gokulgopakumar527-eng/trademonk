import type { Market } from "@/types/domain";
import type {
  AssetRef,
  AssetSearchHit,
  CandleSeries,
  FundingRateSnapshot,
  HistoricalRequest,
  MarketStatus,
  NewsHeadline,
  OpenInterestSnapshot,
  OrderBookSnapshot,
  ProviderCapabilities,
  Quote,
  Result,
} from "@/types/market";

/**
 * The single contract every vendor adapter implements. Adapters must:
 *  - never throw for expected failures: return a failed Result;
 *  - never invent a value: no data => failed Result;
 *  - stamp every datum with source/asOf/fetchedAt/isMock;
 *  - keep vendor symbols and payload shapes private.
 */
export interface MarketDataProvider {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;

  getQuote(asset: AssetRef): Promise<Result<Quote>>;
  getHistoricalData(req: HistoricalRequest): Promise<Result<CandleSeries>>;
  getMarketStatus(market: Market): Promise<Result<MarketStatus>>;
  searchAssets(query: string): Promise<Result<AssetSearchHit[]>>;

  // Optional capabilities: absent method or capabilities.supports[x] === false => UNSUPPORTED.
  getOrderBook?(asset: AssetRef): Promise<Result<OrderBookSnapshot>>;
  getFundingRate?(asset: AssetRef): Promise<Result<FundingRateSnapshot>>;
  getOpenInterest?(asset: AssetRef): Promise<Result<OpenInterestSnapshot>>;
  getNews?(asset: AssetRef): Promise<Result<NewsHeadline[]>>;
}

export const NO_CAPABILITIES = {
  quote: false,
  historical: false,
  marketStatus: false,
  search: false,
  orderBook: false,
  fundingRate: false,
  openInterest: false,
  news: false,
} as const;
