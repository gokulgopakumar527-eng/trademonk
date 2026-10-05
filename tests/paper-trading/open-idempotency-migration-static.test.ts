import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Static guards for migration 9 (Phase 5C-7C-A). Behaviour (replay, concurrent duplicates, rollback,
 * privileges) is asserted against real PostgreSQL by `pnpm test:db`; these fail fast in plain CI if
 * the idempotency guarantees or the privilege model are ever loosened.
 */
const ROOT = path.resolve(__dirname, "../..");
const all = readdirSync(path.join(ROOT, "supabase/migrations")).sort();
const migFile = all.find((f) => f.endsWith("_paper_trade_open_idempotency.sql"))!;
const raw = readFileSync(path.join(ROOT, "supabase/migrations", migFile), "utf8");
const mig = raw.replace(/--.*$/gm, "");
const stmts = mig.split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
const fn = mig.slice(mig.indexOf("create function public.open_paper_trade"));

describe("migration 9: open-trade idempotency", () => {
  it("exists and is ordered after the close migration", () => {
    expect(migFile).toBeDefined();
    expect(all.indexOf(migFile)).toBeGreaterThan(all.findIndex((f) => f.includes("paper_trade_close")));
  });
  it("adds a NULLABLE key (old rows stay valid) with a format check, and a paired receipt balance", () => {
    expect(mig).toMatch(/add column idempotency_key text,/i);
    expect(mig).not.toMatch(/idempotency_key text not null/i);
    expect(mig).toMatch(/char_length\(idempotency_key\) between 16 and 128 and idempotency_key ~ '\^\[A-Za-z0-9\._-\]\+\$'/);
    expect(mig).toMatch(/\(idempotency_key is null\) = \(cash_balance_after is null\)/);
  });
  it("enforces an owner-scoped, partial unique index (not global, not price/symbol/quantity based)", () => {
    expect(mig).toMatch(
      /create unique index paper_trades_user_idempotency_key_uidx\s+on public\.paper_trades \(user_id, idempotency_key\)\s+where idempotency_key is not null/i,
    );
  });
  it("makes both new columns immutable in the update guard", () => {
    const guard = mig.slice(mig.indexOf("create or replace function public.paper_trades_guard_update"));
    expect(guard).toMatch(/new\.idempotency_key is distinct from old\.idempotency_key/);
    expect(guard).toMatch(/new\.cash_balance_after is distinct from old\.cash_balance_after/);
  });
  it("drops the 15-argument open and creates only a 16-argument one with a required key", () => {
    expect(stmts.some((s) => /^drop function public\.open_paper_trade\( uuid, uuid, text, numeric, numeric, numeric, numeric, text, numeric, numeric, numeric, text, timestamptz, timestamptz, boolean \)$/i.test(s))).toBe(true);
    expect(stmts.filter((s) => /^create function public\.open_paper_trade/i.test(s))).toHaveLength(1);
    expect(fn).toMatch(/p_quote_is_mock boolean,\s+p_idempotency_key text\s+\) returns jsonb/);
    expect(fn).toMatch(/p_idempotency_key is null/);
    expect(mig).toMatch(/expected exactly one open_paper_trade overload/);
  });
  it("is executable by service_role only", () => {
    const sig = "uuid, uuid, text, numeric, numeric, numeric, numeric, text, numeric, numeric, numeric, text, timestamptz, timestamptz, boolean, text";
    expect(stmts).toContain(`revoke execute on function public.open_paper_trade( ${sig} ) from public, anon, authenticated`);
    const grants = stmts.filter((s) => /^grant\b/i.test(s));
    expect(grants).toEqual([`grant execute on function public.open_paper_trade( ${sig} ) to service_role`]);
  });
  it("pins search_path, and never disables RLS or touches policies, grants or old triggers", () => {
    expect(fn).toMatch(/security definer\s+set search_path = public, pg_temp/i);
    expect(mig).not.toMatch(/disable\s+row\s+level\s+security|force\s+row\s+level\s+security|drop\s+policy|drop\s+trigger|alter\s+table[^;]*\bdrop\b/i);
    expect(stmts.filter((s) => /^grant\b/i.test(s) && /paper_trades|paper_accounts|paper_trade_results/i.test(s) && !/execute on function/i.test(s))).toEqual([]);
  });
  it("serialises by (user, key), then looks the key up BEFORE the cash check, debit and insert", () => {
    const order = [
      "pg_advisory_xact_lock",
      "idempotency_key = p_idempotency_key",
      "PAPER_IDEMPOTENCY_KEY_REUSED",
      "for update",
      "PAPER_INSUFFICIENT_CASH",
      "update public.paper_accounts set cash_balance",
      "insert into public.paper_trades",
    ].map((m) => fn.indexOf(m));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
  it("does not compare price for key reuse (a retry legitimately re-quotes)", () => {
    const reuse = fn.slice(fn.indexOf("if v_existing.asset_id"), fn.indexOf("PAPER_IDEMPOTENCY_KEY_REUSED"));
    expect(reuse).toMatch(/asset_id/);
    expect(reuse).toMatch(/side/);
    expect(reuse).toMatch(/quantity/);
    expect(reuse).not.toMatch(/entry_price|reference_price|fees/);
  });
  it("replays return before any balance mutation, flagged replayed = true", () => {
    const upToDebit = fn.slice(0, fn.indexOf("update public.paper_accounts set cash_balance"));
    expect(upToDebit).toMatch(/'replayed', true/);
    expect(fn.slice(fn.indexOf("update public.paper_accounts set cash_balance"))).toMatch(/'replayed', false/);
  });
  it("re-derives price and fee itself and rejects NaN/Infinity (migration 7 rules preserved)", () => {
    expect(fn).toMatch(/p_entry_price <> round\(p_reference_price \* \(10000 \+ p_slippage_bps\) \/ 10000, 8\)/);
    expect(fn).toMatch(/p_fee <> round\(v_notional \* p_fee_bps \/ 10000, 8\)/);
    expect(fn).toMatch(/numbers must be finite/);
  });
});
