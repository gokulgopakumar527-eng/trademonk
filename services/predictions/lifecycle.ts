/**
 * Prediction lifecycle, DERIVED from immutable facts. There is no mutable status column.
 *
 *   CREATED    the state returned by the creation call itself
 *   ACTIVE     any later read while now < expires_at
 *   EXPIRED    now >= expires_at and no result row exists yet (the horizon has passed)
 *   EVALUATED  a prediction_results row exists (written by the Phase 5B evaluator)
 *
 * EXPIRED only means the horizon elapsed. EVALUATED means an immutable result exists; the result
 * itself (WIN / INVALIDATED / EXPIRED) lives in prediction_results, never on the prediction.
 */
export const PREDICTION_LIFECYCLE = ["CREATED", "ACTIVE", "EXPIRED", "EVALUATED"] as const;
export type PredictionLifecycle = (typeof PREDICTION_LIFECYCLE)[number];

export function derivePredictionLifecycle(
  p: { createdAt: string; expiresAt: string },
  now: Date,
  opts: { justCreated?: boolean; evaluated?: boolean } = {},
): PredictionLifecycle {
  const created = new Date(p.createdAt).getTime();
  const expires = new Date(p.expiresAt).getTime();
  if (Number.isNaN(created) || Number.isNaN(expires) || expires <= created) {
    throw new RangeError("Invalid prediction timestamps");
  }
  // A result can only exist after expiry (the database enforces it), so EVALUATED is final.
  if (opts.evaluated) return "EVALUATED";
  if (now.getTime() >= expires) return "EXPIRED";
  return opts.justCreated ? "CREATED" : "ACTIVE";
}
