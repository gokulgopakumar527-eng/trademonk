import { TIMEFRAME_MS, type CandleSeries, type DataMeta, type MarketState } from "@/types/market";

export type FreshnessStatus =
  /** Within the allowed age. */
  | "FRESH"
  /** Older than allowed while the market is (or may be) trading: do not present as live. */
  | "STALE"
  /** Market closed: the value is the last close, age is expected. */
  | "LAST_CLOSE";

export interface Freshness {
  status: FreshnessStatus;
  ageMs: number;
  /** "Data updated 10:32 IST" or "... (stale)" etc. Ready for display. */
  label: string;
}

export const DEFAULT_QUOTE_MAX_AGE_MS = 2 * 60_000;

/** Short zone label. Asia/Kolkata is always "IST"; others use Intl's short name. */
export function zoneLabel(timeZone: string, at: Date): string {
  if (timeZone === "Asia/Kolkata") return "IST";
  const part = new Intl.DateTimeFormat("en-GB", { timeZone, timeZoneName: "short" })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName");
  return part?.value ?? timeZone;
}

export function formatClock(iso: string, timeZone = "Asia/Kolkata"): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "unknown time";
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(at);
  return `${time} ${zoneLabel(timeZone, at)}`;
}

/**
 * Assess how fresh a datum is. `marketState` lets closed markets show "last close" instead of
 * falsely alarming (or worse, pretending a weekend quote is live).
 */
export function assessFreshness(
  meta: Pick<DataMeta, "asOf" | "isMock">,
  opts: { now?: Date; maxAgeMs?: number; marketState?: MarketState; timeZone?: string } = {},
): Freshness {
  const now = opts.now ?? new Date();
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_QUOTE_MAX_AGE_MS;
  const asOf = new Date(meta.asOf).getTime();
  const ageMs = Number.isNaN(asOf) ? Number.POSITIVE_INFINITY : Math.max(0, now.getTime() - asOf);
  const clock = formatClock(meta.asOf, opts.timeZone);
  const prefix = meta.isMock ? "MOCK DATA · " : "";

  const closed = opts.marketState === "CLOSED" || opts.marketState === "HOLIDAY";
  if (closed) {
    return { status: "LAST_CLOSE", ageMs, label: `${prefix}Market closed · data as of ${clock}` };
  }
  if (ageMs > maxAgeMs) {
    return { status: "STALE", ageMs, label: `${prefix}Stale · data as of ${clock}` };
  }
  return { status: "FRESH", ageMs, label: `${prefix}Data updated ${clock}` };
}

/**
 * Candle series are stale when the newest candle opened more than two timeframes ago
 * (a continuously-trading market should always have a candle within one timeframe).
 */
export function seriesMaxAgeMs(series: Pick<CandleSeries, "timeframe">): number {
  return 2 * TIMEFRAME_MS[series.timeframe];
}

export function assessSeriesFreshness(
  series: CandleSeries,
  opts: { now?: Date; marketState?: MarketState; timeZone?: string } = {},
): Freshness {
  const now = opts.now ?? new Date();
  const last = series.candles.at(-1);
  if (!last) {
    return { status: "STALE", ageMs: Number.POSITIVE_INFINITY, label: "No candles available" };
  }
  const lastOpen = new Date(last.openTime).getTime();
  const ageSinceOpen = Math.max(0, now.getTime() - lastOpen);
  const tf = TIMEFRAME_MS[series.timeframe];
  // Use the later of "last candle open" and the series' own asOf for the label.
  const meta = { asOf: series.asOf, isMock: series.isMock };
  const base = assessFreshness(meta, {
    now,
    maxAgeMs: 2 * tf,
    marketState: opts.marketState,
    timeZone: opts.timeZone,
  });
  if (base.status === "LAST_CLOSE") return base;
  // asOf can be "fetch time" for a forming candle; also require the newest candle to be recent.
  if (ageSinceOpen > 2 * tf) {
    const prefix = series.isMock ? "MOCK DATA · " : "";
    return {
      status: "STALE",
      ageMs: base.ageMs,
      label: `${prefix}Stale · data as of ${formatClock(series.asOf, opts.timeZone)}`,
    };
  }
  return base;
}
