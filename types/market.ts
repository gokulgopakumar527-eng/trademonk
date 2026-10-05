/**
 * Canonical market-data types. Every provider normalises into these shapes; nothing
 * outside services/market-data/providers/* ever sees a vendor-specific payload.
 *
 * Rule: every value the UI can display carries provenance (`source`, `asOf`,
 * `fetchedAt`, `isMock`). There is no "default" number: absence is expressed with Result.
 */
import type { Market } from "@/types/domain";

export const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d", "1w"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export const TIMEFRAME_MS: Record<Timeframe, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
  "1w": 7 * 24 * 60 * 60_000,
};

export type AssetKind = "CRYPTO" | "EQUITY" | "INDEX" | "ETF";

/** What a provider needs to know about an instrument. Vendor symbol mapping happens inside the provider. */
export interface AssetRef {
  market: Market;
  /** Canonical TradeMonk symbol, e.g. "BTC", "NIFTY 50", "RELIANCE". */
  symbol: string;
  /** Quote currency, e.g. "USDT", "INR". */
  currency: string;
  kind: AssetKind;
}

/** Provenance attached to every datum. ISO-8601 UTC strings so they survive JSON. */
export interface DataMeta {
  /** Provider id, e.g. "binance-public". */
  source: string;
  /** When the value was true at the source (exchange/vendor timestamp). */
  asOf: string;
  /** When TradeMonk fetched it. */
  fetchedAt: string;
  /** True only for the development MockProvider. UI must label it "MOCK DATA". */
  isMock: boolean;
}

export interface Quote extends DataMeta {
  market: Market;
  symbol: string;
  currency: string;
  price: number;
  /** 24h (crypto) or session (equities) change; null when the source does not supply it. */
  change: number | null;
  changePct: number | null;
  high: number | null;
  low: number | null;
  /** Base-asset volume; null when unavailable. */
  volume: number | null;
}

export interface Candle {
  /** ISO-8601 UTC open time. */
  openTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  /** False while the candle is still forming. Indicators must ignore unclosed candles by default. */
  closed: boolean;
}

export interface CandleSeries extends DataMeta {
  market: Market;
  symbol: string;
  currency: string;
  timeframe: Timeframe;
  /** Ascending by openTime, no duplicates. */
  candles: Candle[];
}

export type MarketState =
  | "OPEN"
  | "PRE_OPEN"
  | "CLOSED"
  | "HOLIDAY"
  | "ALWAYS_OPEN"
  | "UNKNOWN";

/**
 * How the state was derived. SCHEDULE_ONLY means weekday/time rules with NO verified holiday
 * calendar: the UI must say so instead of asserting "open".
 */
export type MarketStatusBasis = "EXCHANGE_FEED" | "CALENDAR" | "SCHEDULE_ONLY" | "RULE";

export interface MarketStatus extends DataMeta {
  market: Market;
  state: MarketState;
  basis: MarketStatusBasis;
  /** Next scheduled transition (ISO UTC), when known. */
  nextChangeAt: string | null;
  note: string | null;
}

export interface AssetSearchHit {
  market: Market;
  symbol: string;
  name: string;
  kind: AssetKind;
  currency: string;
}

// ── Optional capabilities (interfaces only; no provider implements them yet) ──
export interface OrderBookSnapshot extends DataMeta {
  symbol: string;
  bids: Array<{ price: number; quantity: number }>;
  asks: Array<{ price: number; quantity: number }>;
}
export interface FundingRateSnapshot extends DataMeta {
  symbol: string;
  rate: number;
  nextFundingAt: string | null;
}
export interface OpenInterestSnapshot extends DataMeta {
  symbol: string;
  openInterest: number;
}
export interface NewsHeadline extends DataMeta {
  title: string;
  url: string;
  publisher: string;
  publishedAt: string;
}

// ── Errors & Result ──
export type ProviderErrorCode =
  | "UNSUPPORTED" // provider will never do this (capability absent)
  | "NOT_CONFIGURED" // provider could do it but credentials/adapter are missing
  | "NOT_FOUND" // instrument unknown to the provider
  | "GEO_RESTRICTED" // upstream refuses our egress location (HTTP 451 etc.)
  | "RATE_LIMITED"
  | "AUTH"
  | "TIMEOUT"
  | "UPSTREAM_ERROR"
  | "INVALID_RESPONSE"; // upstream answered but the payload failed validation

export interface ProviderError {
  code: ProviderErrorCode;
  message: string;
  provider: string;
  retryable: boolean;
  retryAfterMs?: number;
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: ProviderError };

export type Capability =
  | "quote"
  | "historical"
  | "marketStatus"
  | "search"
  | "orderBook"
  | "fundingRate"
  | "openInterest"
  | "news";

export interface ProviderCapabilities {
  markets: readonly Market[];
  supports: Readonly<Record<Capability, boolean>>;
  timeframes: readonly Timeframe[];
  /** Max candles per request; used by the service for pagination decisions. */
  maxCandlesPerRequest: number;
}

export interface HistoricalRequest {
  asset: AssetRef;
  timeframe: Timeframe;
  /** Number of candles, most recent first-in-time window. Provider clamps to its max. */
  limit?: number;
  /** Only candles opening before this instant (ISO UTC). */
  endTime?: string;
}
