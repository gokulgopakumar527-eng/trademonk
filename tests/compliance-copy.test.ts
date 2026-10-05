import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const SCAN_DIRS = ["app", "components", "features", "config", "services"];
const FORBIDDEN = [
  /guaranteed\s+(profit|returns?|signal)/i,
  /risk[- ]free/i,
  /100%\s+accurate/i,
  /make\s+money\s+easily/i,
  /sebi[- ]registered/i, // must not be claimed; legal placeholders phrase it as "registered with SEBI ... unless"
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : /\.(tsx?|css)$/.test(name) ? [full] : [];
  });
}

describe("compliance copy guard", () => {
  const files = SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d)));
  it("scans a meaningful number of source files", () => expect(files.length).toBeGreaterThan(20));
  it.each(FORBIDDEN.map((r) => [String(r), r] as const))("no source contains %s", (_label, re) => {
    const offenders = files.filter((f) => re.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });
  it("landing page carries the required disclaimer and no invented statistics", () => {
    const landing = readFileSync(path.join(ROOT, "app/(marketing)/page.tsx"), "utf8");
    expect(landing).toContain("<Disclaimer />");
    expect(landing).not.toMatch(/\d[\d,.]*\s*(\+|users|traders|customers|% win)/i);
  });
});
