/**
 * Pure helpers for the Phase 5C-7C-C idempotency checks in the STAGING smoke test. No I/O, no
 * clock, no network, no secrets: everything here is unit-tested offline (tests/staging-smoke-idempotency.test.ts)
 * so the parts of the smoke tooling that decide PASS/FAIL are not themselves unverified.
 *
 * PAPER TRADING — SIMULATION ONLY, NO REAL MONEY.
 */
import { randomUUID } from "node:crypto";

export type Outcome = "PASS" | "FAIL" | "BLOCKED";

export interface CheckRecord {
  id: string;
  name: string;
  outcome: Outcome;
  detail?: string;
}

/**
 * A valid open-trade idempotency key (16-128 chars of A-Z a-z 0-9 . _ -), recognisable as smoke data.
 * One key per trade intent: callers generate a NEW key for every genuinely new open.
 */
export function smokeIdempotencyKey(label: string, random: string = randomUUID()): string {
  const clean = label.replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
  return `smoke-${clean}-${random}`;
}

/** Outcome counts. A check that never ran is simply absent from the list: it is never counted as passed. */
export function tally(checks: ReadonlyArray<Pick<CheckRecord, "outcome">>): {
  passed: number;
  failed: number;
  blocked: number;
} {
  const n = (o: Outcome) => checks.filter((c) => c.outcome === o).length;
  return { passed: n("PASS"), failed: n("FAIL"), blocked: n("BLOCKED") };
}

export function formatTally(t: { passed: number; failed: number; blocked: number }): string {
  return `Passed: ${t.passed}\nFailed: ${t.failed}\nBlocked: ${t.blocked}`;
}

export function formatCheckLine(rec: CheckRecord): string {
  return `[${rec.outcome}] ${rec.id}  ${rec.name}${rec.detail ? `\n         ${rec.detail}` : ""}`;
}

/**
 * True when a message that is meant to be SAFE FOR THE USER still contains database internals:
 * a coded exception, SQLSTATE/PostgREST wording, constraint or index names, or table/column names.
 * The idempotency-conflict message must pass this as "no leak".
 */
export function leaksRawDatabaseText(message: string): boolean {
  return [
    /PAPER_[A-Z_]+/, // coded database exceptions, e.g. PAPER_IDEMPOTENCY_KEY_REUSED
    /\bPGRST\d+/i,
    /sqlstate/i,
    /postgres/i,
    /violates/i,
    /duplicate key/i,
    /unique (constraint|index)/i,
    /\buidx\b|_uidx\b/i,
    /paper_(trades|accounts|trade_results)/i,
    /idempotency_key/i, // the raw column name; the user-facing text says "request"
    /public\./i,
    /\bfunction\b.*\bschema cache\b/i,
  ].some((re) => re.test(message));
}

/**
 * Did calling the REMOVED 15-argument open_paper_trade fail because the function no longer exists
 * (what migration 9 must produce), rather than succeeding or failing inside the function body?
 * PostgREST reports an unknown signature as PGRST202 / "Could not find the function ...".
 * A business error (message containing PAPER_) means a key-less overload survived: that is a FAIL.
 */
export function isLegacySignatureGone(
  error: { message?: string; code?: string } | null | undefined,
): boolean {
  if (!error) return false;
  const message = error.message ?? "";
  if (/PAPER_[A-Z_]+/.test(message)) return false;
  return error.code === "PGRST202" || /could not find the function/i.test(message);
}
