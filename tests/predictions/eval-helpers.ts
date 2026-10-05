import type { Candle } from "@/types/market";

export const HOUR = 3_600_000;
export const iso = (ms: number) => new Date(ms).toISOString();

/** Hourly candle series (high 101 / low 99 around 100) with per-open-time overrides. */
export const START = Date.parse("2026-09-27T19:00:00.000Z");

export function flatHourly(
  tweak: Record<string, Partial<Candle>> = {},
  opts: { skip?: string[]; endOpen?: string; forming?: string } = {},
): Candle[] {
  const end = Date.parse(opts.endOpen ?? "2026-09-29T00:00:00.000Z");
  const out: Candle[] = [];
  for (let t = START; t <= end; t += HOUR) {
    const openTime = iso(t);
    if (opts.skip?.includes(openTime)) continue;
    out.push({
      openTime,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 1,
      closed: openTime !== opts.forming,
      ...tweak[openTime],
    });
  }
  return out;
}
