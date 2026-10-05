import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PAPER_EXECUTION_LIMITS, PAPER_SIMULATION, PAPER_SIMULATION_NOTICE, PAPER_TRADING_BANNER, parsePaperSimulationConfig } from "@/config/paper-trading";
import type { MarketDataService } from "@/services/market-data/market-data-service";
import type { PaperTradingDeps, PaperTradingMarketData } from "@/services/paper-trading/ports";
import { createPaperTradingService } from "@/services/paper-trading/paper-trading-service";

const ROOT = path.resolve(__dirname, "../..");
const DIR = path.join(ROOT, "services/paper-trading");
const files = readdirSync(DIR).filter((f) => f.endsWith(".ts"));
const code = (f: string) =>
  readFileSync(path.join(DIR, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// Compile-time pin: the port must stay a slice of the real facade.
const _facadeFitsPort = (m: MarketDataService): PaperTradingMarketData => m;
void _facadeFitsPort;

const deps = (over: Partial<PaperTradingDeps> = {}): PaperTradingDeps => ({
  marketData: { getQuote: () => Promise.reject(new Error("must not be called when reading assumptions")) },
  store: {
    getAssetById: () => Promise.reject(new Error("must not be called when reading assumptions")),
    openTrade: () => Promise.reject(new Error("must not be called when reading assumptions")),
    getTradeForClose: () => Promise.reject(new Error("must not be called when reading assumptions")),
    closeTrade: () => Promise.reject(new Error("must not be called when reading assumptions")),
    getPortfolioSnapshot: () => Promise.reject(new Error("must not be called when reading assumptions")),
    getClosedTrades: () => Promise.reject(new Error("must not be called when reading assumptions")),
  },
  audit: () => Promise.reject(new Error("must not be called when reading assumptions")),
  now: () => new Date("2026-01-01T00:00:00Z"),
  config: PAPER_SIMULATION,
  limits: PAPER_EXECUTION_LIMITS,
  allowMockData: false,
  ...over,
});

describe("paper-trading service boundary (behaviour)", () => {
  it("exposes the read-only assumptions, open, close, the read-only portfolio and the two read-only 5C-5 UI helpers (estimate, history), and NOTHING beyond that", () => {
    const s = createPaperTradingService(deps());
    expect(Object.keys(s).sort()).toEqual(["closeTrade", "getClosedTrades", "getPortfolio", "getSimulationAssumptions", "openTrade", "previewOpenTrade"]);
  });
  it("returns the labelled assumptions without touching market data or audit", () => {
    const a = createPaperTradingService(deps()).getSimulationAssumptions();
    expect(a.banner).toBe(PAPER_TRADING_BANNER);
    expect(a.notice).toBe(PAPER_SIMULATION_NOTICE);
    expect(a.config).toBe(PAPER_SIMULATION);
  });
  it("uses the injected configuration, not a hard-coded one", () => {
    const custom = parsePaperSimulationConfig({
      version: "TEST", startingCash: { INR: 5, USDT: 7 },
      markets: { CRYPTO: { feeBps: 1, slippageBps: 2 }, NSE: { feeBps: 3, slippageBps: 4 }, BSE: { feeBps: 5, slippageBps: 6 } },
    });
    expect(createPaperTradingService(deps({ config: custom })).getSimulationAssumptions().config.version).toBe("TEST");
  });
});

describe("paper-trading service boundary (layering)", () => {
  it("has exactly the expected files (open, close and portfolio flows; no analytics modules beyond that)", () => {
    expect(files.sort()).toEqual([
      "close-trade.ts", "errors.ts", "execution.ts", "history.ts", "index.ts", "money.ts", "open-trade.ts",
      "paper-trading-service.ts", "portfolio.ts", "ports.ts", "preview.ts", "schemas.ts", "supabase-store.ts", "types.ts",
    ]);
  });
  it("never imports a market-data provider implementation or the market-data store", () => {
    for (const f of files) expect(code(f), f).not.toMatch(/market-data\/(providers|supabase-store|registry|store)/);
  });
  it("only index.ts reaches the market-data facade, and only via its public entry point", () => {
    for (const f of files.filter((n) => n !== "index.ts")) expect(code(f), f).not.toMatch(/from ["']@\/services\/market-data["']/);
    expect(code("index.ts")).toMatch(/from "@\/services\/market-data"/);
  });
  it("only supabase-store.ts touches the database; nothing calls the network or a browser API", () => {
    for (const f of files.filter((n) => n !== "supabase-store.ts")) {
      expect(code(f), f).not.toMatch(/lib\/supabase|createSupabase|\.from\(\s*["']paper_|\.rpc\(|\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
    }
    for (const f of files) expect(code(f), f).not.toMatch(/\bfetch\(|window\.|document\.|localStorage/);
  });
  it("does not depend on the prediction services (no cross-coupling)", () => {
    for (const f of files) expect(code(f), f).not.toMatch(/services\/predictions/);
  });
  it("only the wiring module and the store are server-only, and only the wiring module reads the environment", () => {
    expect(code("index.ts")).toMatch(/import "server-only"/);
    expect(code("supabase-store.ts")).toMatch(/import "server-only"/);
    for (const f of files.filter((n) => !["index.ts", "supabase-store.ts"].includes(n))) expect(code(f), f).not.toMatch(/server-only/);
    for (const f of files.filter((n) => n !== "index.ts")) expect(code(f), f).not.toMatch(/env\.server/);
  });
  it("simulation numbers live in config/paper-trading.ts, not in the service files", () => {
    for (const f of files) expect(code(f), f).not.toMatch(/\b(feeBps|slippageBps|startingCash)\s*[:=]\s*\d/);
  });
  it("is imported only by the feature layer (action, state types, server page loader); no component or page reaches it directly", () => {
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(d, e.name)] : []));
    const offenders = ["app", "components", "features"].flatMap((d) => walk(path.join(ROOT, d))).filter((f) => /services\/paper-trading/.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => path.relative(ROOT, f)).sort()).toEqual([
      path.join("features", "paper-trading", "actions.ts"),
      path.join("features", "paper-trading", "server.ts"),
      path.join("features", "paper-trading", "state.ts"),
    ]);
  });
});
