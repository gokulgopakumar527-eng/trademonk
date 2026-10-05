import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Static guards for Phase 5C-5 (paper-trading UI). Behaviour is covered by the render and action
 * tests; these fail fast if the UI is ever given authority it must not have: a database or
 * service-role handle, a client-supplied identity, or browser-side accounting.
 */
const ROOT = path.resolve(__dirname, "../..");
const read = (...p: string[]) => readFileSync(path.join(ROOT, ...p), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const walk = (d: string): string[] =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(d, e.name)] : []));

const uiDir = path.join(ROOT, "components/paper-trading");
const uiFiles = walk(uiDir);
const clientFiles = uiFiles.filter((f) => /^\s*"use client"/.test(readFileSync(f, "utf8")));
const pageFile = path.join(ROOT, "app/(app)/paper-trading/page.tsx");
const featureFiles = ["format.ts", "eligibility.ts", "copy.ts"].map((f) => path.join(ROOT, "features/paper-trading", f));

describe("paper-trading UI: no privileged access", () => {
  it("has the expected client components", () => {
    expect(clientFiles.map((f) => path.basename(f)).sort()).toEqual(["close-position-button.tsx", "open-trade-panel.tsx"]);
  });
  it("no UI file, page or UI-side feature module touches the database, the service role, the environment or the services directly", () => {
    for (const f of [...uiFiles, pageFile, ...featureFiles]) {
      const code = strip(readFileSync(f, "utf8"));
      expect(code, f).not.toMatch(/lib\/supabase|createSupabase|SERVICE_ROLE|env\.server|process\.env|services\/paper-trading|services\/market-data|supabase-store/);
      expect(code, f).not.toMatch(/\.rpc\(|\.from\(\s*["']paper_/);
    }
  });
  it("client components import only the server ACTIONS and type-only state, and never a server-only module", () => {
    for (const f of clientFiles) {
      const code = strip(readFileSync(f, "utf8"));
      expect(code, f).not.toMatch(/server-only|features\/paper-trading\/server|lib\/rate-limit|profile-service/);
      const imports = [...code.matchAll(/from\s+"(@\/features\/paper-trading\/[^"]+)"/g)].map((m) => m[1]);
      for (const i of imports) expect(["actions", "copy", "format", "idempotency", "state"].some((n) => i!.endsWith(`/${n}`)), `${f}: ${i}`).toBe(true);
    }
  });
  it("the page reads data only through the session-scoped loader and takes no search params or ids", () => {
    const code = strip(readFileSync(pageFile, "utf8"));
    expect(code).toMatch(/loadPaperTradingPage\(\)/);
    expect(code).not.toMatch(/searchParams|params\b|userId|user_id/);
  });
});

describe("paper-trading UI: the browser sends no authority and does no accounting", () => {
  it("the close component sends exactly { tradeId } and nothing else", () => {
    const code = strip(read("components/paper-trading/close-position-button.tsx"));
    const calls = [...code.matchAll(/closePaperTradeAction\(([^)]*)\)/g)].map((m) => m[1]!.replace(/\s+/g, " ").trim());
    expect(calls).toEqual(["{ tradeId: p.tradeId }"]);
  });
  it("the estimate sends { assetId, side, quantity }; the open sends the same plus the intent's idempotencyKey", () => {
    const code = strip(read("components/paper-trading/open-trade-panel.tsx"));
    const sig = (name: string) => [...code.matchAll(new RegExp(`${name}\\(([^)]*\\)?[^)]*)\\)`, "g"))].map((m) => m[1]!.replace(/\s+/g, " ").trim());
    expect(sig("previewPaperTradeAction")).toEqual(["{ assetId, side, quantity: quantity.trim() }"]);
    expect(sig("openPaperTradeAction")).toEqual(["{ assetId, side, quantity: quantity.trim(), idempotencyKey: current.key }"]);
  });
  it("no UI code names a user id, price, fee, slippage, cash or P&L field in a payload", () => {
    for (const f of clientFiles) {
      const code = strip(readFileSync(f, "utf8"));
      expect(code, f).not.toMatch(/\buserId\b|user_id|exitPrice\s*:|entryPrice\s*:|fee\s*:|pnl\s*:|cashBalance\s*:/i);
    }
  });
  it("UI files do no money arithmetic (no multiplying a price by a quantity, no Number() on stored amounts)", () => {
    for (const f of uiFiles) {
      const code = strip(readFileSync(f, "utf8"));
      expect(code, f).not.toMatch(/(price|Price|quantity|Quantity|cost|Cost)\w*\s*\*\s*\w*(price|Price|quantity|Quantity)/);
      expect(code, f).not.toMatch(/Number\((?:p|t|c|estimate|opened|trade)\.[A-Za-z]*(?:price|Price|cost|Cost|pnl|Pnl|fee|Fee|balance|Balance|value|Value)/);
      expect(code, f).not.toMatch(/parseFloat\(/);
    }
  });
  it("no browser storage is used for any paper-trading state", () => {
    for (const f of [...uiFiles, pageFile]) expect(strip(readFileSync(f, "utf8")), f).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
  });
});

describe("paper-trading UI: BUY/LONG only, simulation always labelled", () => {
  it("the open component never offers SELL or SHORT", () => {
    const code = strip(read("components/paper-trading/open-trade-panel.tsx"));
    expect(code).toMatch(/const SIDES = \["BUY", "LONG"\] as const/);
    expect(code).not.toMatch(/"SELL"|"SHORT"/);
  });
  it("every paper surface carries the simulation label", () => {
    for (const f of ["components/paper-trading/open-trade-panel.tsx", "components/paper-trading/paper-banner.tsx", "components/paper-trading/close-position-button.tsx"]) {
      expect(read(f), f).toMatch(/PAPER_BANNER_TEXT/);
    }
    expect(read("features/paper-trading/copy.ts")).toContain("PAPER TRADING — NO REAL MONEY");
  });
  it("no wording promises profit or live execution", () => {
    for (const f of [...uiFiles, pageFile, path.join(ROOT, "features/paper-trading/copy.ts")]) {
      expect(strip(readFileSync(f, "utf8")), f).not.toMatch(/guaranteed|risk-free|can't lose|easy money|place (a )?real order|live order/i);
    }
  });
});

describe("5C-5 server additions are read-only and owner-scoped", () => {
  const store = strip(read("services/paper-trading/supabase-store.ts"));
  const fn = store.slice(store.indexOf("async getClosedTrades"));
  it("getClosedTrades scopes every table read by the verified user and writes nothing", () => {
    expect(fn).not.toMatch(/\.rpc\(|\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
    expect((fn.match(/\.eq\("user_id", userId\)/g) ?? []).length).toBe(2); // results and trades
  });
  it("the estimate and history services never call a store write", () => {
    for (const f of ["preview.ts", "history.ts"]) {
      expect(strip(read("services/paper-trading", f)), f).not.toMatch(/store\.(openTrade|closeTrade)|deps\.audit/);
    }
  });
  it("5C-5 itself added no migration: only the open-idempotency migration (5C-7C-A) follows close", () => {
    const names = readdirSync(path.join(ROOT, "supabase/migrations")).sort();
    const afterClose = names.slice(names.findIndex((n) => n.includes("paper_trade_close")) + 1);
    expect(afterClose.map((n) => n.replace(/^\d+_/, ""))).toEqual(["paper_trade_open_idempotency.sql"]);
  });
  it("the preview action has its own rate-limit bucket and checks it after authentication", () => {
    const actions = strip(read("features/paper-trading/actions.ts"));
    const body = actions.slice(actions.indexOf("export async function previewPaperTradeAction"));
    expect(body.indexOf("requireUser()")).toBeGreaterThan(-1);
    expect(body.indexOf("requireUser()")).toBeLessThan(body.indexOf("checkRateLimit(RATE_LIMITS.paperTradePreview, user.id)"));
    expect(body.indexOf("checkRateLimit")).toBeLessThan(body.indexOf("previewOpenTrade(user.id, input)"));
  });
});
