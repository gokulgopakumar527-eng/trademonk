import "server-only";
import { parseEnv, serverEnvSchema, type ServerEnv } from "@/lib/env";

let cached: ServerEnv | undefined;

export function getServerEnv(): ServerEnv {
  cached ??= parseEnv(
    serverEnvSchema,
    {
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
      // Passed through untouched: no `|| undefined`, no default, no trimming or case folding.
      // An unset, empty or malformed APP_ENV must fail validation, not become "development".
      APP_ENV: process.env.APP_ENV,
      VERCEL_ENV: process.env.VERCEL_ENV || undefined,
      CRYPTO_PROVIDER: process.env.CRYPTO_PROVIDER || undefined,
      BINANCE_BASE_URL: process.env.BINANCE_BASE_URL || undefined,
      INDIAN_MARKET_PROVIDER: process.env.INDIAN_MARKET_PROVIDER || undefined,
      CRON_SECRET: process.env.CRON_SECRET || undefined,
    },
    "server",
  );
  return cached;
}
