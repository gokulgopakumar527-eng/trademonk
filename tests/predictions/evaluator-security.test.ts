import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isAuthorizedCronRequest } from "@/lib/cron-auth";

const ROOT = path.resolve(__dirname, "../..");
const read = (...p: string[]) => readFileSync(path.join(ROOT, ...p), "utf8");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const f = path.join(dir, n);
    return statSync(f).isDirectory() ? walk(f) : /\.tsx?$/.test(n) ? [f] : [];
  });
const rel = (f: string) => path.relative(ROOT, f);
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const stripSql = (s: string) => s.replace(/--.*$/gm, "");

const migrations = readdirSync(path.join(ROOT, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
const m6File = migrations.find((f) => f.includes("prediction_evaluator"))!;
const m6 = stripSql(read("supabase/migrations", m6File));

describe("migration 6 keeps the security model intact", () => {
  it("no later migration touches the prediction tables, their RLS or their append-only triggers", () => {
    const later = migrations.slice(migrations.indexOf(m6File) + 1);
    for (const f of later) {
      const sql = stripSql(read("supabase/migrations", f));
      expect(sql, f).not.toMatch(/public\.prediction/i);
      expect(sql, f).not.toMatch(/prevent_mutation|disable\s+row\s+level\s+security/i);
    }
  });
  it("grants nothing to API roles: only service_role may call the discovery function", () => {
    const grants = m6.split(";").filter((s) => /\bgrant\b/i.test(s));
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatch(/grant execute on function public\.predictions_due_for_evaluation/i);
    expect(grants[0]).toMatch(/to service_role/i);
    expect(grants[0]).not.toMatch(/anon|authenticated/i);
    expect(m6).toMatch(/revoke execute on function public\.predictions_due_for_evaluation\(integer, integer\) from public, anon, authenticated/i);
  });
  it("does not touch RLS, policies, append-only triggers or the predictions table", () => {
    expect(m6).not.toMatch(/disable\s+row\s+level\s+security|create\s+policy|drop\s+policy|drop\s+trigger|disable\s+trigger|prevent_mutation/i);
    expect(m6).not.toMatch(/alter\s+table\s+public\.predictions\b/i);
    expect(m6).not.toMatch(/\b(update|delete)\s+(from\s+)?public\./i);
  });
  it("the result trigger owns the timestamps and the hash, and enforces eligibility", () => {
    expect(m6).toMatch(/new\.created_at := now\(\)/);
    expect(m6).toMatch(/new\.closed_at := now\(\)/);
    expect(m6).toMatch(/new\.content_hash := /);
    expect(m6).toMatch(/engine_version is null/);
    expect(m6).toMatch(/now\(\) < p\.expires_at/);
    expect(m6).toMatch(/p\.content_hash/);
  });
  it("stores no UNAVAILABLE status (it would block the real evaluation)", () => {
    expect(m6).not.toMatch(/alter type|add value/i);
    expect(read("supabase/migrations", m6File)).toMatch(/UNAVAILABLE" is not a stored status/);
  });
});

describe("evaluator sources", () => {
  const files = walk(path.join(ROOT, "services/predictions"));
  const evaluator = strip(read("services/predictions/evaluator.ts"));
  const rules = strip(read("services/predictions/evaluation-rules.ts"));
  const store = strip(read("services/predictions/evaluator-store.ts"));

  it("no prediction source updates or deletes anything", () => {
    expect(files.filter((f) => /\.(update|delete|upsert)\s*\(/.test(read(rel(f)))).map(rel)).toEqual([]);
  });
  it("the only write to prediction_results is a single insert", () => {
    const writes = files.flatMap((f) => [...read(rel(f)).matchAll(/from\("prediction_results"\)\s*\.(\w+)/g)].map((m) => m[1]));
    expect(writes.filter((w) => w !== "select")).toEqual(["insert"]);
  });
  it("the evaluator never writes to predictions", () => {
    expect(store).not.toMatch(/from\("predictions"\)\s*\.(insert|update|delete|upsert)/);
  });
  it("the store inserts the evaluator's row as-is: it adds no timestamp, hash or id of its own", () => {
    expect(store).toMatch(/\.insert\(row\)/);
    expect(store).not.toMatch(/\.insert\(\s*\{/);
    expect(store).not.toMatch(/\.insert\(\{?\s*\.\.\.row/);
  });
  it("rules are pure: no clock, randomness, I/O or framework imports", () => {
    expect(rules).not.toMatch(/Date\.now\(|new Date\(\)|Math\.random|fetch\(|process\.env|server-only|@\/lib\/|supabase|logger/);
  });
  it("evaluator and rules never touch providers, fetch() or browser APIs", () => {
    for (const src of [evaluator, rules]) {
      expect(src).not.toMatch(/market-data\/providers|binance|\bfetch\(|\bwindow\.|typeof window|\bdocument\.|localStorage/i);
    }
  });
  it("evaluator takes market data only through the injected facade; wiring uses getMarketDataService()", () => {
    expect(evaluator).not.toMatch(/from "@\/services\/market-data\/(index|providers|registry)/);
    expect(read("services/predictions/evaluator-runtime.ts")).toMatch(/getMarketDataService\(\)/);
  });
  it("no evaluator entry point accepts a price or a timestamp", () => {
    const rt = strip(read("services/predictions/evaluator-runtime.ts"));
    expect(rt).not.toMatch(/exit_?price|evaluation_?price|closedAt|evaluatedAt/i);
    expect(read("services/predictions/schemas.ts")).toMatch(/evaluationRunInputSchema = z\.strictObject/);
  });
  it("browser-facing code never imports the evaluator", () => {
    const ui = [...walk(path.join(ROOT, "app")), ...walk(path.join(ROOT, "features")), ...walk(path.join(ROOT, "components"))];
    const offenders = ui.filter((f) => /evaluator/.test(read(rel(f))) && !rel(f).startsWith("app/api/cron/")).map(rel);
    expect(offenders).toEqual([]);
  });
  it("service never imports React", () => {
    for (const f of files) expect(read(rel(f))).not.toMatch(/from ["']react["']/);
  });
  it("the wording rules still hold for the new sources", () => {
    const FORBIDDEN = [/win(ning)?\s+probability/i, /success\s+probability/i, /probability\s+of\s+(profit|success|winning)/i, /guarantee/i, /risk[- ]free/i];
    for (const f of files) for (const re of FORBIDDEN) expect(re.test(read(rel(f)))).toBe(false);
  });
});

describe("cron route", () => {
  const route = strip(read("app/api/cron/evaluate-predictions/route.ts"));
  it("checks CRON_SECRET, fails closed when unset, and authorises before doing any work", () => {
    expect(route).toMatch(/getServerEnv\(\)\.CRON_SECRET/);
    expect(route).toMatch(/status: 503/);
    expect(route).toMatch(/isAuthorizedCronRequest/);
    expect(route.indexOf("isAuthorizedCronRequest")).toBeLessThan(route.indexOf("runPredictionEvaluation"));
    expect(route.indexOf("isAuthorizedCronRequest")).toBeLessThan(route.indexOf("checkRateLimit"));
  });
  it("is dynamic, rate-limited, and forwards only query params to the validated schema", () => {
    expect(route).toMatch(/force-dynamic/);
    expect(route).toMatch(/checkRateLimit\(RATE_LIMITS\.predictionEvaluate/);
    expect(route).not.toMatch(/request\.json\(|formData\(|body/);
  });
  it("cannot name a prediction, price or time", () => {
    expect(route).not.toMatch(/predictionId|entryPrice|exitPrice|evaluatedAt/);
  });
});

describe("isAuthorizedCronRequest", () => {
  const SECRET = "s".repeat(40);
  it("accepts the exact bearer secret", () => expect(isAuthorizedCronRequest(`Bearer ${SECRET}`, SECRET)).toBe(true));
  it.each<[string, string | null, string | undefined]>([
    ["no secret configured", `Bearer ${SECRET}`, undefined],
    ["empty secret configured", "Bearer ", ""],
    ["no header", null, SECRET],
    ["empty header", "", SECRET],
    ["wrong secret", `Bearer ${"x".repeat(40)}`, SECRET],
    ["secret prefix", `Bearer ${SECRET.slice(0, 30)}`, SECRET],
    ["secret with extra suffix", `Bearer ${SECRET}x`, SECRET],
    ["missing scheme", SECRET, SECRET],
    ["lowercase scheme", `bearer ${SECRET}`, SECRET],
    ["Basic scheme", `Basic ${SECRET}`, SECRET],
  ])("rejects: %s", (_l, header, secret) => expect(isAuthorizedCronRequest(header, secret)).toBe(false));
});
