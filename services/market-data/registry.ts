import { logger } from "@/lib/logger";
import type { Market } from "@/types/domain";
import type { Capability, ProviderError, Result } from "@/types/market";
import type { MarketDataProvider } from "./provider";
import { fail } from "./result";

export type MarketRouting = Partial<Record<Market, readonly MarketDataProvider[]>>;

/**
 * market -> ordered provider chain (primary first, then fallbacks). A market may only route to
 * providers that declare that market, so a crypto provider can never answer an NSE request.
 */
export class MarketDataRegistry {
  private readonly chains = new Map<Market, readonly MarketDataProvider[]>();

  constructor(routing: MarketRouting) {
    for (const [market, providers] of Object.entries(routing) as [Market, readonly MarketDataProvider[]][]) {
      for (const p of providers) {
        if (!p.capabilities.markets.includes(market)) {
          throw new Error(`Provider ${p.id} does not support market ${market}`);
        }
      }
      this.chains.set(market, providers);
    }
  }

  chain(market: Market): readonly MarketDataProvider[] {
    return this.chains.get(market) ?? [];
  }

  primary(market: Market): MarketDataProvider | undefined {
    return this.chain(market)[0];
  }

  /**
   * Run `fn` against each provider in the chain that claims `capability`; return the first success.
   * If none succeed, return the FIRST error (the primary's; the most informative one).
   * Providers lacking the capability are skipped without being called.
   */
  async execute<T>(
    market: Market,
    capability: Capability,
    fn: (provider: MarketDataProvider) => Promise<Result<T>>,
  ): Promise<Result<T>> {
    const chain = this.chain(market);
    if (chain.length === 0) {
      return fail("registry", "NOT_CONFIGURED", `No provider configured for ${market}`, { retryable: false });
    }
    let firstError: ProviderError | undefined;
    for (const provider of chain) {
      if (!provider.capabilities.supports[capability]) {
        firstError ??= {
          code: "UNSUPPORTED",
          message: `${provider.id} does not support ${capability}`,
          provider: provider.id,
          retryable: false,
        };
        continue;
      }
      let result: Result<T>;
      try {
        result = await fn(provider);
      } catch (e) {
        // Adapters must not throw; if one does, contain it as an upstream error.
        logger.error("market_data.provider_threw", { provider: provider.id, capability, error: e });
        result = fail(provider.id, "UPSTREAM_ERROR", "provider threw unexpectedly");
      }
      if (result.ok) return result;
      firstError ??= result.error;
      logger.warn("market_data.provider_failed", {
        provider: provider.id,
        capability,
        market,
        code: result.error.code,
      });
    }
    return { ok: false, error: firstError! };
  }

  /** Snapshot for the admin "market providers" view: no secrets, just capability metadata. */
  describe() {
    return [...this.chains.entries()].map(([market, providers]) => ({
      market,
      providers: providers.map((p) => ({
        id: p.id,
        displayName: p.displayName,
        supports: p.capabilities.supports,
        timeframes: p.capabilities.timeframes,
      })),
    }));
  }
}
