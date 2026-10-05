import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const dir = path.resolve(__dirname, "../supabase/migrations");
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const sql = files.map((f) => readFileSync(path.join(dir, f), "utf8")).join("\n");

const REQUIRED_TABLES = [
  "profiles",
  "assets",
  "asset_metadata",
  "market_quotes",
  "market_candles",
  "watchlists",
  "watchlist_items",
  "predictions",
  "prediction_updates",
  "prediction_results",
  "alerts",
  "alert_events",
  "market_analysis",
  "ai_analysis",
  "news_items",
  "paper_trades",
  "paper_trade_results",
  "subscriptions",
  "subscription_events",
  "notifications",
  "user_preferences",
  "audit_logs",
];

describe("migrations (static checks; behaviour is covered by pnpm test:db)", () => {
  it("are ordered by timestamp prefix", () => {
    expect(files).toEqual([...files].sort());
    expect(files.every((f) => /^\d{14}_/.test(f))).toBe(true);
  });
  it.each(REQUIRED_TABLES)("creates table %s", (t) => {
    expect(sql).toMatch(new RegExp(`create table public\\.${t}\\b`));
  });
  it("never disables RLS", () => {
    expect(sql).not.toMatch(/disable\s+row\s+level\s+security/i);
  });
  it("enables RLS across all public tables", () => {
    expect(sql).toMatch(/enable row level security/);
  });
  it("makes prediction tables append-only", () => {
    for (const t of ["predictions", "prediction_updates", "prediction_results", "audit_logs"]) {
      expect(sql).toContain(`'${t}'`);
    }
    expect(sql).toMatch(/before update or delete/);
    expect(sql).toMatch(/before truncate/);
  });
  it("grants no UPDATE or DELETE on prediction tables to API roles", () => {
    const grants = sql
      .split(";")
      .filter((s) => /grant\s+(update|delete|all)/i.test(s) && /public\.prediction/.test(s));
    expect(grants).toEqual([]);
  });
});
