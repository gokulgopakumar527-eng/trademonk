import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const read = (...p: string[]) => readFileSync(path.join(ROOT, ...p), "utf8");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const f = path.join(dir, n);
    return statSync(f).isDirectory() ? walk(f) : /\.tsx?$/.test(n) ? [f] : [];
  });
const rel = (f: string) =>
  path.relative(ROOT, f).replace(/\\/g, "/");

const migrationsDir = path.join(ROOT, "supabase/migrations");
const migrationFiles = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
const allSql = migrationFiles.map((f) => readFileSync(path.join(migrationsDir, f), "utf8")).join("\n");
const m5 = migrationFiles.find((f) => f.includes("prediction_engine"))!;
const m5Sql = readFileSync(path.join(migrationsDir, m5), "utf8");
const stripComments = (s: string) => s.replace(/--.*$/gm, "");
/** Strip TS comments so the checks look at code, not prose. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const ENGINE_COLUMNS = [
  "entry_reference_price", "engine_version", "signal_agreement", "signal_total",
  "entry_quote_source", "entry_quote_as_of", "entry_quote_fetched_at", "entry_quote_is_mock",
  "engine_snapshot", "hash_version", "created_at", "expires_at", "content_hash",
];

describe("migration 5 keeps the security model intact", () => {
  it("is ordered after the Phase 1 migrations", () => {
    expect(migrationFiles.indexOf(m5)).toBe(4);
  });
  it("contains no GRANT statements at all (no new client privileges)", () => {
    expect(stripComments(m5Sql)).not.toMatch(/\bgrant\b/i);
  });
  it("does not disable RLS, drop triggers or alter the append-only triggers", () => {
    const sql = stripComments(m5Sql);
    expect(sql).not.toMatch(/disable\s+row\s+level\s+security/i);
    expect(sql).not.toMatch(/drop\s+trigger/i);
    expect(sql).not.toMatch(/disable\s+trigger/i);
    expect(sql).not.toMatch(/prevent_mutation/);
    expect(sql).not.toMatch(/create\s+policy|drop\s+policy/i);
  });
  it("hashes the entry price, quote provenance, engine version and snapshot", () => {
    const fn = m5Sql.slice(m5Sql.indexOf("create or replace function public.predictions_before_insert"));
    for (const col of ["entry_reference_price", "engine_version", "signal_agreement", "entry_quote_source", "entry_quote_as_of", "entry_quote_fetched_at", "entry_quote_is_mock", "engine_snapshot", "timeframe"]) {
      expect(fn).toContain(`new.${col}`);
    }
    expect(fn).toMatch(/new\.created_at := now\(\)/);
    expect(fn).toMatch(/new\.expires_at := now\(\)/);
    expect(fn).toMatch(/new\.hash_version := 2/);
  });
  it("requires every engine field whenever engine_version is set, and forbids half-forged rows", () => {
    expect(m5Sql).toMatch(/predictions_engine_fields_complete/);
    expect(m5Sql).toMatch(/predictions_engine_fields_only_with_version/);
  });
  it("never adds a status/result column to predictions (lifecycle is derived)", () => {
    expect(stripComments(m5Sql)).not.toMatch(/add column\s+(status|result|closed_at|prediction_result)/i);
  });
});

describe("no client privilege on engine or server-owned columns", () => {
  const insertGrants = stripComments(allSql)
    .split(";")
    .filter((s) => /grant\s+insert/i.test(s) && /public\.predictions\b/.test(s) && /authenticated/.test(s));
  it("finds the predictions insert grant", () => expect(insertGrants.length).toBeGreaterThan(0));
  it.each(ENGINE_COLUMNS)("authenticated cannot insert %s", (col) => {
    for (const g of insertGrants) expect(g).not.toMatch(new RegExp(`\\b${col}\\b`));
  });
  it("no UPDATE, DELETE or TRUNCATE privilege on predictions for any API role", () => {
    const bad = stripComments(allSql)
      .split(";")
      .filter((s) => /grant\s+(update|delete|truncate|all)/i.test(s) && /public\.predictions\b/.test(s));
    expect(bad).toEqual([]);
  });
});

describe("application code cannot mutate or delete predictions", () => {
  const files = [...walk(path.join(ROOT, "services/predictions")), ...walk(path.join(ROOT, "features/predictions"))];
  it("scans the prediction sources", () => expect(files.length).toBeGreaterThanOrEqual(8));
  it("uses no update/delete/upsert calls", () => {
    const bad = files.filter((f) => /\.(update|delete|upsert)\s*\(/.test(read(rel(f))));
    expect(bad.map(rel)).toEqual([]);
  });
  it("the only write to `predictions` is a single insert", () => {
    const writes = files.flatMap((f) => [...read(rel(f)).matchAll(/from\("predictions"\)\s*\.(\w+)/g)].map((m) => m[1]));
    expect(writes.filter((w) => w !== "select")).toEqual(["insert"]);
  });
  it("read paths run as the user (RLS), not with the service role", () => {
    expect(read("services/predictions/read.ts")).not.toMatch(/supabase\/admin|createSupabaseAdminClient/);
  });
  it("the service-role client is confined to the store", () => {
    const users = files.filter((f) => /createSupabaseAdminClient/.test(read(rel(f)))).map(rel);
    // Phase 5B added exactly one more store (the evaluator's); nothing else may hold the service role.
    expect(users).toEqual(["services/predictions/evaluator-store.ts", "services/predictions/supabase-store.ts"]);
  });
});

describe("engine purity and layering", () => {
  const engine = code(read("services/predictions/engine.ts"));
  const service = code(read("services/predictions/prediction-service.ts"));
  it("engine has no clock, randomness, I/O or framework imports", () => {
    expect(engine).not.toMatch(/Date\.now\(|new Date\(\)|Math\.random|fetch\(|process\.env|server-only|@\/lib\/|supabase|logger/);
  });
  it("engine and service never touch providers, fetch() or browser APIs", () => {
    for (const src of [engine, service]) {
      expect(src).not.toMatch(/market-data\/providers|binance|\bfetch\(|\bwindow\.|typeof window|\bdocument\.|localStorage/i);
    }
  });
  it("service takes market data only through the injected facade", () => {
    expect(service).not.toMatch(/from "@\/services\/market-data\/(index|providers|registry)/);
    expect(read("services/predictions/index.ts")).toMatch(/getMarketDataService\(\)/);
  });
  it("service never imports React", () => {
    for (const f of walk(path.join(ROOT, "services/predictions"))) expect(read(rel(f))).not.toMatch(/from ["']react["']/);
  });
  it("the server action accepts no price and always authenticates and rate-limits", () => {
    const action = read("features/predictions/actions.ts");
    expect(action).toMatch(/^"use server";/);
    expect(action).toMatch(/requireUser\(\)/);
    expect(action).toMatch(/checkRateLimit\(RATE_LIMITS\.predictionCreate/);
    expect(action).not.toMatch(/entryPrice|entry_reference_price|targetPrice|createdAt/);
    expect(action).toMatch(/createPredictionForUser\(user\.id, input\)/);
  });
});

describe("wording", () => {
  const files = [...walk(path.join(ROOT, "services/predictions")), ...walk(path.join(ROOT, "features/predictions"))];
  const FORBIDDEN = [
    /win(ning)?\s+probability/i,
    /success\s+probability/i,
    /probability\s+of\s+(profit|success|winning|a\s+win)/i,
    /chance\s+of\s+(profit|success|winning)/i,
    /guarantee/i,
    /risk[- ]free/i,
    /sure\s+(thing|shot)/i,
  ];
  it.each(FORBIDDEN.map((r) => [String(r), r] as const))("no prediction source matches %s", (_l, re) => {
    expect(files.filter((f) => re.test(read(rel(f)))).map(rel)).toEqual([]);
  });
});
