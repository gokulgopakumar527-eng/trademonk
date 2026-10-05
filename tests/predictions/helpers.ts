import type { Candle } from "@/types/market";

export const T0 = Date.UTC(2026, 8, 29, 0, 0, 0);
export const HOUR = 3_600_000;

/** Candles from a close path with a fixed +/- half-range. Ends `count` hours before `end`. */
export function build(closes: number[], opts: { half?: number; endMs?: number; stepMs?: number; forming?: boolean; volume?: number | null } = {}): Candle[] {
  const { half = 1, stepMs = HOUR, forming = false, volume = 100 } = opts;
  const endMs = opts.endMs ?? T0;
  const n = closes.length;
  return closes.map((close, i) => ({
    openTime: new Date(endMs - (n - i) * stepMs).toISOString(),
    open: i === 0 ? close : closes[i - 1]!,
    high: close + half,
    low: close - half,
    close,
    volume,
    closed: forming ? i < n - 1 : true,
  }));
}

/** Zig-zag with drift: waves of 8 candles (up 5, down 3). */
export function zigzag(waves: number, drift: number, start = 100): number[] {
  const out: number[] = [];
  let p = start;
  for (let w = 0; w < waves; w++) {
    for (let i = 0; i < 5; i++) out.push((p += 2 + drift));
    for (let i = 0; i < 3; i++) out.push((p -= 2 - drift / 3));
  }
  return out;
}

export const upCloses = () => zigzag(10, 1.2);
export const downCloses = () => zigzag(10, 1.2).map((p) => 400 - p);
export const flatCloses = () => Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i) * 0.5);
