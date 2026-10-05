/**
 * Open-trade idempotency intent. PAPER TRADING — SIMULATION ONLY.
 *
 * One user intent = one stable key. The key is opaque randomness (never derived from, or carrying,
 * any user, price or balance data) and is NOT an authorization mechanism: the server still takes
 * identity from the session and prices every fill itself. The key only lets the database recognise
 * a retry of the SAME intended open (double click, repeated submit, network or server retry) and
 * return the original receipt instead of opening a second trade.
 *
 * Pure and framework-free so the rules are unit-testable; the panel keeps the current intent in a
 * ref, so a re-render never regenerates the key.
 */

/** 16 random bytes -> 32 hex chars: inside the database's 16-128 / [A-Za-z0-9._-] contract. */
export function generateIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (!c?.getRandomValues) throw new Error("Secure random numbers are unavailable");
  const bytes = c.getRandomValues(new Uint8Array(16));
  return `tm-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export interface OpenIntent {
  /** What the user is trying to do. Changing any part of it is a different intent. */
  readonly fingerprint: string;
  readonly key: string;
}

export const openIntentFingerprint = (i: { assetId: string; side: string; quantity: string }): string =>
  JSON.stringify([i.assetId, i.side, i.quantity.trim()]);

/**
 * The same fingerprint keeps the same intent (and key); a different one starts a new intent with a
 * NEW key. `null` (nothing in flight, or the last intent finished) also starts a new one.
 */
export function resolveOpenIntent(
  current: OpenIntent | null,
  fingerprint: string,
  generate: () => string = generateIdempotencyKey,
): OpenIntent {
  return current !== null && current.fingerprint === fingerprint ? current : { fingerprint, key: generate() };
}
