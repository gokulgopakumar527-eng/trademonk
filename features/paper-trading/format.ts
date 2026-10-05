/**
 * Display formatting for exact decimal STRINGS from the server. PAPER TRADING — SIMULATION ONLY.
 *
 * Pure and string/bigint based: no Number() on money, so no float drift. Display rounding (half-up
 * away from zero) happens only here and never feeds back into any calculation. Missing or
 * unreadable input yields null, never "0": callers must choose words for "unavailable".
 */
const DECIMAL = /^(-)?(\d+)(?:\.(\d+))?$/;

interface Parsed { neg: boolean; int: bigint; frac: string }

function parse(text: string | null | undefined): Parsed | null {
  if (typeof text !== "string") return null;
  const m = DECIMAL.exec(text.trim());
  if (!m) return null;
  return { neg: m[1] === "-", int: BigInt(m[2]!), frac: m[3] ?? "" };
}

/** Rounds to `dp` places (half-up on the magnitude) and returns [integer, fraction, isZero]. */
function round(p: Parsed, dp: number): { int: bigint; frac: string; zero: boolean } {
  const frac = p.frac.padEnd(dp, "0");
  const keep = frac.slice(0, dp);
  const roundUp = (frac.charCodeAt(dp) || 48) >= 53; // next digit >= 5
  let scaled = p.int * 10n ** BigInt(dp) + BigInt(keep || "0") + (roundUp ? 1n : 0n);
  const base = 10n ** BigInt(dp);
  const int = scaled / base;
  scaled -= int * base;
  const out = dp === 0 ? "" : scaled.toString().padStart(dp, "0");
  return { int, frac: out, zero: int === 0n && /^0*$/.test(out) };
}

const group = (n: bigint, locale: string): string => new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(n);

function withCurrency(body: string, currency: string): string {
  return currency === "INR" ? `\u20B9${body}` : `${body} ${currency}`;
}

/** "₹1,000,000.00" / "10,000.00 USDT". `signed` adds an explicit + or - (never on zero). */
export function fmtAmount(
  text: string | null | undefined,
  currency: string,
  opts: { dp?: number; signed?: boolean } = {},
): string | null {
  const p = parse(text);
  if (!p) return null;
  const dp = opts.dp ?? 2;
  const r = round(p, dp);
  const body = `${group(r.int, currency === "INR" ? "en-IN" : "en-US")}${dp ? `.${r.frac}` : ""}`;
  const sign = r.zero ? "" : p.neg ? "-" : opts.signed ? "+" : "";
  return `${sign}${withCurrency(body, currency)}`;
}

/** Prices keep up to 8 places but never fewer than 2: "67,120.50 USDT", "0.00001234 USDT". */
export function fmtPrice(text: string | null | undefined, currency: string): string | null {
  const p = parse(text);
  if (!p) return null;
  const trimmed = p.frac.replace(/0+$/, "");
  const dp = Math.min(8, Math.max(2, trimmed.length));
  return fmtAmount(text, currency, { dp });
}

/** Quantities show every stored place except trailing zeros: "0.5", "10". */
export function fmtQuantity(text: string | null | undefined): string | null {
  const p = parse(text);
  if (!p) return null;
  const frac = p.frac.replace(/0+$/, "");
  return `${group(p.int, "en-US")}${frac ? `.${frac}` : ""}`;
}

export type AmountTone = "gain" | "loss" | "flat" | "none";

export function toneOfAmount(text: string | null | undefined): AmountTone {
  const p = parse(text);
  if (!p) return "none";
  const zero = p.int === 0n && /^0*$/.test(p.frac);
  return zero ? "flat" : p.neg ? "loss" : "gain";
}

/** Fixed zone so server and browser render the same text: "03 Oct 2026, 10:32 IST". */
export function fmtDateTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const s = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(d);
  return `${s.replace(" at ", ", ")} IST`;
}

/** Exact-enough decimal text for a number the server already computed (e.g. an open/close result). Never NaN text. */
export const numberToDecimalText = (n: number | null | undefined): string | null =>
  typeof n === "number" && Number.isFinite(n) && Math.abs(n) < 1e15 ? n.toFixed(8) : null;
