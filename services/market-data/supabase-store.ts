import "server-only";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Candle, CandleSeries, Quote, Timeframe } from "@/types/market";
import { closedOnly, type MarketDataStore } from "./store";
import type { Asset } from "./types";

const CHUNK = 500;

/**
 * Write-through store using the service-role client (market tables are world-readable, writable
 * only by the service role). Server-only: never import from client components.
 */
export class SupabaseMarketDataStore implements MarketDataStore {
  async saveQuote(asset: Asset, q: Quote): Promise<void> {
    const { error } = await createSupabaseAdminClient()
      .from("market_quotes")
      .upsert(
        {
          asset_id: asset.id,
          price: q.price,
          change_pct: q.changePct,
          volume: q.volume,
          source: q.source,
          is_mock: q.isMock,
          as_of: q.asOf,
          fetched_at: q.fetchedAt,
        },
        { onConflict: "asset_id" },
      );
    if (error) throw new Error(`saveQuote: ${error.message}`);
  }

  async saveCandles(asset: Asset, s: CandleSeries): Promise<void> {
    const rows = closedOnly(s.candles).map((c) => ({
      asset_id: asset.id,
      timeframe: s.timeframe,
      open_time: c.openTime,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
      source: s.source,
      is_mock: s.isMock,
    }));
    const db = createSupabaseAdminClient();
    for (let i = 0; i < rows.length; i += CHUNK) {
      const { error } = await db
        .from("market_candles")
        .upsert(rows.slice(i, i + CHUNK), {
          onConflict: "asset_id,timeframe,open_time,source",
          ignoreDuplicates: true,
        });
      if (error) throw new Error(`saveCandles: ${error.message}`);
    }
  }

  async readQuote(asset: Asset): Promise<Quote | null> {
    const { data, error } = await createSupabaseAdminClient()
      .from("market_quotes")
      .select("price, change_pct, volume, source, is_mock, as_of, fetched_at")
      .eq("asset_id", asset.id)
      .maybeSingle();
    if (error) throw new Error(`readQuote: ${error.message}`);
    if (!data) return null;
    return {
      source: data.source,
      asOf: new Date(data.as_of).toISOString(),
      fetchedAt: new Date(data.fetched_at).toISOString(),
      isMock: data.is_mock,
      market: asset.market,
      symbol: asset.symbol,
      currency: asset.currency,
      price: Number(data.price),
      change: null,
      changePct: data.change_pct === null ? null : Number(data.change_pct),
      high: null,
      low: null,
      volume: data.volume === null ? null : Number(data.volume),
    };
  }

  async readCandles(asset: Asset, timeframe: Timeframe, limit: number): Promise<CandleSeries | null> {
    const { data, error } = await createSupabaseAdminClient()
      .from("market_candles")
      .select("open_time, open, high, low, close, volume, source, is_mock")
      .eq("asset_id", asset.id)
      .eq("timeframe", timeframe)
      .order("open_time", { ascending: false })
      .limit(limit);
    if (error) throw new Error(`readCandles: ${error.message}`);
    if (!data || data.length === 0) return null;
    const newest = data[0]!;
    const candles: Candle[] = data
      .filter((r) => r.source === newest.source)
      .reverse()
      .map((r) => ({
        openTime: new Date(r.open_time).toISOString(),
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
        volume: r.volume === null ? null : Number(r.volume),
        closed: true,
      }));
    const last = candles.at(-1)!;
    return {
      source: newest.source,
      // Stored candles are closed: true as of (at latest) their close, approximated by open time.
      asOf: last.openTime,
      fetchedAt: new Date().toISOString(),
      isMock: newest.is_mock,
      market: asset.market,
      symbol: asset.symbol,
      currency: asset.currency,
      timeframe,
      candles,
    };
  }
}
