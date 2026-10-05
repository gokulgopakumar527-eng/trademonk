import "server-only";
import { getMarketDataService } from "@/services/market-data";
import type { DataView } from "@/services/market-data";
import type { Asset } from "@/services/market-data/types";
import type { Market } from "@/types/domain";
import {
  TIMEFRAMES,
  type CandleSeries,
  type MarketStatus,
  type Quote,
  type Result,
  type Timeframe,
} from "@/types/market";
import { buildRowAnalytics, buildTechnicalView, type RowAnalytics, type TechnicalView } from "./technical";

export const DEFAULT_TIMEFRAME: Timeframe = "1h";

export function parseTimeframe(value: string | string[] | undefined): Timeframe {
  const v = Array.isArray(value) ? value[0] : value;
  return (TIMEFRAMES as readonly string[]).includes(v ?? "") ? (v as Timeframe) : DEFAULT_TIMEFRAME;
}

/** Candle window used for list/watchlist trend + RSI columns. */
const ROW_TIMEFRAME: Timeframe = "1d";
const ROW_CANDLES = 120;
const CHART_CANDLES = 300;

export interface MarketRow {
  asset: Asset;
  quote: DataView<Quote>;
  /** Null when daily candles are unavailable; `analyticsMessage` says why. */
  analytics: RowAnalytics | null;
  analyticsMessage: string | null;
}

export async function loadRow(asset: Asset): Promise<MarketRow> {
  const svc = getMarketDataService();
  const [quote, candles] = await Promise.all([
    svc.getQuote(asset),
    svc.getCandles(asset, ROW_TIMEFRAME, ROW_CANDLES),
  ]);
  if (!candles.ok) return { asset, quote, analytics: null, analyticsMessage: candles.message };
  return { asset, quote, analytics: buildRowAnalytics(candles.data.candles), analyticsMessage: null };
}

export function loadRows(assets: readonly Asset[]): Promise<MarketRow[]> {
  return Promise.all(assets.map(loadRow));
}

export async function loadMarketStatuses(
  markets: readonly Market[],
): Promise<Record<string, Result<MarketStatus>>> {
  const svc = getMarketDataService();
  const entries = await Promise.all(markets.map(async (m) => [m, await svc.getMarketStatus(m)] as const));
  return Object.fromEntries(entries);
}

export interface AssetPageData {
  asset: Asset;
  timeframe: Timeframe;
  quote: DataView<Quote>;
  candles: DataView<CandleSeries>;
  status: Result<MarketStatus>;
  technical: TechnicalView | null;
}

export async function loadAssetPage(asset: Asset, timeframe: Timeframe): Promise<AssetPageData> {
  const svc = getMarketDataService();
  const [quote, candles, status] = await Promise.all([
    svc.getQuote(asset),
    svc.getCandles(asset, timeframe, CHART_CANDLES),
    svc.getMarketStatus(asset.market),
  ]);
  return {
    asset,
    timeframe,
    quote,
    candles,
    status,
    technical: candles.ok ? buildTechnicalView(candles.data.candles, timeframe) : null,
  };
}
