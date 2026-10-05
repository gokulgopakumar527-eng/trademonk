import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Static guards for Phase 5C-2. Behaviour (real cross-user attempts, atomic rollback, concurrent
 * opens) is asserted against PostgreSQL by `pnpm test:db`; these fail fast in plain CI if the
 * privilege model, the layering or the "no client authority" rules are ever loosened.
 */
const ROOT = path.resolve(__dirname, "../..");
const read = (...p: string[]) => readFileSync(path.join(ROOT, ...p), "utf8");
const stripTs = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const stripSql = (s: string) => s.replace(/--.*$/gm, "");
const stmts = (sql: string) => sql.split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);

const migFile = readdirSync(path.join(ROOT, "supabase/migrations")).find((f) => f.includes("paper_trade_open"))!;
const mig = stripSql(read("supabase/migrations", migFile));
const migStmts = stmts(mig);

describe("migration 7: privileges and RLS", () => {
  it("is ordered after the prediction migrations (later migrations may follow it)", () => {
    const all = readdirSync(path.join(ROOT, "supabase/migrations")).sort();
    const evaluator = all.findIndex((f) => f.includes("prediction_evaluator"));
    expect(all.indexOf(migFile)).toBeGreaterThan(evaluator);
    expect(all.indexOf(migFile)).toBeGreaterThan(-1);
  });
  it("paper_accounts: RLS on, API roles reset to zero, then SELECT only for authenticated", () => {
    expect(mig).toMatch(/alter table public\.paper_accounts enable row level security/i);
    expect(mig).toMatch(/revoke all on public\.paper_accounts from anon, authenticated/i);
    const grants = migStmts.filter((s) => /^grant\b/i.test(s) && /paper_accounts/i.test(s));
    expect(grants).toEqual(["grant select on public.paper_accounts to authenticated"]);
  });
  it("paper_accounts has exactly one policy: owner-scoped SELECT", () => {
    const policies = migStmts.filter((s) => /^create policy\b/i.test(s));
    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatch(/^create policy paper_accounts_select on public\.paper_accounts for select to authenticated using \(user_id = auth\.uid\(\)\)$/i);
  });
  it("grants nothing on paper_trades or paper_trade_results (no client insert, no new column grant)", () => {
    for (const s of migStmts.filter((x) => /^grant\b/i.test(x))) expect(s).not.toMatch(/paper_trades|paper_trade_results/i);
  });
  it("open_paper_trade() is executable by service_role only", () => {
    expect(mig).toMatch(/revoke execute on function public\.open_paper_trade\([^)]*\) from public, anon, authenticated/i);
    const execGrants = migStmts.filter((s) => /^grant execute\b/i.test(s));
    expect(execGrants).toHaveLength(1);
    expect(execGrants[0]).toMatch(/to service_role$/i);
    expect(execGrants[0]).not.toMatch(/anon|authenticated|public,|to public/i);
  });
  it("open_paper_trade() pins its search_path and never disables RLS", () => {
    expect(mig).toMatch(/security definer\s+set search_path = public, pg_temp/i);
    expect(mig).not.toMatch(/disable\s+row\s+level\s+security|force\s+row\s+level\s+security|drop\s+policy|drop\s+trigger/i);
  });
  it("locks the account row, checks cash, debits, then inserts, all in one function", () => {
    const body = mig.slice(mig.indexOf("create function public.open_paper_trade"));
    const order = ["for update", "PAPER_INSUFFICIENT_CASH", "update public.paper_accounts set cash_balance", "insert into public.paper_trades"].map((m) => body.indexOf(m));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
  it("re-derives price and fee itself and rejects NaN/Infinity", () => {
    expect(mig).toMatch(/p_entry_price <> round\(p_reference_price \* \(10000 \+ p_slippage_bps\) \/ 10000, 8\)/);
    expect(mig).toMatch(/p_fee <> round\(v_notional \* p_fee_bps \/ 10000, 8\)/);
    expect(mig).toMatch(/'NaN', 'Infinity', '-Infinity'/);
  });
  it("makes the entry record server-owned and immutable", () => {
    expect(mig).toMatch(/new\.opened_at := now\(\)/);
    expect(mig).toMatch(/create trigger paper_trades_guard_update before update on public\.paper_trades/i);
    expect(mig).toMatch(/create trigger paper_accounts_guard_update before update on public\.paper_accounts/i);
  });
  it("does not implement closing, results or P&L", () => {
    expect(mig).not.toMatch(/insert into public\.paper_trade_results|status\s*=\s*'CLOSED'|\bpnl\b/i);
  });
});

describe("layering and client authority", () => {
  const service = (f: string) => stripTs(read("services/paper-trading", f));
  const action = stripTs(read("features/paper-trading/actions.ts"));

  it("only the supabase store calls the RPC, and it does so with the service-role client", () => {
    const files = readdirSync(path.join(ROOT, "services/paper-trading")).filter((f) => f.endsWith(".ts"));
    for (const f of files) {
      if (f === "supabase-store.ts") continue;
      expect(service(f), f).not.toMatch(/\.rpc\(|createSupabase/);
    }
    const store = service("supabase-store.ts");
    expect(store).toMatch(/createSupabaseAdminClient\(\)\s*\.rpc\("open_paper_trade"/);
    expect(store).toMatch(/createSupabaseAdminClient\(\)\s*\.rpc\("close_paper_trade"/);
    expect(store).not.toMatch(/createSupabaseServerClient|createSupabaseBrowserClient/);
    // Cash only moves inside the RPCs. Phase 5C-4 added a read-only portfolio snapshot, so the store may
    // now READ the account, trade and result tables, but ONLY through select (writes are banned below).
    for (const m of store.matchAll(/\.from\(\s*["']paper_(?:accounts|trades|trade_results)["']\)\s*\.(\w+)\(/g)) expect(m[1]).toBe("select");
    expect(store.match(/\.from\(\s*["']paper_(?:accounts|trades|trade_results)["']\)/g)?.length).toBeGreaterThan(0);
  });
  it("the store never writes a balance or a trade directly", () => {
    expect(service("supabase-store.ts")).not.toMatch(/\.(insert|update|upsert|delete)\(/);
  });
  it("the service never reads the user id, price, fee or time from the client payload", () => {
    const src = service("open-trade.ts");
    expect(src).not.toMatch(/rawInput\./);
    expect(src).not.toMatch(/parsed\.data\.(userId|price|fee|fees|slippage|timestamp|openedAt|cash|balance)/);
    expect(src).toMatch(/const \{ assetId, side, quantity \} = parsed\.data/);
  });
  it("the input schema is strict and names only assetId, side and quantity", () => {
    const schema = service("schemas.ts");
    const block = schema.slice(schema.indexOf("openPaperTradeInputSchema"));
    expect(block).toMatch(/\.strict\(\)/);
    expect(block).toMatch(/assetId:[\s\S]*side:[\s\S]*quantity:/);
    expect(block).not.toMatch(/price|fee|userId|cash|balance|timestamp/i);
  });
  it("no execution code calls a provider, fetch, Binance or an Indian vendor", () => {
    for (const f of ["open-trade.ts", "execution.ts", "money.ts", "paper-trading-service.ts", "ports.ts"]) {
      expect(service(f), f).not.toMatch(/\bfetch\(|binance|providers\/|registry|api\.anthropic|from\s+["']node:https?["']/i);
    }
  });
  it("the open flow reads market data only via the injected facade slice", () => {
    expect(service("open-trade.ts")).toMatch(/deps\.marketData\.getQuote\(asset\)/);
  });
  it("the action authenticates first, rate-limits, then calls the service with the session user id", () => {
    const iUser = action.indexOf("requireUser()");
    const iLimit = action.indexOf("checkRateLimit(RATE_LIMITS.paperTradeOpen, user.id)");
    const iOpen = action.indexOf("openTrade(user.id, input)");
    expect(iUser).toBeGreaterThan(0);
    expect(iLimit).toBeGreaterThan(iUser);
    expect(iOpen).toBeGreaterThan(iLimit);
    expect(action).toMatch(/^"use server";/);
  });
  it("the UI never reaches the service layer, and only ONE component may call the open action (5C-5)", () => {
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(d, e.name)] : []));
    const files = ["app", "components"].flatMap((d) => walk(path.join(ROOT, d)));
    const rel = (fs: string[]) => fs.map((f) => path.relative(ROOT, f)).sort();
    // Stricter than before for the service layer: no page or component may import it at all.
    expect(rel(files.filter((f) => /services\/paper-trading/.test(readFileSync(f, "utf8"))))).toEqual([]);
    expect(rel(files.filter((f) => /openPaperTradeAction/.test(readFileSync(f, "utf8"))))).toEqual(["components/paper-trading/open-trade-panel.tsx"]);
    expect(read("app/(app)/paper-trading/page.tsx")).not.toMatch(/openPaperTradeAction|services\/paper-trading/);
  });
  it("no real-money surface: no broker, exchange-order, deposit, withdrawal or trading-key code", () => {
    const files = [...readdirSync(path.join(ROOT, "services/paper-trading")).map((f) => path.join("services/paper-trading", f)), "features/paper-trading/actions.ts", "config/paper-trading.ts"];
    for (const f of files) expect(stripTs(read(f)), f).not.toMatch(/\b(deposit|withdraw|api[_-]?secret|trading[_-]?key|placeOrder|createOrder|newOrder)\b|\/api\/v3\/order/i);
  });
  it("keeps the simulation-only label on the result and in the action docs", () => {
    expect(read("services/paper-trading/open-trade.ts")).toMatch(/PAPER_TRADING_BANNER/);
    expect(read("features/paper-trading/actions.ts")).toMatch(/PAPER TRADING — SIMULATION ONLY/);
  });
});
