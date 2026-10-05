import "server-only";
import { getServerEnv } from "@/lib/env.server";
import { MarketDataService } from "./market-data-service";
import { buildRegistry } from "./registry-factory";
import { SupabaseMarketDataStore } from "./supabase-store";

let instance: MarketDataService | undefined;

/** Process-wide service (per server instance). Server components/actions call this. */
export function getMarketDataService(): MarketDataService {
  if (!instance) {
    const env = getServerEnv();
    instance = new MarketDataService({
      registry: buildRegistry(env),
      store: new SupabaseMarketDataStore(),
      allowMockData: env.APP_ENV === "development",
    });
  }
  return instance;
}

export type { DataView } from "./market-data-service";
