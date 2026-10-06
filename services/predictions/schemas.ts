import { z } from "zod";
import { PREDICTION_TIMEFRAMES } from "./engine";

/**
 * One user intent = one idempotency key. Opaque, client-generated randomness: it identifies a retry
 * of the SAME intended prediction and is never an authorization mechanism. The format matches the
 * `predictions_idempotency_key_format` database CHECK exactly (16-128 chars of A-Z a-z 0-9 . _ -).
 * The value is validated as-is: it is never trimmed, lower-cased or otherwise normalised, so what
 * the client sends is what would be stored and compared.
 */
export const PREDICTION_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._-]+$/;
export const predictionIdempotencyKeySchema = z
  .string("A request key is required")
  .min(16, "Invalid request key")
  .max(128, "Invalid request key")
  .regex(PREDICTION_IDEMPOTENCY_KEY_PATTERN, "Invalid request key");

/**
 * Input for engine-generated predictions. `strictObject` REJECTS unknown keys, so a client that
 * sends `entryPrice`, `targetPrice`, `createdAt`, `userId`, `result` and so on gets a validation
 * error instead of having the field silently ignored. Asset ids are UUIDs only, which also
 * excludes `seed:` catalogue ids (those have no database row). `idempotencyKey` is REQUIRED: every
 * persisted engine prediction is created for exactly one client intent.
 */
export const createPredictionInputSchema = z.strictObject({
  assetId: z.uuid("Invalid asset"),
  timeframe: z.enum(PREDICTION_TIMEFRAMES, "Unsupported timeframe"),
  idempotencyKey: predictionIdempotencyKeySchema,
});
export type CreatePredictionInput = z.infer<typeof createPredictionInputSchema>;

export const predictionIdSchema = z.uuid("Invalid prediction");

/**
 * Input for one evaluator run. Deliberately has NO prediction id, price or timestamp: a caller can
 * only say how many due predictions to process, never which prediction or at what price.
 * `strictObject` rejects unknown keys instead of ignoring them.
 */
export const evaluationRunInputSchema = z.strictObject({
  limit: z.coerce.number().int("limit must be a whole number").min(1).max(100).default(25),
});
export type EvaluationRunInput = z.infer<typeof evaluationRunInputSchema>;
