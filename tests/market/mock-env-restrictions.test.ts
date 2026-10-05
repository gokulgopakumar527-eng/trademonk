import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildRegistry } from "@/services/market-data/registry-factory";
import { MockMarketProvider } from "@/services/market-data/providers/mock/mock-provider";

/**
 * Mock market data is a development-only convenience. It must be unreachable unless APP_ENV is the
 * exact string "development": not when APP_ENV is missing, blank, mis-cased or abbreviated.
 */
const NOT_DEVELOPMENT: Array<string | undefined> = [undefined, "", " ", "Development", "DEVELOPMENT", "dev", "local", "test", "staging", "production", "prod"];
const cfg = (appEnv: string | undefined) => ({
  APP_ENV: appEnv as never,
  CRYPTO_PROVIDER: "mock" as const,
  BINANCE_BASE_URL: undefined,
  INDIAN_MARKET_PROVIDER: "mock" as const,
});

describe("MockMarketProvider construction", () => {
  it("is refused for anything but the exact string 'development'", () => {
    for (const v of NOT_DEVELOPMENT) {
      expect(() => new MockMarketProvider({ appEnv: v as never }), String(v)).toThrow(/only available when APP_ENV=development/);
    }
  });
  it("is allowed for explicit local development", () => {
    expect(() => new MockMarketProvider({ appEnv: "development" })).not.toThrow();
  });
});

describe("registry factory never selects mock without explicit development", () => {
  it("routes to the real providers even if both providers are configured as mock", () => {
    for (const v of NOT_DEVELOPMENT) {
      const reg = buildRegistry(cfg(v));
      expect(reg.primary("CRYPTO")?.id, String(v)).toBe("binance-public");
      expect(reg.chain("NSE").map((p) => p.id), String(v)).toEqual(["indian:unconfigured"]);
      expect(reg.chain("BSE").map((p) => p.id), String(v)).toEqual(["indian:unconfigured"]);
    }
  });
  it("uses mock only for explicit development AND explicit provider opt-in", () => {
    const optedIn = buildRegistry(cfg("development"));
    expect(optedIn.primary("CRYPTO")?.id).toBe("mock");
    const noOptIn = buildRegistry({ ...cfg("development"), CRYPTO_PROVIDER: "binance", INDIAN_MARKET_PROVIDER: "none" });
    expect(noOptIn.primary("CRYPTO")?.id).toBe("binance-public");
    expect(noOptIn.chain("NSE").map((p) => p.id)).toEqual(["indian:unconfigured"]);
  });
});

/** Static guard: every environment comparison in app code must be the strict `=== "development"` form. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (["node_modules", ".next", "tests", ".git"].includes(name)) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}
const ROOT = path.resolve(import.meta.dirname, "..", "..");

describe("static guards on how APP_ENV is used", () => {
  const files = sourceFiles(ROOT);
  const uses = files.flatMap((f) =>
    readFileSync(f, "utf8").split("\n").flatMap((line, i) => (/APP_ENV|appEnv/.test(line) ? [{ file: path.relative(ROOT, f), line: line.trim(), n: i + 1 }] : [])),
  );

  it("no code treats 'not production' (or any negated/loose comparison) as development", () => {
    const loose = uses.filter((u) => /(APP_ENV|appEnv)\s*(!==|!=|==)(?!=)\s*["']/.test(u.line) && !/!==\s*"development"/.test(u.line));
    expect(loose, JSON.stringify(loose)).toEqual([]);
    const notProd = uses.filter((u) => /!==\s*["']production["']/.test(u.line));
    expect(notProd, JSON.stringify(notProd)).toEqual([]);
  });

  it("every positive environment check is the exact `=== \"development\"` form", () => {
    const strict = uses.filter((u) => /(APP_ENV|appEnv)\s*===\s*["']/.test(u.line));
    expect(strict.length).toBeGreaterThan(0);
    for (const u of strict) expect(u.line, `${u.file}:${u.n}`).toMatch(/(APP_ENV|appEnv)\s*===\s*"development"/);
  });

  it("APP_ENV has no default anywhere in the schema or its wiring", () => {
    const env = readFileSync(path.join(ROOT, "lib/env.ts"), "utf8");
    const appEnvBlock = env.slice(env.indexOf("APP_ENV: z.enum"), env.indexOf("VERCEL_ENV"));
    expect(appEnvBlock).not.toMatch(/\.default\(|\.optional\(|\.catch\(/);
    const wiring = readFileSync(path.join(ROOT, "lib/env.server.ts"), "utf8");
    expect(wiring).toMatch(/APP_ENV:\s*process\.env\.APP_ENV,/);
    expect(wiring).not.toMatch(/APP_ENV:\s*process\.env\.APP_ENV\s*(\|\||\?\?)/);
  });

  it("the environment selector is never exposed to the browser", () => {
    const withPublicPrefix = files.filter((f) => /NEXT_PUBLIC_(APP_ENV|VERCEL_ENV|SUPABASE_SERVICE|CRON|.*SECRET)/.test(readFileSync(f, "utf8")));
    expect(withPublicPrefix.map((f) => path.relative(ROOT, f))).toEqual([]);
    const example = readFileSync(path.join(ROOT, ".env.example"), "utf8");
    expect(example).not.toMatch(/^NEXT_PUBLIC_(APP_ENV|.*SECRET|.*SERVICE)/m);
  });

  it("no server env value is logged or interpolated by the env module", () => {
    const env = readFileSync(path.join(ROOT, "lib/env.ts"), "utf8");
    expect(env).not.toMatch(/console\./);
    expect(env).not.toMatch(/\$\{[^}]*SERVICE_ROLE|\$\{[^}]*CRON_SECRET/);
  });
});
