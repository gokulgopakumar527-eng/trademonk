import { z } from "zod";

/**
 * Environment validation. Public and server variables are validated separately so a
 * server-only value can never be reached through the client schema.
 * `getServerEnv()` lives in lib/env.server.ts (guarded by `server-only`).
 */
export const clientEnvSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20, "looks too short to be a Supabase key"),
});

/** The only environments the app recognises. There is deliberately NO default (see APP_ENV below). */
export const APP_ENVS = ["development", "staging", "production"] as const;
export type AppEnv = (typeof APP_ENVS)[number];

export const serverEnvSchema = z
  .object({
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(20, "looks too short to be a Supabase key"),
    /**
     * REQUIRED, no default. A missing, empty, mis-cased or unknown value is a configuration error and
     * stops server code that needs the environment; it is never treated as "development".
     * Only an explicit `development` unlocks development-only behaviour (mock market data, fail-open
     * rate limiting).
     */
    APP_ENV: z.enum(APP_ENVS, {
      error: "is required and must be exactly one of: development, staging, production (there is no default)",
    }),
    /**
     * Set automatically by Vercel on deployments (production | preview | development). Never set it
     * by hand. It is used only to refuse APP_ENV=development on a deployed Vercel environment.
     */
    VERCEL_ENV: z.string().optional(),
    /** Crypto data provider. "mock" is accepted ONLY when APP_ENV=development. */
    CRYPTO_PROVIDER: z.enum(["binance", "mock"]).default("binance"),
    /** Override the Binance public market-data host (default: https://data-api.binance.vision). */
    BINANCE_BASE_URL: z.url().optional(),
    /** Indian market data vendor. "none" => "Data unavailable". "mock" only in development. */
    INDIAN_MARKET_PROVIDER: z.enum(["none", "mock"]).default("none"),
    /**
     * Shared secret for trusted schedulers (Vercel Cron sends it as `Authorization: Bearer <secret>`).
     * Optional so the app boots without it, but every cron route REFUSES to run while it is unset.
     */
    CRON_SECRET: z.string().min(32, "use at least 32 random characters").optional(),
  })
  .superRefine((env, ctx) => {
    // Messages name variables and fixed literals only; they never echo a secret value.
    const deployedOnVercel = env.VERCEL_ENV === "production" || env.VERCEL_ENV === "preview";
    if (env.APP_ENV === "development" && deployedOnVercel) {
      ctx.addIssue({
        code: "custom",
        path: ["APP_ENV"],
        message: `development is not allowed on a deployed Vercel environment (VERCEL_ENV=${env.VERCEL_ENV}); set staging or production`,
      });
    }
    if (env.APP_ENV !== "development") {
      if (env.CRYPTO_PROVIDER === "mock") {
        ctx.addIssue({ code: "custom", path: ["CRYPTO_PROVIDER"], message: "mock market data is only allowed when APP_ENV=development" });
      }
      if (env.INDIAN_MARKET_PROVIDER === "mock") {
        ctx.addIssue({ code: "custom", path: ["INDIAN_MARKET_PROVIDER"], message: "mock market data is only allowed when APP_ENV=development" });
      }
    }
  });

/**
 * Guard for manual scripts that write with the service-role key. Allow-list, not deny-list: an unset,
 * empty or misspelled APP_ENV is refused instead of slipping past a `=== "production"` check.
 */
export function assertManualScriptAllowed(appEnv: string | undefined, script: string): void {
  if (appEnv !== "development" && appEnv !== "staging") {
    throw new Error(
      `Refusing to run ${script}: APP_ENV must be explicitly set to "development" or "staging". ` +
        "Production runs go through the cron route.",
    );
  }
}

export type ClientEnv = z.infer<typeof clientEnvSchema>;
export type ServerEnv = z.infer<typeof serverEnvSchema>;

function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
}

export function parseEnv<T extends z.ZodType>(
  schema: T,
  source: Record<string, unknown>,
  label: string,
): z.infer<T> {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    throw new Error(
      `Invalid ${label} environment variables:\n${formatIssues(parsed.error)}\nSee .env.example.`,
    );
  }
  return parsed.data;
}

let cachedClient: ClientEnv | undefined;

/** Next inlines NEXT_PUBLIC_* only when they are referenced statically, hence the explicit list. */
export function getClientEnv(): ClientEnv {
  cachedClient ??= parseEnv(
    clientEnvSchema,
    {
      NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    },
    "client",
  );
  return cachedClient;
}
