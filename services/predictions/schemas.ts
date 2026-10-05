import { z } from "zod";
import { PREDICTION_TIMEFRAMES } from "./engine";

/**
 * Input for engine-generated predictions. `strictObject` REJECTS unknown keys, so a client that
 * sends `entryPrice`, `targetPrice`, `createdAt`, `userId`, `result` and so on gets a validation
 * error instead of having the field silently ignored. Asset ids are UUIDs only, which also
 * excludes `seed:` catalogue ids (those have no database row).
 */
export const createPredictionInputSchema = z.strictObject({
  assetId: z.uuid("Invalid asset"),
  timeframe: z.enum(PREDICTION_TIMEFRAMES, "Unsupported timeframe"),
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
