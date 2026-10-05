import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Static guard on the paper-trading privilege model. Behaviour (real cross-user attempts) is
 * asserted against a live database by `pnpm test:db`; these checks fail fast in plain CI if a
 * migration ever widens the grants or policies.
 */
const MIGRATIONS = path.resolve(__dirname, "../../supabase/migrations");
const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
const sql = files.map((f) => readFileSync(path.join(MIGRATIONS, f), "utf8")).join("\n").replace(/--.*$/gm, "");
const statements = sql.split(";").map((s) => s.replace(/\s+/g, " ").trim());
const touching = (re: RegExp) => statements.filter((s) => re.test(s));

const grants = touching(/^grant\b.*public\.paper_trade/i);
const policies = touching(/^create policy\b.*on public\.paper_trade/i);

describe("paper_trades / paper_trade_results privileges", () => {
  it("starts from zero privileges for API roles, including future tables", () => {
    expect(sql).toMatch(/revoke all on all tables in schema public from anon, authenticated/i);
    expect(sql).toMatch(/alter default privileges in schema public revoke all on tables from anon, authenticated/i);
  });
  it("grants exactly: SELECT on both tables, and UPDATE on stop_loss/take_profit only", () => {
    expect(grants.map((g) => g.toLowerCase())).toEqual([
      "grant select on public.paper_trades to authenticated",
      "grant update (stop_loss, take_profit) on public.paper_trades to authenticated",
      "grant select on public.paper_trade_results to authenticated",
    ]);
  });
  it("never grants INSERT, DELETE, TRUNCATE or ALL, and nothing to anon", () => {
    for (const g of grants) {
      expect(g).not.toMatch(/\b(insert|delete|truncate|all|references|trigger)\b/i);
      expect(g).not.toMatch(/\banon\b|\bpublic\b\s*;?$/i);
    }
  });
  it("no later statement grants on these tables, except the service-role-only open_paper_trade() (5C-2), close_paper_trade() (5C-3) and the 16-argument open_paper_trade() (5C-7C-A) functions", () => {
    const stray = touching(/^grant\b/i).filter((g) => /paper_trade/i.test(g) && !grants.includes(g));
    expect(stray).toHaveLength(3);
    expect(stray[0]).toMatch(/^grant execute on function public\.open_paper_trade\(.*\) to service_role$/i);
    expect(stray[1]).toMatch(/^grant execute on function public\.close_paper_trade\(.*\) to service_role$/i);
    expect(stray[2]).toMatch(/^grant execute on function public\.open_paper_trade\(.*boolean, text \) to service_role$/i);
  });
});

describe("paper_trades / paper_trade_results policies", () => {
  it("defines only owner-scoped SELECT policies plus one owner UPDATE on open trades", () => {
    expect(policies.map((p) => p.match(/^create policy (\w+) on public\.(\w+) for (\w+)/i)!.slice(1).join(" "))).toEqual([
      "paper_trades_select paper_trades select",
      "paper_trades_update paper_trades update",
      "paper_trade_results_select paper_trade_results select",
    ]);
  });
  it("every policy is bound to authenticated and the caller's own user_id", () => {
    for (const p of policies) {
      expect(p).toMatch(/to authenticated/i);
      expect(p).toMatch(/user_id = auth\.uid\(\)/i);
    }
  });
  it("the UPDATE policy only reaches OPEN trades and cannot hand a row to another user", () => {
    const u = policies.find((p) => /paper_trades_update/.test(p))!;
    expect(u).toMatch(/using \(user_id = auth\.uid\(\) and status = 'OPEN'\)/i);
    expect(u).toMatch(/with check \(user_id = auth\.uid\(\)\)/i);
  });
  it("has no INSERT, DELETE or ALL policy, and no admin or public read path", () => {
    for (const p of policies) {
      expect(p).not.toMatch(/for (insert|delete|all)\b/i);
      expect(p).not.toMatch(/is_admin\(\)|using \(true\)|to (anon|public)/i);
    }
  });
  it("RLS is enabled on every public table and never disabled", () => {
    expect(sql).toMatch(/alter table public\.%I enable row level security/i);
    expect(sql).not.toMatch(/disable\s+row\s+level\s+security/i);
    expect(sql).not.toMatch(/drop\s+policy[^;]*paper_trade/i);
  });
});
