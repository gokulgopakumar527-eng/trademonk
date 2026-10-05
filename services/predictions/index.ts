import "server-only";
import { getServerEnv } from "@/lib/env.server";
import { getMarketDataService } from "@/services/market-data";
import { writeAuditLog } from "@/services/audit/audit-service";
import { createEnginePrediction } from "./prediction-service";
import { SupabasePredictionStore } from "./supabase-store";
import type { PredictionView } from "./types";

/** Production wiring. The market data comes only from getMarketDataService(). */
export function createPredictionForUser(userId: string, rawInput: unknown): Promise<PredictionView> {
  return createEnginePrediction(userId, rawInput, {
    marketData: getMarketDataService(),
    store: new SupabasePredictionStore(),
    audit: (e) => writeAuditLog(e),
    now: () => new Date(),
    allowMockData: getServerEnv().APP_ENV === "development",
  });
}

export { getMyPrediction, listMyPredictions } from "./read";
export { PredictionRejectedError } from "./errors";
export { runPredictionEvaluation, evaluatePredictionById } from "./evaluator-runtime";
export { OUTCOME_LABEL } from "./evaluation-rules";
