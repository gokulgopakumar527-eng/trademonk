import { PAPER_EXECUTION_LIMITS, PAPER_SIMULATION } from "@/config/paper-trading";
import type { DataView } from "@/services/market-data/market-data-service";
import type { Asset } from "@/services/market-data/types";
import type {
  ClosedTradePage, CloseTradeStoreParams, CloseTradeStoreResult, OpenTradeStoreParams, OpenTradeStoreResult, PaperTradingDeps, PaperTradingStore, PortfolioSnapshot,
} from "@/services/paper-trading/ports";
import type { Quote } from "@/types/market";

export const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
export const BOB = "bbbbbbbb-0000-4000-8000-000000000002";
export const BTC_ID = "dddddddd-0000-4000-8000-000000000001";
export const RELIANCE_ID = "dddddddd-0000-4000-8000-000000000002";
export const NIFTY_ID = "dddddddd-0000-4000-8000-000000000003";

export const NOW = new Date("2026-10-01T10:00:00.000Z");
const iso = (msBefore: number) => new Date(NOW.getTime() - msBefore).toISOString();

export const BTC: Asset = { id: BTC_ID, market: "CRYPTO", symbol: "BTC", currency: "USDT", kind: "CRYPTO", name: "Bitcoin" };
export const RELIANCE: Asset = { id: RELIANCE_ID, market: "NSE", symbol: "RELIANCE", currency: "INR", kind: "EQUITY", name: "Reliance" };
export const NIFTY: Asset = { id: NIFTY_ID, market: "NSE", symbol: "NIFTY 50", currency: "INR", kind: "INDEX", name: "Nifty 50" };

export const quote = (over: Partial<Quote> = {}): Quote => ({
  source: "binance-public", asOf: iso(5_000), fetchedAt: iso(4_000), isMock: false,
  market: "CRYPTO", symbol: "BTC", currency: "USDT", price: 100, change: 1, changePct: 1, high: 101, low: 99, volume: 10,
  ...over,
});

export const freshView = (q: Quote): DataView<Quote> => ({
  ok: true, data: q, servedFrom: "PROVIDER", freshness: { status: "FRESH", ageMs: 5_000, label: "Data updated" },
});

export const errorView = (): DataView<Quote> => ({
  ok: false, message: "Data unavailable",
  error: { code: "UPSTREAM_ERROR", message: "down", provider: "test", retryable: true },
});

type Cents = bigint; // 1e-8 units
const toUnits = (s: string): Cents => BigInt(s.replace(".", ""));
/** Signed 8-dp decimal string for an amount in 1e-8 units. */
export const fmt8 = (c: Cents): string => `${c < 0n ? "-" : ""}${(c < 0n ? -c : c) / 100_000_000n}.${((c < 0n ? -c : c) % 100_000_000n).toString().padStart(8, "0")}`;
const roundDiv = (num: bigint, den: bigint): bigint => (2n * num + den) / (2n * den); // half-up, non-negative

export interface FakeTrade extends OpenTradeStoreParams { id: string; currency: string; cashDebited: Cents; status: "OPEN" | "CLOSED" }
export interface FakeResult extends CloseTradeStoreParams { tradeId: string; closedAt: string; cashCredited: Cents; pnlUnits: Cents }

export interface FakeStoreState {
  accounts: Map<string, { balance: Cents; starting: Cents; currency: string }>;
  trades: FakeTrade[];
  results: FakeResult[];
}

/**
 * An in-memory stand-in that mirrors open_paper_trade()'s contract: per-user, per-currency accounts
 * created on first use from the supplied starting cash; insufficient cash rejects without any
 * change; a failure during the insert rolls the debit back. The REAL atomicity is proven against
 * PostgreSQL by `pnpm test:db`; this fake only lets the service tests observe what it is asked to do.
 */
export function fakeStore(
  assets: Asset[] = [BTC, RELIANCE, NIFTY],
  opts: { failInsert?: boolean; failClose?: "after-credit" | "after-result" } = {},
) {
  const state: FakeStoreState = { accounts: new Map(), trades: [], results: [] };
  const calls: OpenTradeStoreParams[] = [];
  const closeCalls: CloseTradeStoreParams[] = [];
  const lookups: Array<{ userId: string; tradeId: string }> = [];
  // Models the row lock close_paper_trade() takes: closes of the same trade run one at a time.
  const locks = new Map<string, Promise<void>>();
  const withLock = async <T,>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prev = locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    locks.set(key, prev.then(() => new Promise<void>((r) => { release = r; })));
    await prev;
    try { return await fn(); } finally { release(); }
  };
  const store: PaperTradingStore = {
    async getAssetById(id) {
      return assets.find((a) => a.id === id) ?? null;
    },
    async openTrade(p): Promise<OpenTradeStoreResult> {
      calls.push(p);
      const asset = assets.find((a) => a.id === p.assetId);
      if (!asset) return { ok: false, reason: "ASSET_NOT_FOUND" };
      const key = `${p.userId}:${asset.currency}`;
      const snapshot = new Map([...state.accounts].map(([k, v]) => [k, { ...v }]));
      try {
        if (!state.accounts.has(key)) {
          const start = toUnits(Number(p.startingCash).toFixed(8));
          state.accounts.set(key, { balance: start, starting: start, currency: asset.currency });
        }
        const acct = state.accounts.get(key)!;
        const notional = (toUnits(p.entryPrice) * toUnits(p.quantity) + 50_000_000n) / 100_000_000n;
        const cost = notional + toUnits(p.fee);
        if (acct.balance < cost) throw Object.assign(new Error("PAPER_INSUFFICIENT_CASH"), { business: true });
        acct.balance -= cost;
        if (opts.failInsert) throw new Error("insert failed");
        const id = `00000000-0000-4000-8000-${String(state.trades.length + 1).padStart(12, "0")}`;
        state.trades.push({ ...p, id, currency: asset.currency, cashDebited: cost, status: "OPEN" });
        return {
          ok: true, tradeId: id, openedAt: NOW.toISOString(), currency: asset.currency,
          cashBalanceAfter: `${acct.balance / 100_000_000n}.${(acct.balance % 100_000_000n).toString().padStart(8, "0")}`,
        };
      } catch (e) {
        state.accounts.clear();
        for (const [k, v] of snapshot) state.accounts.set(k, v); // rollback
        if ((e as { business?: boolean }).business) return { ok: false, reason: "INSUFFICIENT_PAPER_CASH" };
        throw e;
      }
    },
    async getTradeForClose(userId, tradeId) {
      lookups.push({ userId, tradeId });
      const t = state.trades.find((x) => x.id === tradeId && x.userId === userId); // owner-scoped, like the real store
      const asset = t && assets.find((a) => a.id === t.assetId);
      if (!t || !asset) return null;
      return {
        tradeId: t.id, userId: t.userId, assetId: t.assetId, side: t.side, status: t.status,
        quantity: t.quantity, cashDebited: fmt8(t.cashDebited), simVersion: t.simVersion, asset,
      };
    },
    async getPortfolioSnapshot(userId): Promise<PortfolioSnapshot> {
      // Owner-scoped like the real store. Account ids are synthetic: one per (user, currency).
      const acctId = (u: string, c: string) => `ac000000-0000-4000-8000-${u.slice(0, 2)}${c === "INR" ? "01" : "02"}00000000`.slice(0, 36);
      const mine = [...state.accounts].filter(([k]) => k.startsWith(`${userId}:`));
      return {
        accounts: mine.map(([, a]) => ({ id: acctId(userId, a.currency), userId, currency: a.currency, startingCash: fmt8(a.starting), cashBalance: fmt8(a.balance) })),
        openTrades: state.trades.filter((t) => t.userId === userId && t.status === "OPEN").flatMap((t) => {
          const asset = assets.find((a) => a.id === t.assetId);
          return asset ? [{ tradeId: t.id, userId, accountId: acctId(userId, t.currency), side: t.side, quantity: t.quantity, cashDebited: fmt8(t.cashDebited), simVersion: t.simVersion, openedAt: NOW.toISOString(), asset }] : [];
        }),
        results: state.results.flatMap((r) => {
          const t = state.trades.find((x) => x.id === r.tradeId);
          return t && t.userId === userId ? [{ resultId: `${r.tradeId}`, tradeId: r.tradeId, userId, accountId: acctId(userId, t.currency), pnl: fmt8(r.pnlUnits) }] : [];
        }),
      };
    },
    async getClosedTrades(userId, limit): Promise<ClosedTradePage> {
      // Owner-scoped and newest-first like the real store; the count is the user's TRUE total.
      const mine = state.results.flatMap((r) => {
        const t = state.trades.find((x) => x.id === r.tradeId);
        const asset = t && assets.find((a) => a.id === t.assetId);
        return t && asset && t.userId === userId ? [{ r, t, asset }] : [];
      }).reverse();
      return {
        totalCount: mine.length,
        rows: mine.slice(0, limit).map(({ r, t, asset }) => ({
          tradeId: t.id, userId, side: t.side, quantity: t.quantity, entryPrice: t.entryPrice, entryFee: t.fee,
          entryCost: fmt8(t.cashDebited), openedAt: NOW.toISOString(), exitPrice: r.exitPrice, exitFee: r.fee,
          cashCredited: fmt8(r.cashCredited), pnl: fmt8(r.pnlUnits), closedAt: r.closedAt, asset,
        })),
      };
    },
    async closeTrade(p): Promise<CloseTradeStoreResult> {
      closeCalls.push(p);
      return withLock(p.tradeId, async () => {
        await Promise.resolve(); // a real interleaving point: without the lock, two closes would both pass the status check
        const t = state.trades.find((x) => x.id === p.tradeId && x.userId === p.userId);
        if (!t) return { ok: false, reason: "TRADE_NOT_FOUND" };
        if (t.status !== "OPEN") return { ok: false, reason: "TRADE_ALREADY_CLOSED" };
        const key = `${t.userId}:${t.currency}`;
        const snapshot = {
          accounts: new Map([...state.accounts].map(([k, v]) => [k, { ...v }])),
          statuses: state.trades.map((x) => x.status),
          results: state.results.length,
        };
        try {
          // Re-derive from the LOCKED row, exactly as the database does, and refuse any disagreement.
          const gross = roundDiv(toUnits(p.exitPrice) * toUnits(t.quantity), 100_000_000n);
          const credit = gross - toUnits(p.fee);
          const pnl = credit - t.cashDebited;
          if (toUnits(p.pnl) !== pnl) throw new Error("PAPER_INVALID_INPUT: realized P&L does not match");
          const acct = state.accounts.get(key)!;
          acct.balance += credit;
          if (opts.failClose === "after-credit") throw new Error("close failed after credit");
          state.results.push({ ...p, tradeId: t.id, closedAt: NOW.toISOString(), cashCredited: credit, pnlUnits: pnl });
          if (opts.failClose === "after-result") throw new Error("close failed after result");
          t.status = "CLOSED";
          return {
            ok: true, tradeId: t.id, closedAt: NOW.toISOString(), currency: t.currency,
            cashBalanceAfter: fmt8(acct.balance), cashCredited: fmt8(credit), pnl: fmt8(pnl),
          };
        } catch (e) {
          state.accounts.clear();
          for (const [k, v] of snapshot.accounts) state.accounts.set(k, v); // rollback
          state.trades.forEach((x, i) => { x.status = snapshot.statuses[i]!; });
          state.results.length = snapshot.results;
          throw e;
        }
      });
    },
  };
  return { store, state, calls, closeCalls, lookups };
}

export function makeDeps(over: Partial<PaperTradingDeps> & { quoteView?: DataView<Quote>; store?: PaperTradingStore } = {}) {
  const fs = fakeStore();
  const quoteCalls: Asset[] = [];
  const auditCalls: unknown[] = [];
  const { quoteView, ...rest } = over;
  const deps: PaperTradingDeps = {
    marketData: {
      getQuote: async (asset) => {
        quoteCalls.push(asset);
        return quoteView ?? freshView(quote());
      },
    },
    store: fs.store,
    audit: async (e) => void auditCalls.push(e),
    now: () => NOW,
    config: PAPER_SIMULATION,
    limits: PAPER_EXECUTION_LIMITS,
    allowMockData: false,
    ...rest,
  };
  return { deps, fs, quoteCalls, auditCalls };
}
