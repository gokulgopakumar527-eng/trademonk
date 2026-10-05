import "server-only";
import { AppError } from "@/lib/errors";
import { getServerEnv } from "@/lib/env.server";
import { getMarketDataService } from "@/services/market-data";
import { writeAuditLog } from "@/services/audit/audit-service";
import { evaluateDuePredictions, evaluatePrediction, type EvaluationOutcome, type EvaluationRunSummary, type EvaluatorDeps } from "./evaluator";
import { SupabaseEvaluatorStore } from "./evaluator-store";
import { predictionIdSchema } from "./schemas";

/**
 * Production wiring. Market data comes only from getMarketDataService(). There is intentionally no
 * export that accepts a price or a timestamp.
 *
 * Callers must already be trusted: the cron route (CRON_SECRET) or a local script. Nothing in the
 * browser-facing code imports this module.
 */
function deps(): EvaluatorDeps {
  return {
    marketData: getMarketDataService(),
    store: new SupabaseEvaluatorStore(),
    audit: (e) => writeAuditLog(e),
    now: () => new Date(),
    allowMockData: getServerEnv().APP_ENV === "development",
  };
}

/** One scheduler tick over the due predictions. */
export function runPredictionEvaluation(rawInput: unknown): Promise<EvaluationRunSummary> {
  return evaluateDuePredictions(rawInput, deps());
}

/**
 * Evaluate ONE prediction by id, applying every normal rule (it must be an expired engine
 * prediction, and market data must be available). For local/manual testing only; it is not
 * reachable over HTTP.
 */
export async function evaluatePredictionById(rawId: unknown): Promise<EvaluationOutcome> {
  const parsed = predictionIdSchema.safeParse(rawId);
  if (!parsed.success) throw new AppError("VALIDATION", "Invalid prediction");
  const d = deps();
  const prediction = await d.store.getPrediction(parsed.data);
  if (!prediction) return { kind: "SKIPPED", predictionId: parsed.data, reason: "NOT_FOUND" };
  return evaluatePrediction(prediction, d);
}
