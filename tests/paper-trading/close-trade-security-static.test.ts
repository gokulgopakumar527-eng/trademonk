import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Static guards for Phase 5C-3. Behaviour (real cross-user attempts, atomic rollback, row-lock
 * serialisation of repeated and concurrent closes) is asserted against PostgreSQL by `pnpm test:db`;
 * these fail fast in plain CI if the privilege model, the layering or the "no client authority"
 * rules are ever loosened.
 */
const ROOT = path.resolve(__dirname, "../..");
const read = (...p: string[]) => readFileSync(path.join(ROOT, ...p), "utf8");
const stripTs = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const stripSql = (s: string) => s.replace(/--.*$/gm, "");
const stmts = (sql: string) => sql.split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);

const all = readdirSync(path.join(ROOT, "supabase/migrations")).sort();
const migFile = all.find((f) => f.includes("paper_trade_close"))!;
const mig = stripSql(read("supabase/migrations", migFile));
const migStmts = stmts(mig);
const fnBody = mig.slice(mig.indexOf("create function public.close_paper_trade"));

describe("migration 8: privileges and RLS", () => {
  it("exists, ordered after the open-trade migration; only the open-idempotency and prediction-idempotency migrations follow it", () => {
    expect(migFile).toBeDefined();
    expect(all.indexOf(migFile)).toBeGreaterThan(all.findIndex((f) => f.endsWith("_paper_trade_open.sql")));
    expect(all.slice(all.indexOf(migFile) + 1).map((f) => f.replace(/^\d+_/, ""))).toEqual(["paper_trade_open_idempotency.sql", "prediction_create_idempotency.sql"]);
  });
  it("close_paper_trade() is executable by service_role only", () => {
    expect(mig).toMatch(/revoke execute on function public\.close_paper_trade\([^)]*\) from public, anon, authenticated/i);
    const execGrants = migStmts.filter((s) => /^grant execute\b/i.test(s));
    expect(execGrants).toHaveLength(1);
    expect(execGrants[0]).toMatch(/^grant execute on function public\.close_paper_trade\(.*\) to service_role$/i);
    expect(execGrants[0]).not.toMatch(/anon|authenticated|public,|to public/i);
  });
  it("grants NOTHING else: no table or column privilege, no new policy, RLS never touched", () => {
    expect(migStmts.filter((s) => /^grant\b/i.test(s) && !/^grant execute\b/i.test(s))).toEqual([]);
    expect(migStmts.filter((s) => /^create policy\b/i.test(s))).toEqual([]);
    expect(mig).not.toMatch(/disable\s+row\s+level\s+security|force\s+row\s+level\s+security|drop\s+policy|drop\s+trigger|drop\s+function|alter\s+policy/i);
    expect(mig).not.toMatch(/grant[^;]*\bto\s+(anon|authenticated|public)\b/i);
  });
  it("close_paper_trade() pins its search_path", () => {
    expect(mig).toMatch(/security definer\s+set search_path = public, pg_temp/i);
  });
  it("only touches the paper-trading tables (no market, prediction or profile data)", () => {
    const tables = [...mig.matchAll(/\b(?:from|into|update|table)\s+public\.(\w+)/gi)].map((m) => m[1]);
    expect(new Set(tables)).toEqual(new Set(["paper_trade_results", "paper_trades", "paper_accounts"]));
  });
});

describe("migration 8: the atomic close", () => {
  it("locks the trade scoped to its owner, checks status, locks the account, credits, writes the result, then closes", () => {
    const order = [
      "where id = p_trade_id and user_id = p_user_id",
      "for update",
      "PAPER_TRADE_NOT_OPEN",
      "PAPER_TRADE_NOT_CLOSABLE",
      "for update;", // the account lock (second occurrence below)
      "update public.paper_accounts set cash_balance",
      "insert into public.paper_trade_results",
      "update public.paper_trades set status = 'CLOSED'",
    ];
    let from = 0;
    for (const m of order) {
      const i = fnBody.indexOf(m, from);
      expect(i, m).toBeGreaterThanOrEqual(0);
      from = i + 1;
    }
    expect(fnBody.match(/for update/gi)).toHaveLength(2); // trade row, then account row
  });
  it("re-derives price, fee and P&L from the LOCKED row and rejects NaN/Infinity", () => {
    expect(fnBody).toMatch(/p_exit_price <> round\(p_reference_price \* \(10000 - p_slippage_bps\) \/ 10000, 8\)/);
    expect(fnBody).toMatch(/v_gross := round\(p_exit_price \* v_trade\.quantity, 8\)/);
    expect(fnBody).toMatch(/p_fee <> round\(v_gross \* p_fee_bps \/ 10000, 8\)/);
    expect(fnBody).toMatch(/v_pnl := v_credit - v_trade\.cash_debited/);
    expect(fnBody).toMatch(/p_pnl <> v_pnl/);
    expect(fnBody).toMatch(/'NaN', 'Infinity', '-Infinity'/);
  });
  it("the sell-side slippage is adverse (price LOWERED) and there is no short, margin or leverage logic", () => {
    expect(fnBody).toMatch(/10000 - p_slippage_bps/);
    expect(fnBody).not.toMatch(/10000 \+ p_slippage_bps/);
    expect(fnBody).toMatch(/side not in \('BUY', 'LONG'\)/);
    expect(mig).not.toMatch(/margin|leverage|borrow|short_/i);
  });
  it("derives the P&L from recorded cost: it never reads a client price, time or P&L as authority", () => {
    expect(fnBody).not.toMatch(/closed_at\s*:=|now\(\)\s*-/); // the timestamp is the trigger's job
    expect(fnBody).toMatch(/v_result public\.paper_trade_results%rowtype/);
  });
  it("makes the result server-owned and immutable, and a closed trade permanently closed", () => {
    expect(mig).toMatch(/new\.closed_at := now\(\)/);
    expect(mig).toMatch(/create trigger paper_trade_results_before_insert before insert on public\.paper_trade_results/i);
    expect(mig).toMatch(/create trigger paper_trade_results_block_update before update on public\.paper_trade_results/i);
    expect(mig).toMatch(/create trigger paper_trades_guard_status before update on public\.paper_trades/i);
    expect(mig).toMatch(/a closed trade cannot be reopened/);
  });
  it("adds provenance as complete-or-absent columns and does not touch the entry columns", () => {
    for (const c of ["account_id", "sim_version", "reference_price", "slippage_bps", "fee_bps", "cash_credited", "quote_source", "quote_as_of", "quote_fetched_at", "quote_is_mock"]) {
      expect(mig).toMatch(new RegExp(`add column ${c}\\b`));
    }
    expect(mig).toMatch(/paper_trade_results_execution_complete/);
    expect(mig).toMatch(/paper_trade_results_execution_only_with_version/);
    expect(mig).not.toMatch(/alter table public\.paper_trades\s+(add|drop|alter)/i); // entry record schema is untouched
  });
  it("fabricates no historical trades or results: its only INSERT is inside close_paper_trade()", () => {
    const inserts = [...mig.matchAll(/insert into/gi)];
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.index!).toBeGreaterThan(mig.indexOf("create function public.close_paper_trade"));
  });
  it("does not implement portfolio analytics (no views, aggregates or reporting functions)", () => {
    expect(mig).not.toMatch(/create\s+(or replace\s+)?(materialized\s+)?view/i);
    expect(mig).not.toMatch(/create function public\.(?!close_paper_trade|paper_trade_results_|paper_trades_guard_status)/i);
    expect(mig).not.toMatch(/\b(sum|avg|count)\s*\(/i);
  });
});

describe("close flow: layering and client authority", () => {
  const service = (f: string) => stripTs(read("services/paper-trading", f));
  const action = stripTs(read("features/paper-trading/actions.ts"));
  const closeSrc = service("close-trade.ts");

  it("only the supabase store reaches the close RPC, and with the service-role client", () => {
    for (const f of readdirSync(path.join(ROOT, "services/paper-trading")).filter((n) => n.endsWith(".ts") && n !== "supabase-store.ts")) {
      expect(service(f), f).not.toMatch(/\.rpc\(|createSupabase/);
    }
    expect(service("supabase-store.ts")).toMatch(/createSupabaseAdminClient\(\)\s*\.rpc\("close_paper_trade"/);
  });
  it("the store's lookup is scoped by BOTH trade id and owner, and never filtered to active assets", () => {
    const store = service("supabase-store.ts");
    const lookup = store.slice(store.indexOf("async getTradeForClose"), store.indexOf("async closeTrade"));
    expect(lookup).toMatch(/\.eq\("id", tradeId\)\s*\.eq\("user_id", userId\)/);
    expect(lookup).toMatch(/quantity::text, cash_debited::text/); // exact decimals, not floats
    expect(lookup).not.toMatch(/is_active/);
  });
  it("the close service reads only { tradeId } from the payload and takes identity from the session", () => {
    expect(closeSrc).not.toMatch(/rawInput\./);
    expect(closeSrc).toMatch(/const \{ tradeId \} = parsed\.data/);
    expect(closeSrc).not.toMatch(/parsed\.data\.(userId|price|exitPrice|fee|fees|pnl|slippage|timestamp|closedAt|cash|balance)/);
    expect(closeSrc).toMatch(/deps\.store\.getTradeForClose\(userId, tradeId\)/);
  });
  it("the close input schema is strict and names only tradeId", () => {
    const schema = service("schemas.ts");
    const block = schema.slice(schema.indexOf("closePaperTradeInputSchema"));
    expect(block).toMatch(/\.strict\(\)/);
    expect(block).toMatch(/tradeId:/);
    expect(block.replace(/closePaperTradeInputSchema[\s\S]*?\.strict\(\)/, "")).not.toMatch(/price|fee|userId|pnl|cash|balance|timestamp/i);
    expect(block.match(/z\s*\.object\(\{[^}]*\}\)/)![0]).not.toMatch(/price|fee|user|pnl|cash|balance|time/i);
  });
  it("the exit rates and version come from the injected centralised config, never literals", () => {
    expect(closeSrc).toMatch(/deps\.config\.markets\[asset\.market\]/);
    expect(closeSrc).toMatch(/deps\.config\.version/);
    expect(closeSrc).not.toMatch(/\b(feeBps|slippageBps|startingCash)\s*[:=]\s*\d/);
    expect(closeSrc).not.toMatch(/PAPER_SIM_V1/);
  });
  it("reads market data only via the injected facade slice, never a provider, fetch or the network", () => {
    expect(closeSrc).toMatch(/deps\.marketData\.getQuote\(asset\)/);
    expect(closeSrc).not.toMatch(/\bfetch\(|binance|providers\/|registry|api\.anthropic|node:https?/i);
  });
  it("performs exactly the quote gates the open flow does (parity guard against drift)", () => {
    const open = service("open-trade.ts");
    for (const gate of [
      "q.data.isMock && !deps.allowMockData", 'q.servedFrom !== "PROVIDER"', 'q.freshness.status === "LAST_CLOSE"', 'q.freshness.status !== "FRESH"',
      "age > deps.limits.maxQuoteAgeMs", "age < -deps.limits.maxQuoteFutureSkewMs",
      "q.data.market !== asset.market || q.data.symbol !== asset.symbol || q.data.currency !== asset.currency",
      "priceToScaled(q.data.price)", "q.data.price > deps.limits.maxPrice",
    ]) {
      expect(open, `open: ${gate}`).toContain(gate);
      expect(closeSrc, `close: ${gate}`).toContain(gate);
    }
  });
  it("audits only after the atomic call, and audit failure is swallowed", () => {
    const iStore = closeSrc.indexOf("deps.store.closeTrade(");
    const iAudit = closeSrc.indexOf("deps.audit(");
    expect(iStore).toBeGreaterThan(0);
    expect(iAudit).toBeGreaterThan(iStore);
    expect(closeSrc.slice(iAudit - 40, iAudit)).toMatch(/await/);
    expect(closeSrc).toMatch(/catch \(error\) \{\s*logger\.error\("paper_trade\.audit_failed"/);
  });
  it("the action authenticates first, rate-limits under its own bucket, then calls the service with the session user id", () => {
    const body = action.slice(action.indexOf("export async function closePaperTradeAction"));
    const iUser = body.indexOf("requireUser()");
    const iLimit = body.indexOf("checkRateLimit(RATE_LIMITS.paperTradeClose, user.id)");
    const iClose = body.indexOf("closeTrade(user.id, input)");
    expect(iUser).toBeGreaterThan(0);
    expect(iLimit).toBeGreaterThan(iUser);
    expect(iClose).toBeGreaterThan(iLimit);
    expect(action).toMatch(/^"use server";/);
    expect(read("lib/rate-limit.ts")).toMatch(/paperTradeClose: \{ action: "paper_trade\.close"/);
  });
  it("the UI never reaches the service layer, and only ONE component may call the close action (5C-5)", () => {
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(d, e.name)] : []));
    const files = ["app", "components"].flatMap((d) => walk(path.join(ROOT, d)));
    const rel = (fs: string[]) =>
  fs.map((f) => path.relative(ROOT, f).replace(/\\/g, "/")).sort();
    expect(rel(files.filter((f) => /services\/paper-trading/.test(readFileSync(f, "utf8"))))).toEqual([]);
    expect(rel(files.filter((f) => /closePaperTradeAction/.test(readFileSync(f, "utf8"))))).toEqual(["components/paper-trading/close-position-button.tsx"]);
  });
  it("no analytics module beyond the read-only portfolio calculation (5C-4), and no real-money surface", () => {
    expect(readdirSync(path.join(ROOT, "services/paper-trading")).filter((f) => /portfolio|analytics|performance|summary/i.test(f))).toEqual(["portfolio.ts"]);
    expect(closeSrc).not.toMatch(/\b(deposit|withdraw|api[_-]?secret|trading[_-]?key|placeOrder|createOrder|newOrder)\b/i);
  });
  it("keeps the simulation-only label", () => {
    expect(read("services/paper-trading/close-trade.ts")).toMatch(/PAPER_TRADING_BANNER/);
    expect(read("features/paper-trading/actions.ts")).toMatch(/PAPER TRADING — SIMULATION ONLY/);
  });
});
