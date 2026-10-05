import type { ServerEnv } from "@/lib/env";
import { loadIndiaCalendar } from "./calendar-loader";
import { MarketDataRegistry } from "./registry";
import { BinanceCryptoProvider } from "./providers/crypto/binance-provider";
import { IndianMarketProvider } from "./providers/indian/indian-provider";
import { MockMarketProvider } from "./providers/mock/mock-provider";
import type { MarketDataProvider } from "./provider";

type Config = Pick<ServerEnv, "APP_ENV" | "CRYPTO_PROVIDER" | "BINANCE_BASE_URL" | "INDIAN_MARKET_PROVIDER">;

/**
 * Env -> registry. Crypto and Indian providers are separate objects with separate chains.
 * Mock is honoured only in development (the MockMarketProvider constructor also enforces this).
 * Real Indian vendor adapters are added here as new cases once a licensed vendor is chosen.
 */
export function buildRegistry(cfg: Config): MarketDataRegistry {
  const mock = cfg.APP_ENV === "development" ? new MockMarketProvider({ appEnv: cfg.APP_ENV }) : null;

  const crypto: MarketDataProvider =
    cfg.CRYPTO_PROVIDER === "mock" && mock
      ? mock
      : new BinanceCryptoProvider({ baseUrl: cfg.BINANCE_BASE_URL });

  // Indian chain: our own status logic + (optional) vendor adapter. Mock data is a *separate*
  // fallback so status stays real while quotes are labelled mock in development.
  const indian = new IndianMarketProvider({ calendar: loadIndiaCalendar() });
  const indianChain: MarketDataProvider[] = [indian];
  if (cfg.INDIAN_MARKET_PROVIDER === "mock" && mock) indianChain.push(mock);

  return new MarketDataRegistry({ CRYPTO: [crypto], NSE: indianChain, BSE: indianChain });
}
