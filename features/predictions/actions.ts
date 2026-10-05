"use server";

import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { requireUser } from "@/services/profiles/profile-service";
import { createPredictionForUser, PredictionRejectedError } from "@/services/predictions";
import type { CreatePredictionResult } from "./state";

/**
 * Creates an engine-generated prediction for the signed-in user.
 * Accepts only { assetId, timeframe }. The entry price, levels and timestamps are all produced by
 * the server; any extra field is rejected by the strict schema inside the service.
 */
export async function createPredictionAction(input: unknown): Promise<CreatePredictionResult> {
  try {
    const user = await requireUser();
    if (!(await checkRateLimit(RATE_LIMITS.predictionCreate, user.id))) {
      return { ok: false, error: "Too many prediction requests. Try again later.", reason: "RATE_LIMITED" };
    }
    return { ok: true, prediction: await createPredictionForUser(user.id, input) };
  } catch (err) {
    if (err instanceof PredictionRejectedError) return { ok: false, error: err.message, reason: err.reason };
    if (err instanceof AppError) {
      if (err.code === "UNAUTHENTICATED") return { ok: false, error: "Your session has expired. Sign in again." };
      if (err.code === "VALIDATION" || err.code === "NOT_FOUND") return { ok: false, error: err.message };
    }
    logger.error("prediction.action_failed", { error: err });
    return { ok: false, error: "Something went wrong. Try again." };
  }
}
