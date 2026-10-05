import type { DataView } from "@/services/market-data/market-data-service";
import type { Asset } from "@/services/market-data/types";
import type { PaperTradingDeps } from "@/services/paper-trading/ports";
import { createPaperTradingService } from "@/services/paper-trading/paper-trading-service";
import type { Quote } from "@/types/market";
import { ALICE, BTC, BTC_ID, NIFTY, NOW, RELIANCE, fakeStore, freshView, makeDeps, quote } from "./open-helpers";

export const NSE_QUOTE = (price: number) => quote({ market: "NSE", symbol: "RELIANCE", currency: "INR", price });

/**
 * A service wired to the in-memory store with a MUTABLE market quote, so a test can open a trade at
 * one price and close it at another. All of it is fake I/O: real atomicity and locking are asserted
 * against PostgreSQL by `pnpm test:db`.
 */
export function makeCloseCtx(opts: {
  assets?: Asset[];
  storeOpts?: Parameters<typeof fakeStore>[1];
  deps?: Partial<PaperTradingDeps>;
} = {}) {
  const storeOpts = opts.storeOpts ?? {};
  const fs = fakeStore(opts.assets ?? [BTC, RELIANCE, NIFTY], storeOpts);
  let current: DataView<Quote> = freshView(quote());
  const quoteCalls: Asset[] = [];
  const { deps, auditCalls } = makeDeps({
    store: fs.store,
    marketData: {
      getQuote: async (asset) => {
        quoteCalls.push(asset);
        return current;
      },
    },
    ...opts.deps,
  });
  const service = createPaperTradingService(deps);
  return {
    deps, fs, service, auditCalls, quoteCalls, storeOpts,
    /** Sets what the market-data facade returns from now on. */
    setQuote: (v: DataView<Quote>) => { current = v; },
    setPrice: (price: number, over: Partial<Quote> = {}) => { current = freshView(quote({ price, ...over })); },
    /** Opens a BUY of `qty` BTC at the current quote and returns its trade id. */
    openBtc: async (userId = ALICE, qty: number | string = 2) =>
      (await service.openTrade(userId, { assetId: BTC_ID, side: "BUY", quantity: qty })).id,
  };
}

export type CloseCtx = ReturnType<typeof makeCloseCtx>;
export { NOW };
