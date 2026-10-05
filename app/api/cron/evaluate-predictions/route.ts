import { NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/cron-auth";
import { getServerEnv } from "@/lib/env.server";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { runPredictionEvaluation } from "@/services/predictions/evaluator-runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Trusted-scheduler entry point for the prediction evaluator (Vercel Cron / Supabase scheduler).
 *
 * - Requires `Authorization: Bearer <CRON_SECRET>`. With no CRON_SECRET configured the route
 *   refuses to run (503) instead of running open.
 * - Accepts only `?limit=` (1..100). It cannot be told WHICH prediction to evaluate, nor at what
 *   price or time: the evaluator discovers due predictions itself and prices them server-side.
 * - Not session-protected by design (a scheduler has no session); the secret is the gate.
 */
async function handle(request: Request): Promise<NextResponse> {
  const secret = getServerEnv().CRON_SECRET;
  if (!secret) {
    logger.error("cron.evaluate_predictions.not_configured", {});
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }
  if (!isAuthorizedCronRequest(request.headers.get("authorization"), secret)) {
    logger.warn("cron.evaluate_predictions.unauthorized", {});
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const params = Object.fromEntries(new URL(request.url).searchParams);
  if (!(await checkRateLimit(RATE_LIMITS.predictionEvaluate, "cron:evaluate-predictions"))) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  try {
    const summary = await runPredictionEvaluation(params);
    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    if (error instanceof AppError && error.code === "VALIDATION") {
      return NextResponse.json({ error: "invalid_request", message: error.message }, { status: 400 });
    }
    logger.error("cron.evaluate_predictions.failed", { error });
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
