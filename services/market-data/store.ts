import type { Candle, CandleSeries, Quote, Timeframe } from "@/types/market";
import type { Asset } from "./types";

/** Persistence port. The Supabase implementation lives in supabase-store.ts; tests use a fake. */
export interface MarketDataStore {
  saveQuote(asset: Asset, quote: Quote): Promise<void>;
  /** Persists CLOSED candles only; forming candles are never stored. */
  saveCandles(asset: Asset, series: CandleSeries): Promise<void>;
  readQuote(asset: Asset): Promise<Quote | null>;
  readCandles(asset: Asset, timeframe: Timeframe, limit: number): Promise<CandleSeries | null>;
}

export const closedOnly = (candles: Candle[]) => candles.filter((c) => c.closed);
