/**
 * Deterministic fixed-point money for paper trading. PAPER TRADING — NO REAL MONEY.
 *
 * Every amount is a bigint count of 1e-8 units, so there is no floating-point drift. Rounding is
 * always half-up and happens in exactly the places the database re-derives (migration 7), so the
 * server and the database can never disagree about a cent. Pure: no I/O, no clock.
 */
export const SCALE_DIGITS = 8;
export const SCALE = 10n ** BigInt(SCALE_DIGITS);

/** An amount in units of 1e-8. */
export type Scaled = bigint;

/** Round-half-up of (value * num / den) for non-negative inputs. */
export function mulDivRoundHalfUp(value: bigint, num: bigint, den: bigint): bigint {
  if (value < 0n || num < 0n || den <= 0n) throw new RangeError("mulDivRoundHalfUp expects non-negative operands");
  return (2n * value * num + den) / (2n * den);
}

/** Exact decimal string with exactly 8 decimal places, e.g. 123_45000000n -> "123.45000000". */
export function formatScaled(s: Scaled): string {
  if (s < 0n) throw new RangeError("negative amounts are not representable here");
  const whole = s / SCALE;
  const frac = (s % SCALE).toString().padStart(SCALE_DIGITS, "0");
  return `${whole}.${frac}`;
}

export function scaledToNumber(s: Scaled): number {
  return Number(formatScaled(s));
}

/** Like formatScaled but for amounts that may be negative (realized P&L), e.g. -19_36999000n -> "-19.36999000". */
export function formatSignedScaled(s: Scaled): string {
  return s < 0n ? `-${formatScaled(-s)}` : formatScaled(s);
}

export function signedScaledToNumber(s: Scaled): number {
  return Number(formatSignedScaled(s));
}

const DECIMAL = /^(\d{1,12})(?:\.(\d{1,8}))?$/;

function fromDecimalString(text: string): Scaled | null {
  const m = DECIMAL.exec(text);
  if (!m) return null;
  return BigInt(m[1]!) * SCALE + BigInt((m[2] ?? "").padEnd(SCALE_DIGITS, "0"));
}

/**
 * Parses a non-negative exact decimal string read back from the database (e.g. a recorded cost).
 * Returns null for anything else, including floats' exponent form, so a bad read fails safe.
 */
export function parseDecimalAmount(text: unknown): Scaled | null {
  return typeof text === "string" ? fromDecimalString(text.trim()) : null;
}

/**
 * Like parseDecimalAmount but accepts one optional leading "-" (a realized P&L read back from the
 * database as text). Anything else, including "+", exponent form or a bare "-0", is rejected.
 */
export function parseSignedDecimalAmount(text: unknown): Scaled | null {
  if (typeof text !== "string") return null;
  const t = text.trim();
  if (!t.startsWith("-")) return fromDecimalString(t);
  const magnitude = fromDecimalString(t.slice(1));
  return magnitude === null ? null : -magnitude;
}

/**
 * Parses a user-supplied quantity. Accepts a finite number or a plain decimal string with at most
 * 8 decimal places. More precision is REJECTED, never silently rounded, so the stored quantity is
 * exactly what the user typed. Returns null when invalid or not strictly positive.
 */
export function parseQuantity(value: unknown): Scaled | null {
  let scaled: Scaled | null = null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0 || value >= 1e12) return null;
    const fixed = value.toFixed(SCALE_DIGITS);
    if (Number(fixed) !== value) return null; // more than 8 decimals of precision
    scaled = fromDecimalString(fixed);
  } else if (typeof value === "string") {
    scaled = fromDecimalString(value.trim());
  }
  return scaled !== null && scaled > 0n ? scaled : null;
}

/**
 * Normalises a provider price (a float) to the 8-dp grid. Returns null when it is not a finite,
 * strictly positive number or is absurdly large. The only place a float enters the arithmetic.
 */
export function priceToScaled(price: unknown): Scaled | null {
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0 || price >= 1e12) return null;
  const scaled = fromDecimalString(price.toFixed(SCALE_DIGITS));
  return scaled !== null && scaled > 0n ? scaled : null;
}

/** A basis-point rate as an integer number of milli-bps (1 bp = 1000). Rates are config numbers. */
export function toMilliBps(bps: number): bigint {
  if (!Number.isFinite(bps) || bps < 0) throw new RangeError("basis points must be a non-negative finite number");
  return BigInt(Math.round(bps * 1000));
}

export const MILLI_BPS_DENOMINATOR = 10_000_000n; // 10_000 bps per unit * 1000 milli

/** The rate actually applied after rounding to milli-bps, as a decimal string (3 dp). */
export function formatMilliBps(milli: bigint): string {
  return `${milli / 1000n}.${(milli % 1000n).toString().padStart(3, "0")}`;
}
