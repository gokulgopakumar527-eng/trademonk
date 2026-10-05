import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Exercises the REAL getServerEnv() wiring (process.env -> schema), which the pure schema tests do
 * not cover: in particular that an unset or empty APP_ENV is passed through as-is and so fails,
 * rather than being coerced (e.g. by `|| undefined`) into a default.
 */
const SERVICE_KEY = "service-role-key-0123456789-abcdef";
const MANAGED = ["APP_ENV", "VERCEL_ENV", "CRYPTO_PROVIDER", "INDIAN_MARKET_PROVIDER", "BINANCE_BASE_URL", "CRON_SECRET", "SUPABASE_SERVICE_ROLE_KEY"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of MANAGED) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
  vi.resetModules(); // getServerEnv caches its result per module instance
});

afterEach(() => {
  for (const k of MANAGED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const load = async () => (await import("@/lib/env.server")).getServerEnv;

describe("getServerEnv() reads APP_ENV without defaulting it", () => {
  it("throws when APP_ENV is unset", async () => {
    const getServerEnv = await load();
    expect(() => getServerEnv()).toThrow(/APP_ENV/);
  });

  it("throws when APP_ENV is set but empty (as Vercel can deliver a blank value)", async () => {
    process.env.APP_ENV = "";
    const getServerEnv = await load();
    expect(() => getServerEnv()).toThrow(/APP_ENV/);
  });

  it("throws for an unrecognised APP_ENV", async () => {
    process.env.APP_ENV = "prod";
    const getServerEnv = await load();
    expect(() => getServerEnv()).toThrow(/APP_ENV/);
  });

  it("does not cache a failed parse: a later valid configuration is picked up", async () => {
    const getServerEnv = await load();
    expect(() => getServerEnv()).toThrow(/APP_ENV/);
    process.env.APP_ENV = "staging";
    expect(getServerEnv().APP_ENV).toBe("staging");
  });

  it("accepts explicit development, staging and production", async () => {
    for (const v of ["development", "staging", "production"]) {
      vi.resetModules();
      process.env.APP_ENV = v;
      const getServerEnv = await load();
      expect(getServerEnv().APP_ENV).toBe(v);
    }
  });

  it("refuses development on a deployed Vercel environment even when explicitly set", async () => {
    process.env.APP_ENV = "development";
    process.env.VERCEL_ENV = "production";
    const getServerEnv = await load();
    expect(() => getServerEnv()).toThrow(/deployed Vercel/);
  });

  it("treats a blank VERCEL_ENV as absent (local development still works)", async () => {
    process.env.APP_ENV = "development";
    process.env.VERCEL_ENV = "";
    const getServerEnv = await load();
    expect(getServerEnv().APP_ENV).toBe("development");
  });

  it("rejects mock providers in staging/production via the real environment", async () => {
    process.env.APP_ENV = "production";
    process.env.CRYPTO_PROVIDER = "mock";
    const getServerEnv = await load();
    expect(() => getServerEnv()).toThrow(/CRYPTO_PROVIDER/);
  });

  it("never puts the service-role key into a validation error", async () => {
    process.env.APP_ENV = "bogus";
    const getServerEnv = await load();
    let message = "";
    try {
      getServerEnv();
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/APP_ENV/);
    expect(message).not.toContain(SERVICE_KEY);
  });
});
