import { describe, expect, it } from "vitest";
import { assertManualScriptAllowed, clientEnvSchema, parseEnv, serverEnvSchema } from "@/lib/env";

const validClient = {
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "x".repeat(30),
};

describe("environment validation", () => {
  it("accepts a valid client environment", () => {
    expect(parseEnv(clientEnvSchema, validClient, "client").NEXT_PUBLIC_APP_URL).toBe(
      "http://localhost:3000",
    );
  });

  it("names the missing variable and points to .env.example", () => {
    expect(() =>
      parseEnv(clientEnvSchema, { ...validClient, NEXT_PUBLIC_SUPABASE_URL: undefined }, "client"),
    ).toThrow(/NEXT_PUBLIC_SUPABASE_URL[\s\S]*\.env\.example/);
  });

  it("rejects an obviously truncated key", () => {
    expect(() =>
      parseEnv(serverEnvSchema, { SUPABASE_SERVICE_ROLE_KEY: "short" }, "server"),
    ).toThrow();
  });

  it("never lets the service role key into the client schema", () => {
    expect(Object.keys(clientEnvSchema.shape).every((k) => k.startsWith("NEXT_PUBLIC_"))).toBe(
      true,
    );
  });

  it("rejects any client-schema key that could carry a server secret or the environment selector", () => {
    for (const k of Object.keys(clientEnvSchema.shape)) {
      expect(k).not.toMatch(/SERVICE|SECRET|APP_ENV|CRON|PRIVATE/i);
    }
  });
});

const KEY = "y".repeat(30);
const server = (extra: Record<string, unknown> = {}) =>
  parseEnv(serverEnvSchema, { SUPABASE_SERVICE_ROLE_KEY: KEY, ...extra }, "server");

describe("APP_ENV selection fails closed", () => {
  it("is required: a missing APP_ENV is an error, never 'development'", () => {
    expect(() => server()).toThrow(/APP_ENV[\s\S]*required[\s\S]*no default/);
    expect(() => server({ APP_ENV: undefined })).toThrow(/APP_ENV/);
  });

  it("rejects an empty, whitespace, mis-cased, abbreviated or unknown APP_ENV", () => {
    for (const bad of ["", " ", " development", "Development", "PRODUCTION", "prod", "dev", "test", "local", "preview", null, 0, false]) {
      expect(() => server({ APP_ENV: bad }), JSON.stringify(bad)).toThrow(/APP_ENV/);
    }
  });

  it("accepts exactly development, staging and production", () => {
    for (const ok of ["development", "staging", "production"] as const) {
      expect(server({ APP_ENV: ok }).APP_ENV).toBe(ok);
    }
  });

  it("does not echo secret values in its error output", () => {
    let message = "";
    try {
      server({ APP_ENV: "nope", CRON_SECRET: "short-secret-value" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/APP_ENV/);
    expect(message).not.toContain(KEY);
    expect(message).not.toContain("short-secret-value");
  });
});

describe("explicit local development stays convenient", () => {
  it("development with default providers and no vendor config validates", () => {
    const env = server({ APP_ENV: "development" });
    expect(env.CRYPTO_PROVIDER).toBe("binance");
    expect(env.INDIAN_MARKET_PROVIDER).toBe("none");
  });

  it("development may opt in to mock providers", () => {
    const env = server({ APP_ENV: "development", CRYPTO_PROVIDER: "mock", INDIAN_MARKET_PROVIDER: "mock" });
    expect(env.CRYPTO_PROVIDER).toBe("mock");
    expect(env.INDIAN_MARKET_PROVIDER).toBe("mock");
  });

  it("development is fine when Vercel reports a local/dev context or nothing at all", () => {
    expect(server({ APP_ENV: "development", VERCEL_ENV: "development" }).APP_ENV).toBe("development");
    expect(server({ APP_ENV: "development", VERCEL_ENV: undefined }).APP_ENV).toBe("development");
  });
});

describe("staging and production configurations", () => {
  for (const appEnv of ["staging", "production"] as const) {
    it(`${appEnv}: real providers validate without any mock or vendor setting`, () => {
      const env = server({ APP_ENV: appEnv });
      expect(env.APP_ENV).toBe(appEnv);
      expect(env.CRYPTO_PROVIDER).toBe("binance");
      expect(env.INDIAN_MARKET_PROVIDER).toBe("none");
    });

    it(`${appEnv}: mock crypto or Indian data is a configuration error, not a silent fallback`, () => {
      expect(() => server({ APP_ENV: appEnv, CRYPTO_PROVIDER: "mock" })).toThrow(/CRYPTO_PROVIDER[\s\S]*APP_ENV=development/);
      expect(() => server({ APP_ENV: appEnv, INDIAN_MARKET_PROVIDER: "mock" })).toThrow(/INDIAN_MARKET_PROVIDER[\s\S]*APP_ENV=development/);
    });

    it(`${appEnv}: valid on deployed Vercel scopes`, () => {
      expect(server({ APP_ENV: appEnv, VERCEL_ENV: "production" }).APP_ENV).toBe(appEnv);
      expect(server({ APP_ENV: appEnv, VERCEL_ENV: "preview" }).APP_ENV).toBe(appEnv);
    });
  }

  it("APP_ENV=development is refused on a deployed Vercel production or preview environment", () => {
    for (const v of ["production", "preview"]) {
      expect(() => server({ APP_ENV: "development", VERCEL_ENV: v }), v).toThrow(/APP_ENV[\s\S]*deployed Vercel/);
    }
  });

  it("production and staging still validate every other variable", () => {
    expect(() => server({ APP_ENV: "production", BINANCE_BASE_URL: "not-a-url" })).toThrow(/BINANCE_BASE_URL/);
    expect(() => server({ APP_ENV: "production", CRON_SECRET: "too-short" })).toThrow(/CRON_SECRET/);
    expect(() => parseEnv(serverEnvSchema, { APP_ENV: "production", SUPABASE_SERVICE_ROLE_KEY: "short" }, "server")).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });
});

describe("manual script guard is an allow-list", () => {
  it("allows only an explicit development or staging", () => {
    expect(() => assertManualScriptAllowed("development", "x")).not.toThrow();
    expect(() => assertManualScriptAllowed("staging", "x")).not.toThrow();
  });
  it("refuses production, unset, empty and unrecognised values", () => {
    for (const bad of ["production", undefined, "", "prod", "Development", "STAGING", "test"]) {
      expect(() => assertManualScriptAllowed(bad, "evaluate:predictions"), String(bad)).toThrow(/Refusing to run evaluate:predictions/);
    }
  });
});

