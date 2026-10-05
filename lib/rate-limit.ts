import "server-only";
import { createHash } from "node:crypto";
import { headers } from "next/headers";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getServerEnv } from "@/lib/env.server";
import { logger } from "@/lib/logger";

export interface RateLimitRule {
  action: string;
  limit: number;
  windowSeconds: number;
}

/** Hash the identifier so raw IPs/emails are not stored in the rate_limits table. */
export function buildRateLimitKey(action: string, identifier: string): string {
  return `${action}:${createHash("sha256").update(identifier).digest("hex").slice(0, 32)}`;
}

export function clientIdFromHeaders(h: Headers): string {
  const forwarded = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || h.get("x-real-ip") || "unknown";
}

export type RateLimitFailureMode = "open" | "closed";

/**
 * What to do when the limiter's backing store cannot be consulted. ONLY an explicit `development`
 * fails open (so local work does not need the rate_limits migration). Everything else, including an
 * undefined or unrecognised value, fails closed.
 */
export function rateLimitFailureMode(appEnv: string | undefined): RateLimitFailureMode {
  return appEnv === "development" ? "open" : "closed";
}

/** Never throws: if the environment itself cannot be resolved, the answer is "closed". */
function resolveFailureMode(): RateLimitFailureMode {
  try {
    return rateLimitFailureMode(getServerEnv().APP_ENV);
  } catch {
    return "closed";
  }
}

/**
 * Postgres-backed fixed-window limiter (see check_rate_limit() in migration 3).
 * Fails CLOSED unless APP_ENV is explicitly `development`, so an outage or a misconfigured
 * environment cannot silently disable protection. Anything other than a literal `true` from the
 * store is a denial.
 */
export async function checkRateLimit(rule: RateLimitRule, identifier?: string): Promise<boolean> {
  const id = identifier ?? clientIdFromHeaders(await headers());
  const key = buildRateLimitKey(rule.action, id);
  try {
    const { data, error } = await createSupabaseAdminClient().rpc("check_rate_limit", {
      p_key: key,
      p_limit: rule.limit,
      p_window_seconds: rule.windowSeconds,
    });
    if (error) throw error;
    return data === true;
  } catch (err) {
    const mode = resolveFailureMode();
    logger.error("rate_limit.check_failed", { action: rule.action, failMode: mode, error: err });
    return mode === "open";
  }
}

export const RATE_LIMITS = {
  signIn: { action: "auth.sign_in", limit: 10, windowSeconds: 600 },
  signUp: { action: "auth.sign_up", limit: 5, windowSeconds: 3600 },
  magicLink: { action: "auth.magic_link", limit: 5, windowSeconds: 3600 },
  watchlistWrite: { action: "watchlist.write", limit: 60, windowSeconds: 600 },
  predictionCreate: { action: "prediction.create", limit: 20, windowSeconds: 3600 },
  paperTradeOpen: { action: "paper_trade.open", limit: 60, windowSeconds: 3600 },
  paperTradeClose: { action: "paper_trade.close", limit: 60, windowSeconds: 3600 },
  /** Read-only cost estimates still reach the market-data facade, so they are bounded too. */
  paperTradePreview: { action: "paper_trade.preview", limit: 120, windowSeconds: 600 },
  /** Scheduler runs, not user actions: a generous ceiling that still stops a runaway cron loop. */
  predictionEvaluate: { action: "prediction.evaluate", limit: 60, windowSeconds: 3600 },
} satisfies Record<string, RateLimitRule>;
