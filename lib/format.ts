/**
 * Display formatting for market values. Pure. A null/undefined/non-finite input renders as an
 * em dash: formatting never invents a number.
 */
const DASH = "\u2014";

const isNum = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

function decimalsFor(abs: number): number {
  if (abs >= 1000) return 2;
  if (abs >= 1) return 2;
  if (abs >= 0.01) return 4;
  return 6;
}

/** "₹24,350.10" for INR; "67,120.50 USDT" for other quote currencies. */
export function formatPrice(value: number | null | undefined, currency: string): string {
  if (!isNum(value)) return DASH;
  const dp = decimalsFor(Math.abs(value));
  if (currency === "INR") {
    return `\u20B9${new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: dp }).format(value)}`;
  }
  const n = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: dp }).format(value);
  return `${n} ${currency}`;
}

/** Plain number, no currency (levels, indicator values). */
export function formatNumber(value: number | null | undefined, maxDp = 2): string {
  if (!isNum(value)) return DASH;
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: 0, maximumFractionDigits: maxDp }).format(value);
}

/** Signed percentage from a value already in percent units: 1.234 -> "+1.23%". */
export function formatPct(value: number | null | undefined, dp = 2): string {
  if (!isNum(value)) return DASH;
  const s = value.toFixed(dp);
  return `${value > 0 ? "+" : ""}${s}%`;
}

export function formatSigned(value: number | null | undefined, currency: string): string {
  if (!isNum(value)) return DASH;
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${formatPrice(Math.abs(value), currency)}`;
}

/** 1_234_567 -> "1.23M". */
export function formatCompact(value: number | null | undefined): string {
  if (!isNum(value)) return DASH;
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value);
}

export type Tone = "gain" | "loss" | "flat" | "none";

export function toneOf(value: number | null | undefined): Tone {
  if (!isNum(value)) return "none";
  return value > 0 ? "gain" : value < 0 ? "loss" : "flat";
}

export const toneClass: Record<Tone, string> = {
  gain: "text-gain",
  loss: "text-loss",
  flat: "text-fg",
  none: "text-muted",
};
