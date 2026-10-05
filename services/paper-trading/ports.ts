/**
 * Dependencies the paper-trading service is allowed to have. The required call path is:
 *
 *   Server Action / API route -> Paper Trading Service -> Market Data Service -> provider
 *
 * so market data arrives ONLY through the MarketDataService facade (never a provider), the service
 * never calls `fetch` or a browser API, and persistence goes through one narrow store port whose
 * only implementation (supabase-store.ts) talks to the database.
 */
import type { AuditEntry } from "@/services/audit/audit-service";
import type { DataView } from "@/services/market-data/market-data-service";
import type { Asset } from "@/services/market-data/types";
import type { Quote } from "@/types/market";
import type { PaperExecutionLimits, PaperSimulationConfig } from "@/config/paper-trading";
import type { OpenablePaperSide, PaperTradeSide, PaperTradeStatus } from "./types";

/** The slice of MarketDataService paper trading may use. A test pins it to the real facade. */
export interface PaperTradingMarketData {
  getQuote(asset: Asset): Promise<DataView<Quote>>;
}

/**
 * Everything the database needs to open one trade atomically. Amounts are exact decimal strings.
 * `userId` is the verified session user; there is no other source of identity.
 */
export interface OpenTradeStoreParams {
  userId: string;
  assetId: string;
  side: OpenablePaperSide;
  quantity: string;
  entryPrice: string;
  fee: string;
  /** Opening balance for a first-time account, from the server-side simulation config. */
  startingCash: string;
  simVersion: string;
  referencePrice: string;
  slippageBps: string;
  feeBps: string;
  quote: { source: string; asOf: string; fetchedAt: string; isMock: boolean };
  /** One per user intent; a retry of the same intended open reuses it. Validated by the input schema. */
  idempotencyKey: string;
}

/** The stored trade, as the database recorded it. Present on every successful open; used for replays. */
export interface StoredOpenReceipt {
  assetId: string;
  side: string;
  quantity: string;
  entryPrice: string;
  fee: string;
  referencePrice: string;
  notional: string;
  cashDebited: string;
  slippageBps: string;
  feeBps: string;
  simVersion: string;
  quote: { source: string; asOf: string; fetchedAt: string; isMock: boolean };
}

export type OpenTradeStoreResult =
  | {
      ok: true;
      tradeId: string;
      openedAt: string;
      currency: string;
      cashBalanceAfter: string;
      /** true: the key was already used for this same trade; nothing new was created or debited. */
      replayed: boolean;
      stored: StoredOpenReceipt;
    }
  | { ok: false; reason: "INSUFFICIENT_PAPER_CASH" | "ASSET_NOT_FOUND" | "IDEMPOTENCY_KEY_REUSED" };

/**
 * What the close flow reads about a trade before pricing it. Exact decimal STRINGS (never floats):
 * `quantity` and `cashDebited` come back from the database as text so no precision is lost. The
 * lookup is scoped to the owner, so a trade belonging to someone else is indistinguishable from one
 * that does not exist.
 */
export interface CloseCandidate {
  tradeId: string;
  userId: string;
  assetId: string;
  side: PaperTradeSide;
  status: PaperTradeStatus;
  quantity: string;
  /** Entry notional + entry fee, as recorded when the trade opened. Null for pre-accounting rows. */
  cashDebited: string | null;
  /** Null for rows that predate execution accounting; those cannot be settled. */
  simVersion: string | null;
  asset: Asset;
}

/**
 * Everything the database needs to close one trade atomically. Amounts are exact decimal strings
 * computed by the server. `userId` is the verified session user; there is no other source of identity.
 */
export interface CloseTradeStoreParams {
  userId: string;
  tradeId: string;
  exitPrice: string;
  fee: string;
  /** Realized P&L, server-computed. The database re-derives it from the locked trade row and must agree. */
  pnl: string;
  simVersion: string;
  referencePrice: string;
  slippageBps: string;
  feeBps: string;
  quote: { source: string; asOf: string; fetchedAt: string; isMock: boolean };
}

export type CloseTradeStoreResult =
  | {
      ok: true;
      tradeId: string;
      closedAt: string;
      currency: string;
      cashBalanceAfter: string;
      cashCredited: string;
      pnl: string;
    }
  | { ok: false; reason: "TRADE_NOT_FOUND" | "TRADE_ALREADY_CLOSED" | "TRADE_NOT_CLOSABLE" };

/** Read-only portfolio rows. Exact decimal STRINGS from the database; every row carries its owner. */
export interface PortfolioAccountRow {
  id: string;
  userId: string;
  currency: string;
  startingCash: string;
  cashBalance: string;
}

export interface PortfolioOpenTradeRow {
  tradeId: string;
  userId: string;
  accountId: string | null;
  side: PaperTradeSide;
  quantity: string;
  cashDebited: string | null;
  simVersion: string | null;
  openedAt: string;
  asset: Asset;
}

export interface PortfolioResultRow {
  resultId: string;
  tradeId: string;
  userId: string;
  accountId: string | null;
  /** Realized P&L, signed exact decimal text. */
  pnl: string;
}

/** Everything the portfolio calculation reads, in full (never silently truncated). */
export interface PortfolioSnapshot {
  accounts: PortfolioAccountRow[];
  openTrades: PortfolioOpenTradeRow[];
  results: PortfolioResultRow[];
}

/** One closed trade as stored: the trade row joined (in the store) with its immutable result row. Exact decimal STRINGS. */
export interface ClosedTradeRow {
  tradeId: string;
  userId: string;
  side: PaperTradeSide;
  quantity: string;
  entryPrice: string;
  entryFee: string;
  entryCost: string | null;
  openedAt: string;
  exitPrice: string;
  exitFee: string;
  cashCredited: string | null;
  pnl: string;
  closedAt: string;
  asset: Asset;
}

export interface ClosedTradePage {
  /** Most recent first, at most `limit` rows. */
  rows: ClosedTradeRow[];
  /** All of the user's closed trades, so a short page is never mistaken for the whole history. */
  totalCount: number;
}

export interface PaperTradingStore {
  getAssetById(id: string): Promise<Asset | null>;
  /** One transaction: lock account, check cash, debit, insert trade. Throws on unexpected failure. */
  openTrade(params: OpenTradeStoreParams): Promise<OpenTradeStoreResult>;
  /** The caller's own trade (any status) with its asset, or null. Throws on unexpected failure. */
  getTradeForClose(userId: string, tradeId: string): Promise<CloseCandidate | null>;
  /** One transaction: lock trade, re-derive, credit account, write result, mark CLOSED. Throws on unexpected failure. */
  closeTrade(params: CloseTradeStoreParams): Promise<CloseTradeStoreResult>;
  /**
   * Read-only. The caller's own accounts, OPEN trades (with assets) and closed-trade results,
   * scoped to `userId`. Must return every row or throw: a truncated page would silently understate
   * the portfolio.
   */
  getPortfolioSnapshot(userId: string): Promise<PortfolioSnapshot>;
  /** Read-only. The caller's most recent closed trades (newest first), scoped to `userId`, plus the true total. */
  getClosedTrades(userId: string, limit: number): Promise<ClosedTradePage>;
}

export interface PaperTradingDeps {
  marketData: PaperTradingMarketData;
  store: PaperTradingStore;
  audit: (entry: AuditEntry) => Promise<void>;
  now: () => Date;
  config: Readonly<PaperSimulationConfig>;
  limits: Readonly<PaperExecutionLimits>;
  /** True only in development. Mock quotes must be refused everywhere else. */
  allowMockData: boolean;
}
