import "server-only";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Asset } from "@/services/market-data/types";
import type { Market } from "@/types/domain";
import type { AssetKind } from "@/types/market";
import type {
  ClosedTradePage,
  CloseCandidate,
  CloseTradeStoreParams,
  CloseTradeStoreResult,
  OpenTradeStoreParams,
  OpenTradeStoreResult,
  PaperTradingStore,
  PortfolioSnapshot,
} from "./ports";
import { PAPER_TRADE_SIDES, PAPER_TRADE_STATUSES } from "./types";

interface AssetRow {
  id: string;
  market: Market;
  symbol: string;
  name: string;
  asset_type: AssetKind;
  currency: string;
}

interface OpenRpcPayload {
  trade: { id: string; opened_at: string };
  currency: string;
  cash_balance_after: string;
}

interface CloseRpcPayload {
  result: { paper_trade_id: string; closed_at: string };
  currency: string;
  cash_balance_after: string;
  cash_credited: string;
  pnl: string;
}

/** What getTradeForClose selects. `quantity` and `cash_debited` are cast to text so no float rounding can occur. */
interface TradeRow {
  id: string;
  user_id: string;
  asset_id: string;
  side: string;
  status: string;
  quantity: string | number;
  cash_debited: string | number | null;
  sim_version: string | null;
}

/** Text for a numeric column. PostgREST honours `col::text`; a bare number is stringified (still verified by the database). */
const exactText = (v: string | number | null): string | null => (v === null ? null : typeof v === "string" ? v : v.toFixed(8));

const PAGE = 500; // below PostgREST's default 1000-row cap, so a short page really is the last page
const MAX_PAGES = 40; // 20k rows per table; beyond that we fail rather than silently truncate
const ID_CHUNK = 100;

/** Reads EVERY row of a paged query. Throws instead of returning a truncated set. */
async function readAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let i = 0; i < MAX_PAGES; i++) {
    const { data, error } = await page(i * PAGE, i * PAGE + PAGE - 1);
    if (error) throw error;
    const batch = (data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < PAGE) return rows;
  }
  throw new Error("paper portfolio: too many rows to read safely");
}

interface PfAccountRow { id: string; user_id: string; currency: string; starting_cash: string; cash_balance: string }
interface PfTradeRow { id: string; user_id: string; account_id: string | null; asset_id: string; side: string; quantity: string; cash_debited: string | null; sim_version: string | null; opened_at: string }
interface CtResultRow { id: string; paper_trade_id: string; user_id: string; exit_price: string; fees: string; pnl: string; cash_credited: string | null; closed_at: string }
interface CtTradeRow { id: string; user_id: string; asset_id: string; side: string; quantity: string; entry_price: string; fees: string; cash_debited: string | null; opened_at: string }
interface PfResultRow { id: string; paper_trade_id: string; user_id: string; account_id: string | null; pnl: string }

/**
 * Persists with the SERVICE ROLE, deliberately: `authenticated` has no INSERT grant on
 * paper_trades, no write grant on paper_accounts or paper_trade_results and no EXECUTE on
 * open_paper_trade() / close_paper_trade(). The caller passes the user id from the verified
 * session, never from the client.
 *
 * All cash movement, the trade insert, the result insert and the status change happen inside the
 * single open_paper_trade() / close_paper_trade() calls, so this class never writes a balance, a
 * trade or a result directly.
 */
export class SupabasePaperTradingStore implements PaperTradingStore {
  async getAssetById(id: string): Promise<Asset | null> {
    const { data, error } = await createSupabaseAdminClient()
      .from("assets")
      .select("id, market, symbol, name, asset_type, currency")
      .eq("id", id)
      .eq("is_active", true)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const a = data as AssetRow;
    return { id: a.id, market: a.market, symbol: a.symbol, name: a.name, kind: a.asset_type, currency: a.currency };
  }

  async openTrade(p: OpenTradeStoreParams): Promise<OpenTradeStoreResult> {
    const { data, error } = await createSupabaseAdminClient().rpc("open_paper_trade", {
      p_user_id: p.userId,
      p_asset_id: p.assetId,
      p_side: p.side,
      p_quantity: p.quantity,
      p_entry_price: p.entryPrice,
      p_fee: p.fee,
      p_starting_cash: p.startingCash,
      p_sim_version: p.simVersion,
      p_reference_price: p.referencePrice,
      p_slippage_bps: p.slippageBps,
      p_fee_bps: p.feeBps,
      p_quote_source: p.quote.source,
      p_quote_as_of: p.quote.asOf,
      p_quote_fetched_at: p.quote.fetchedAt,
      p_quote_is_mock: p.quote.isMock,
    });
    if (error) {
      // Expected business outcomes raise a coded exception; the transaction has already rolled back.
      if (error.message?.includes("PAPER_INSUFFICIENT_CASH")) return { ok: false, reason: "INSUFFICIENT_PAPER_CASH" };
      if (error.message?.includes("PAPER_ASSET_NOT_FOUND")) return { ok: false, reason: "ASSET_NOT_FOUND" };
      throw error;
    }
    const payload = data as OpenRpcPayload | null;
    if (!payload?.trade?.id || !payload.trade.opened_at || !payload.currency || payload.cash_balance_after == null) {
      throw new Error("open_paper_trade returned an unexpected payload");
    }
    return {
      ok: true,
      tradeId: payload.trade.id,
      openedAt: payload.trade.opened_at,
      currency: payload.currency,
      cashBalanceAfter: payload.cash_balance_after,
    };
  }
  async getTradeForClose(userId: string, tradeId: string): Promise<CloseCandidate | null> {
    const admin = createSupabaseAdminClient();
    // Scoped by id AND owner: another user's trade is indistinguishable from a missing one.
    const { data, error } = await admin
      .from("paper_trades")
      .select("id, user_id, asset_id, side, status, quantity::text, cash_debited::text, sim_version")
      .eq("id", tradeId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const t = data as unknown as TradeRow;
    if (!(PAPER_TRADE_SIDES as readonly string[]).includes(t.side) || !(PAPER_TRADE_STATUSES as readonly string[]).includes(t.status)) {
      throw new Error("paper_trades returned an unexpected side or status");
    }
    const quantity = exactText(t.quantity);
    if (quantity === null) throw new Error("paper_trades returned a null quantity");

    // Not filtered by is_active: a position must stay closable even if its asset was later retired.
    const { data: a, error: assetError } = await admin
      .from("assets")
      .select("id, market, symbol, name, asset_type, currency")
      .eq("id", t.asset_id)
      .maybeSingle();
    if (assetError) throw assetError;
    if (!a) throw new Error("the trade's asset is missing");
    const asset = a as AssetRow;
    return {
      tradeId: t.id,
      userId: t.user_id,
      assetId: t.asset_id,
      side: t.side as CloseCandidate["side"],
      status: t.status as CloseCandidate["status"],
      quantity,
      cashDebited: exactText(t.cash_debited),
      simVersion: t.sim_version,
      asset: { id: asset.id, market: asset.market, symbol: asset.symbol, name: asset.name, kind: asset.asset_type, currency: asset.currency },
    };
  }

  async closeTrade(p: CloseTradeStoreParams): Promise<CloseTradeStoreResult> {
    const { data, error } = await createSupabaseAdminClient().rpc("close_paper_trade", {
      p_user_id: p.userId,
      p_trade_id: p.tradeId,
      p_exit_price: p.exitPrice,
      p_fee: p.fee,
      p_pnl: p.pnl,
      p_sim_version: p.simVersion,
      p_reference_price: p.referencePrice,
      p_slippage_bps: p.slippageBps,
      p_fee_bps: p.feeBps,
      p_quote_source: p.quote.source,
      p_quote_as_of: p.quote.asOf,
      p_quote_fetched_at: p.quote.fetchedAt,
      p_quote_is_mock: p.quote.isMock,
    });
    if (error) {
      // Expected business outcomes raise a coded exception; the transaction has already rolled back.
      const msg = error.message ?? "";
      if (msg.includes("PAPER_TRADE_NOT_FOUND")) return { ok: false, reason: "TRADE_NOT_FOUND" };
      if (msg.includes("PAPER_TRADE_NOT_OPEN")) return { ok: false, reason: "TRADE_ALREADY_CLOSED" };
      if (msg.includes("PAPER_TRADE_NOT_CLOSABLE")) return { ok: false, reason: "TRADE_NOT_CLOSABLE" };
      // A racing duplicate that slipped past the row lock still hits UNIQUE(paper_trade_id).
      if (error.code === "23505") return { ok: false, reason: "TRADE_ALREADY_CLOSED" };
      throw error;
    }
    const payload = data as CloseRpcPayload | null;
    if (
      !payload?.result?.paper_trade_id || !payload.result.closed_at || !payload.currency ||
      payload.cash_balance_after == null || payload.cash_credited == null || payload.pnl == null
    ) {
      throw new Error("close_paper_trade returned an unexpected payload");
    }
    return {
      ok: true,
      tradeId: payload.result.paper_trade_id,
      closedAt: payload.result.closed_at,
      currency: payload.currency,
      cashBalanceAfter: payload.cash_balance_after,
      cashCredited: payload.cash_credited,
      pnl: payload.pnl,
    };
  }
  /** Read-only and scoped by user_id on every query. Numerics are cast to text so no precision is lost. */
  async getPortfolioSnapshot(userId: string): Promise<PortfolioSnapshot> {
    const admin = createSupabaseAdminClient();
    const accounts = await readAll<PfAccountRow>((from, to) =>
      admin.from("paper_accounts").select("id, user_id, currency, starting_cash::text, cash_balance::text")
        .eq("user_id", userId).order("id").range(from, to));
    const trades = await readAll<PfTradeRow>((from, to) =>
      admin.from("paper_trades").select("id, user_id, account_id, asset_id, side, quantity::text, cash_debited::text, sim_version, opened_at")
        .eq("user_id", userId).eq("status", "OPEN").order("id").range(from, to));
    const results = await readAll<PfResultRow>((from, to) =>
      admin.from("paper_trade_results").select("id, paper_trade_id, user_id, account_id, pnl::text")
        .eq("user_id", userId).order("id").range(from, to));

    // Not filtered by is_active: a position must stay valued even if its asset was later retired.
    const ids = [...new Set(trades.map((t) => t.asset_id))];
    const assets = new Map<string, Asset>();
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const { data, error } = await admin.from("assets").select("id, market, symbol, name, asset_type, currency").in("id", ids.slice(i, i + ID_CHUNK));
      if (error) throw error;
      for (const a of (data ?? []) as AssetRow[]) {
        assets.set(a.id, { id: a.id, market: a.market, symbol: a.symbol, name: a.name, kind: a.asset_type, currency: a.currency });
      }
    }
    return {
      accounts: accounts.map((a) => ({ id: a.id, userId: a.user_id, currency: a.currency, startingCash: String(a.starting_cash), cashBalance: String(a.cash_balance) })),
      openTrades: trades.map((t) => {
        if (!(PAPER_TRADE_SIDES as readonly string[]).includes(t.side)) throw new Error("paper_trades returned an unexpected side");
        const asset = assets.get(t.asset_id);
        if (!asset) throw new Error("an open trade's asset is missing");
        return {
          tradeId: t.id, userId: t.user_id, accountId: t.account_id, side: t.side as PortfolioSnapshot["openTrades"][number]["side"],
          quantity: String(t.quantity), cashDebited: exactText(t.cash_debited), simVersion: t.sim_version, openedAt: t.opened_at, asset,
        };
      }),
      results: results.map((r) => ({ resultId: r.id, tradeId: r.paper_trade_id, userId: r.user_id, accountId: r.account_id, pnl: String(r.pnl) })),
    };
  }

  /**
   * Read-only, owner-scoped on every query. The result rows are the authoritative close records; the
   * matching trade rows supply the entry. Numerics are cast to text so no precision is lost. A result
   * whose trade or asset cannot be found fails the read: a history row is never half-shown.
   */
  async getClosedTrades(userId: string, limit: number): Promise<ClosedTradePage> {
    const admin = createSupabaseAdminClient();
    const cap = Math.max(1, Math.min(100, Math.trunc(limit))); // one `.in()` chunk, always
    const { data: res, count, error } = await admin
      .from("paper_trade_results")
      .select("id, paper_trade_id, user_id, exit_price::text, fees::text, pnl::text, cash_credited::text, closed_at", { count: "exact" })
      .eq("user_id", userId)
      .order("closed_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(cap);
    if (error) throw error;
    const results = (res ?? []) as unknown as CtResultRow[];
    if (typeof count !== "number") throw new Error("paper_trade_results returned no count");
    if (results.length === 0) return { rows: [], totalCount: count };

    const { data: tr, error: tradeError } = await admin
      .from("paper_trades")
      .select("id, user_id, asset_id, side, quantity::text, entry_price::text, fees::text, cash_debited::text, opened_at")
      .eq("user_id", userId)
      .in("id", results.map((r) => r.paper_trade_id));
    if (tradeError) throw tradeError;
    const trades = new Map(((tr ?? []) as unknown as CtTradeRow[]).map((t) => [t.id, t]));

    const assetIds = [...new Set([...trades.values()].map((t) => t.asset_id))];
    const { data: as, error: assetError } = await admin
      .from("assets")
      .select("id, market, symbol, name, asset_type, currency")
      .in("id", assetIds);
    if (assetError) throw assetError;
    const assets = new Map(((as ?? []) as AssetRow[]).map((a) => [a.id, a]));

    return {
      totalCount: count,
      rows: results.map((r) => {
        const t = trades.get(r.paper_trade_id);
        const a = t && assets.get(t.asset_id);
        if (!t || !a) throw new Error("a closed trade's record or asset is missing");
        if (!(PAPER_TRADE_SIDES as readonly string[]).includes(t.side)) throw new Error("paper_trades returned an unexpected side");
        return {
          tradeId: t.id, userId: r.user_id, side: t.side as ClosedTradePage["rows"][number]["side"],
          quantity: String(t.quantity), entryPrice: String(t.entry_price), entryFee: String(t.fees),
          entryCost: exactText(t.cash_debited), openedAt: t.opened_at,
          exitPrice: String(r.exit_price), exitFee: String(r.fees), cashCredited: exactText(r.cash_credited),
          pnl: String(r.pnl), closedAt: r.closed_at,
          asset: { id: a.id, market: a.market, symbol: a.symbol, name: a.name, kind: a.asset_type, currency: a.currency },
        };
      }),
    };
  }
}
