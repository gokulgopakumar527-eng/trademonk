import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Checks a scheduler's `Authorization` header against CRON_SECRET.
 *
 * - Fails CLOSED: no configured secret, or no header, is never authorised.
 * - Constant-time: both sides are hashed to equal length first, so neither the comparison time
 *   nor `timingSafeEqual`'s equal-length requirement leaks anything about the secret.
 * - Bearer scheme only. The secret is never accepted in a query string (URLs end up in logs).
 */
export function isAuthorizedCronRequest(authorization: string | null, secret: string | undefined): boolean {
  if (!secret || !authorization) return false;
  const digest = (v: string) => createHash("sha256").update(v).digest();
  return timingSafeEqual(digest(authorization), digest(`Bearer ${secret}`));
}
