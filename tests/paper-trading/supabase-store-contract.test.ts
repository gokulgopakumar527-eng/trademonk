/**
 * Locks the request/response CONTRACT between SupabasePaperTradingStore and PostgREST: RPC argument
 * names, error-to-outcome mapping, payload validation and the `::text` casts on every numeric read.
 * The admin client is faked, so this is a LOCAL unit test: it is NOT Supabase verification.
 * (The same shapes were also exercised against a local PostgREST during Phase 5C-7B; see docs/staging-smoke-test.md.)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface Call {
  table?: string;
  select?: string;
  filters: [string, unknown][];
  rpc?: string;
  args?: unknown;
}
const calls: Call[] = [];
let rpcResult: { data: unknown; error: { message: string; code?: string } | null };
let tableResults: Record<
  string,
  { data: unknown; error: null | { message: string }; count?: number }
>;

function builder(table: string) {
  const call: Call = { table, filters: [] };
  calls.push(call);
  const b: Record<string, unknown> = {};
  const chain = () => b;
  b.select = (s: string) => {
    call.select = s;
    return b;
  };
  for (const m of ["eq", "in"])
    b[m] = (c: string, v: unknown) => {
      call.filters.push([c, v]);
      return b;
    };
  for (const m of ["order", "range", "limit"]) b[m] = chain;
  b.maybeSingle = () => Promise.resolve(tableResults[table] ?? { data: null, error: null });
  b.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
    Promise.resolve(tableResults[table] ?? { data: [], error: null }).then(ok, bad);
  return b;
}
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({
    from: (t: string) => builder(t),
    rpc: (name: string, args: unknown) => {
      calls.push({ rpc: name, args, filters: [] });
      return Promise.resolve(rpcResult);
    },
  }),
}));

import { SupabasePaperTradingStore } from "@/services/paper-trading/supabase-store";

const quote = {
  source: "s",
  asOf: "2026-10-03T00:00:00Z",
  fetchedAt: "2026-10-03T00:00:01Z",
  isMock: true,
};
const openParams = {
  userId: "u",
  assetId: "a",
  side: "BUY" as const,
  quantity: "0.12345678",
  entryPrice: "61265.18517407",
  fee: "7.56360249",
  startingCash: "10000.00000000",
  simVersion: "PAPER_SIM_V1",
  referencePrice: "61234.56789012",
  slippageBps: "5.000",
  feeBps: "10.000",
  quote,
};
const closeParams = {
  userId: "u",
  tradeId: "t",
  exitPrice: "61469.25000001",
  fee: "7.58879567",
  pnl: "10.04078817",
  simVersion: "PAPER_SIM_V1",
  referencePrice: "61500.00000001",
  slippageBps: "5.000",
  feeBps: "10.000",
  quote,
};
const store = new SupabasePaperTradingStore();

beforeEach(() => {
  calls.length = 0;
  rpcResult = { data: null, error: null };
  tableResults = {};
});

describe("SupabasePaperTradingStore ↔ PostgREST contract (local, faked client)", () => {
  it("sends exact-decimal STRINGS under the RPC's parameter names and parses the jsonb payload", async () => {
    rpcResult = {
      data: {
        trade: { id: "t1", opened_at: "2026-10-03T07:04:07.8+00:00" },
        currency: "USDT",
        cash_balance_after: "2428.83390982",
      },
      error: null,
    };
    expect(await store.openTrade(openParams)).toEqual({
      ok: true,
      tradeId: "t1",
      openedAt: "2026-10-03T07:04:07.8+00:00",
      currency: "USDT",
      cashBalanceAfter: "2428.83390982",
    });
    const c = calls.find((x) => x.rpc === "open_paper_trade")!;
    expect(c.args).toMatchObject({
      p_quantity: "0.12345678",
      p_entry_price: "61265.18517407",
      p_fee: "7.56360249",
      p_starting_cash: "10000.00000000",
      p_quote_is_mock: true,
    });
    expect(Object.keys(c.args as object).sort()).toEqual([
      "p_asset_id",
      "p_entry_price",
      "p_fee",
      "p_fee_bps",
      "p_quantity",
      "p_quote_as_of",
      "p_quote_fetched_at",
      "p_quote_is_mock",
      "p_quote_source",
      "p_reference_price",
      "p_side",
      "p_sim_version",
      "p_slippage_bps",
      "p_starting_cash",
      "p_user_id",
    ]);
    for (const v of Object.values(c.args as Record<string, unknown>))
      expect(typeof v === "number").toBe(false);
  });

  it("maps coded exceptions to business outcomes and rethrows everything else", async () => {
    rpcResult = { data: null, error: { message: "PAPER_INSUFFICIENT_CASH" } };
    expect(await store.openTrade(openParams)).toEqual({
      ok: false,
      reason: "INSUFFICIENT_PAPER_CASH",
    });
    rpcResult = { data: null, error: { message: "PAPER_ASSET_NOT_FOUND" } };
    expect(await store.openTrade(openParams)).toEqual({ ok: false, reason: "ASSET_NOT_FOUND" });
    for (const [message, reason] of [
      ["PAPER_TRADE_NOT_FOUND", "TRADE_NOT_FOUND"],
      ["PAPER_TRADE_NOT_OPEN", "TRADE_ALREADY_CLOSED"],
      ["PAPER_TRADE_NOT_CLOSABLE", "TRADE_NOT_CLOSABLE"],
    ] as const) {
      rpcResult = { data: null, error: { message } };
      expect(await store.closeTrade(closeParams)).toEqual({ ok: false, reason });
    }
    rpcResult = { data: null, error: { message: "duplicate key", code: "23505" } };
    expect(await store.closeTrade(closeParams)).toEqual({
      ok: false,
      reason: "TRADE_ALREADY_CLOSED",
    });
    rpcResult = {
      data: null,
      error: { message: "PAPER_INVALID_INPUT: fee does not match", code: "P0001" },
    };
    await expect(store.closeTrade(closeParams)).rejects.toMatchObject({
      message: expect.stringContaining("PAPER_INVALID_INPUT"),
    });
    rpcResult = {
      data: null,
      error: { message: "permission denied for function open_paper_trade", code: "42501" },
    };
    await expect(store.openTrade(openParams)).rejects.toBeDefined();
  });

  it("rejects malformed RPC payloads instead of guessing (numbers where text is required, missing fields)", async () => {
    for (const data of [
      null,
      {},
      { trade: { id: "t" }, currency: "USDT", cash_balance_after: "1" },
      { trade: { id: "t", opened_at: "x" }, currency: "USDT" },
    ]) {
      rpcResult = { data, error: null };
      await expect(store.openTrade(openParams)).rejects.toThrow("unexpected payload");
    }
    for (const data of [
      null,
      {
        result: { paper_trade_id: "t", closed_at: "x" },
        currency: "USDT",
        cash_balance_after: "1",
        cash_credited: "1",
      },
    ]) {
      rpcResult = { data, error: null };
      await expect(store.closeTrade(closeParams)).rejects.toThrow("unexpected payload");
    }
  });

  it("casts every numeric column to text on every read and scopes by owner", async () => {
    tableResults = {
      paper_trades: {
        data: {
          id: "t",
          user_id: "u",
          asset_id: "a",
          side: "BUY",
          status: "OPEN",
          quantity: "0.12345678",
          cash_debited: "7571.16609018",
          sim_version: "PAPER_SIM_V1",
        },
        error: null,
      },
      assets: {
        data: {
          id: "a",
          market: "CRYPTO",
          symbol: "BTC",
          name: "Bitcoin",
          asset_type: "CRYPTO",
          currency: "USDT",
        },
        error: null,
      },
    };
    const cand = await store.getTradeForClose("u", "t");
    expect(cand).toMatchObject({
      quantity: "0.12345678",
      cashDebited: "7571.16609018",
      status: "OPEN",
    });
    const trades = calls.find((c) => c.table === "paper_trades")!;
    expect(trades.select).toContain("quantity::text");
    expect(trades.select).toContain("cash_debited::text");
    expect(trades.filters).toEqual([
      ["id", "t"],
      ["user_id", "u"],
    ]);

    calls.length = 0;
    tableResults = {}; // list reads default to empty pages
    await store.getPortfolioSnapshot("u");
    const selects = calls
      .filter((c) => c.select && c.table !== "assets")
      .map((c) => `${c.table}: ${c.select}`);
    expect(selects.join("\n")).toMatch(/paper_accounts: .*starting_cash::text.*cash_balance::text/);
    expect(selects.join("\n")).toMatch(/paper_trades: .*quantity::text.*cash_debited::text/);
    expect(selects.join("\n")).toMatch(/paper_trade_results: .*pnl::text/);
    for (const c of calls.filter((x) => x.table && x.table !== "assets"))
      expect(c.filters).toContainEqual(["user_id", "u"]);
  });

  it("refuses a trade whose side or status is outside the known sets", async () => {
    tableResults = {
      paper_trades: {
        data: {
          id: "t",
          user_id: "u",
          asset_id: "a",
          side: "HODL",
          status: "OPEN",
          quantity: "1",
          cash_debited: "1",
          sim_version: "v",
        },
        error: null,
      },
    };
    await expect(store.getTradeForClose("u", "t")).rejects.toThrow("unexpected side or status");
  });
});
