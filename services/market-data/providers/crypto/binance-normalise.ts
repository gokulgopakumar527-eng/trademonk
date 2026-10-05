import type { AssetRef, Candle, CandleSeries, Quote, Timeframe } from "@/types/market";
import type { BinanceTicker24hr } from "./binance-schemas";

export const BINANCE_SOURCE = "binance-public";

/** Canonical -> Binance interval. */
export const BINANCE_INTERVAL: Record<Timeframe, string> = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "1h": "1h",
  "4h": "4h",
  "1d": "1d",
  "1w": "1w",
};

/** BTC + USDT -> BTCUSDT. Characters are validated so nothing odd reaches the URL. */
export function toBinanceSymbol(asset: Pick<AssetRef, "symbol" | "currency">): string | null {
  const base = asset.symbol.trim().toUpperCase();
  const quote = asset.currency.trim().toUpperCase();
  if (!/^[A-Z0-9]{2,12}$/.test(base) || !/^[A-Z0-9]{3,5}$/.test(quote)) return null;
  return `${base}${quote}`;
}

export class NormaliseError extends Error {}

const num = (v: string, field: string): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new NormaliseError(`${field} is not finite`);
  return n;
};

export function normaliseQuote(raw: BinanceTicker24hr, asset: AssetRef, fetchedAt: Date): Quote {
  const price = num(raw.lastPrice, "lastPrice");
  if (price <= 0) throw new NormaliseError("lastPrice must be > 0");
  const high = num(raw.highPrice, "highPrice");
  const low = num(raw.lowPrice, "lowPrice");
  if (high < low) throw new NormaliseError("highPrice < lowPrice");
  return {
    source: BINANCE_SOURCE,
    // 24hr ticker closeTime = time of the last trade contributing to the stats.
    asOf: new Date(raw.closeTime).toISOString(),
    fetchedAt: fetchedAt.toISOString(),
    isMock: false,
    market: asset.market,
    symbol: asset.symbol,
    currency: asset.currency,
    price,
    change: num(raw.priceChange, "priceChange"),
    changePct: num(raw.priceChangePercent, "priceChangePercent"),
    high,
    low,
    volume: num(raw.volume, "volume"),
  };
}

export type KlineRow = [number, string, string, string, string, string, number];

export function normaliseKlines(
  rows: KlineRow[],
  asset: AssetRef,
  timeframe: Timeframe,
  fetchedAt: Date,
): CandleSeries {
  const nowMs = fetchedAt.getTime();
  const closeTimes = new Map<number, number>();
  const candles: Candle[] = [];
  for (const [openTime, o, h, l, c, v, closeTime] of rows) {
    if (closeTimes.has(openTime)) continue; // duplicate open time: keep the first
    closeTimes.set(openTime, closeTime);
    const open = num(o, "open");
    const high = num(h, "high");
    const low = num(l, "low");
    const close = num(c, "close");
    if (open <= 0 || close <= 0 || high < Math.max(open, close, low) || low > Math.min(open, close, high)) {
      throw new NormaliseError(`inconsistent OHLC at ${new Date(openTime).toISOString()}`);
    }
    candles.push({
      openTime: new Date(openTime).toISOString(),
      open,
      high,
      low,
      close,
      volume: num(v, "volume"),
      closed: closeTime < nowMs,
    });
  }
  candles.sort((a, b) => Date.parse(a.openTime) - Date.parse(b.openTime));
  const last = candles.at(-1);
  // A forming candle includes trades up to the fetch; a closed one is true as of its close time.
  const asOfMs =
    last && !last.closed ? nowMs : last ? (closeTimes.get(Date.parse(last.openTime)) ?? nowMs) : nowMs;
  return {
    source: BINANCE_SOURCE,
    asOf: new Date(asOfMs).toISOString(),
    fetchedAt: fetchedAt.toISOString(),
    isMock: false,
    market: asset.market,
    symbol: asset.symbol,
    currency: asset.currency,
    timeframe,
    candles,
  };
}
