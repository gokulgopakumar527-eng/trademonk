import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const f = path.join(dir, n);
    return statSync(f).isDirectory() ? walk(f) : /\.tsx?$/.test(n) ? [f] : [];
  });
const read = (f: string) => readFileSync(f, "utf8");
const rel = (f: string) => path.relative(ROOT, f);

describe("browser -> Next.js -> services -> provider layering", () => {
  const ui = ["app", "components", "features"].flatMap((d) => walk(path.join(ROOT, d)));

  it("no UI/feature file imports a provider implementation directly", () => {
    const bad = ui.filter((f) => /services\/market-data\/providers/.test(read(f)));
    expect(bad.map(rel)).toEqual([]);
  });
  it("no UI/feature file names a vendor host or calls fetch()", () => {
    const bad = ui.filter((f) => /binance|https?:\/\/[a-z.-]*(nse|bse)india|\bfetch\(/i.test(read(f)));
    expect(bad.map(rel)).toEqual([]);
  });
  it("client components never import server-only modules, the service facade or env", () => {
    const clients = ui.filter((f) => /^\s*["']use client["']/.test(read(f)));
    expect(clients.length).toBeGreaterThan(0);
    const bad = clients.filter((f) => /server-only|services\/market-data\/(index|market-data-service)|lib\/env\.server|supabase\/(admin|server)/.test(read(f)));
    expect(bad.map(rel)).toEqual([]);
  });
  it("services never import React", () => {
    const svc = walk(path.join(ROOT, "services"));
    expect(svc.filter((f) => /from ["']react["']/.test(read(f))).map(rel)).toEqual([]);
  });
  it("market pages hard-code no prices", () => {
    const pages = ["app/(app)/dashboard/page.tsx", "app/(app)/markets/page.tsx", "app/(app)/markets/[symbol]/page.tsx"];
    for (const p of pages) expect(read(path.join(ROOT, p))).not.toMatch(/\b\d{2,3},\d{3}(\.\d+)?\b/);
  });
});
