import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import type { ClosedTradeHistory, CurrencyPortfolio, LoadResult, PaperPortfolio, PortfolioPosition } from "@/features/paper-trading/state";

const load = vi.hoisted(() => vi.fn());
const redirect = vi.hoisted(() => vi.fn((to: string) => { throw new Error(`REDIRECT:${to}`); }));

vi.mock("next/navigation", () => ({ redirect, useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/features/paper-trading/server", () => ({ loadPaperTradingPage: load }));
// The actions module pulls in server-only wiring; the components only need the function identities.
vi.mock("@/features/paper-trading/actions", () => ({
  openPaperTradeAction: vi.fn(), closePaperTradeAction: vi.fn(), previewPaperTradeAction: vi.fn(),
}));

import PaperTradingPage from "@/app/(app)/paper-trading/page";
import { ClosedTradesTable } from "@/components/paper-trading/closed-trades-table";
import { ClosePositionButton, ConfirmClosePanel } from "@/components/paper-trading/close-position-button";
import { OpenTradePanel } from "@/components/paper-trading/open-trade-panel";
import { PositionsTable } from "@/components/paper-trading/positions-table";

const render = (el: React.ReactElement) => renderToStaticMarkup(el);
const T1 = "00000000-0000-4000-8000-000000000001";
const T2 = "00000000-0000-4000-8000-000000000002";

const ccy = (over: Partial<CurrencyPortfolio> & { currency: string }): CurrencyPortfolio => ({
  accountExists: true, startingCash: "10000.00000000", cashBalance: "9899.85000000", openPositionCount: 1,
  openPositionsEntryCost: "100.15000000", closedTradeCount: 0, realizedPnl: "0.00000000", valuation: "COMPLETE",
  unvaluedPositionCount: 0, markValue: "110.00000000", unrealizedPnl: "9.85000000", equity: "10009.85000000",
  bookValue: "10000.00000000", reconciliation: { status: "CONSISTENT", difference: "0.00000000" }, ...over,
});

const valued = (over: Partial<PortfolioPosition> = {}): PortfolioPosition => ({
  tradeId: T1, assetId: "a1", symbol: "BTC", market: "CRYPTO", currency: "USDT", side: "BUY", quantity: "1.00000000",
  entryCost: "100.15000000", openedAt: "2026-10-03T04:00:00Z",
  valuation: { status: "VALUED", markPrice: "110.00000000", markValue: "110.00000000", unrealizedPnl: "9.85000000",
    quote: { source: "binance-public", asOf: "2026-10-03T05:00:00Z", fetchedAt: "2026-10-03T05:00:01Z", isMock: false } },
  ...over,
});
const unvalued = (reason: "QUOTE_STALE" | "QUOTE_UNAVAILABLE" | "MARKET_CLOSED", over: Partial<PortfolioPosition> = {}): PortfolioPosition => ({
  ...valued({ tradeId: T2, symbol: "RELIANCE", market: "NSE", currency: "INR", quantity: "10.00000000", entryCost: "25000.00000000" }),
  valuation: { status: "UNVALUED", reason }, ...over,
});

const history = (over: Partial<ClosedTradeHistory> = {}): LoadResult<ClosedTradeHistory> => ({
  ok: true,
  data: {
    banner: "PAPER TRADING — NO REAL MONEY", notice: "n", totalCount: 1, limit: 50, truncated: false,
    trades: [{
      tradeId: T1, assetId: "a1", symbol: "BTC", market: "CRYPTO", currency: "USDT", side: "BUY", quantity: "0.50000000",
      entryPrice: "100.05000000", entryFee: "0.05002500", entryCost: "50.07502500", openedAt: "2026-10-01T10:00:00Z",
      exitPrice: "109.94500000", exitFee: "0.05497250", cashCredited: "54.91752750", realizedPnl: "4.84250250", closedAt: "2026-10-02T10:00:00Z",
    }],
    ...over,
  },
});

const portfolio = (over: Partial<PaperPortfolio> = {}): PaperPortfolio => ({
  banner: "PAPER TRADING — NO REAL MONEY", notice: "Simulation assumptions only.", simulationVersion: "PAPER_SIM_V1",
  calculatedAt: "2026-10-03T05:00:02Z", unattributedRecords: 0,
  currencies: [
    ccy({ currency: "INR", openPositionCount: 0, openPositionsEntryCost: "0.00000000", cashBalance: "1000000.00000000", startingCash: "1000000.00000000",
      markValue: "0.00000000", unrealizedPnl: "0.00000000", equity: "1000000.00000000", bookValue: "1000000.00000000" }),
    ccy({ currency: "USDT" }),
  ],
  positions: [valued()],
  ...over,
});

beforeEach(() => { vi.clearAllMocks(); });

describe("paper-trading page", () => {
  it("redirects an unauthenticated visitor and shows nothing", async () => {
    load.mockRejectedValue(new AppError("UNAUTHENTICATED", "Sign in to continue"));
    await expect(PaperTradingPage()).rejects.toThrow("REDIRECT:/login");
    expect(redirect).toHaveBeenCalledWith("/login");
  });

  it("shows the simulation label and the results disclaimer", async () => {
    load.mockResolvedValue({ portfolio: { ok: true, data: portfolio() }, history: history() });
    const html = render(await PaperTradingPage());
    expect(html).toContain("PAPER TRADING — NO REAL MONEY");
    expect(html).toMatch(/simulations/i);
    expect(html).toMatch(/do not guarantee/i);
    expect(html).toContain("no real order is ever placed");
  });

  it("renders INR and USDT as separate sections and never a combined total", async () => {
    load.mockResolvedValue({ portfolio: { ok: true, data: portfolio() }, history: history() });
    const html = render(await PaperTradingPage());
    expect(html).toContain("INR paper portfolio");
    expect(html).toContain("USDT paper portfolio");
    expect(html).toContain("never added together");
    expect(html).not.toMatch(/Total equity|Combined|All currencies total/i);
    expect(html).toContain("\u20B910,00,000.00"); // INR cash, its own grouping and symbol
    expect(html).toContain("10,009.85 USDT");
  });

  it("shows cash, exposure, realized, unrealized, equity and reconciliation", async () => {
    load.mockResolvedValue({ portfolio: { ok: true, data: portfolio() }, history: history() });
    const html = render(await PaperTradingPage());
    for (const label of ["Equity", "Paper cash", "Open exposure (at cost)", "Realized P&amp;L", "Unrealized P&amp;L", "Balances reconcile"]) {
      expect(html).toContain(label);
    }
  });

  it("an unvalued position and an incomplete currency show WORDS, never zero", async () => {
    const p = portfolio({
      currencies: [
        ccy({ currency: "INR", valuation: "INCOMPLETE", unvaluedPositionCount: 1, markValue: null, unrealizedPnl: null, equity: null,
          openPositionsEntryCost: "25000.00000000", cashBalance: "975000.00000000" }),
        ccy({ currency: "USDT", openPositionCount: 0 }),
      ],
      positions: [unvalued("QUOTE_STALE")],
    });
    load.mockResolvedValue({ portfolio: { ok: true, data: p }, history: history() });
    const html = render(await PaperTradingPage());
    expect(html).toContain("Stale price");
    expect(html).toContain("Price is stale");
    expect(html).toContain("1 open position could not be valued");
    expect(html).toContain("Unavailable");
    // The INR equity and unrealized tiles must say "Unavailable". (Realized P&L is a genuine, stored 0.00.)
    const inr = html.slice(html.indexOf("INR paper portfolio"), html.indexOf("USDT paper portfolio"));
    expect(inr).toMatch(/Equity<\/dt><dd[^>]*><span class="text-muted">Unavailable<\/span>/);
    expect(inr).toMatch(/Unrealized P&amp;L<\/dt><dd[^>]*><span class="text-muted">Unavailable<\/span>/);
    expect((inr.match(/Unavailable/g) ?? []).length).toBeGreaterThanOrEqual(4); // equity, unrealized, row value, row P&L
  });

  it("flags a reconciliation mismatch with the difference, as an alert", async () => {
    const p = portfolio({ currencies: [ccy({ currency: "INR" }), ccy({ currency: "USDT", reconciliation: { status: "MISMATCH", difference: "-0.01000000" } })] });
    load.mockResolvedValue({ portfolio: { ok: true, data: p }, history: history() });
    const html = render(await PaperTradingPage());
    expect(html).toContain("Balances do not reconcile");
    expect(html).toContain("-0.01 USDT");
    expect(html).toContain('role="alert"');
  });

  it("warns when stored records could not be attributed", async () => {
    load.mockResolvedValue({ portfolio: { ok: true, data: portfolio({ unattributedRecords: 2 }) }, history: history() });
    expect(render(await PaperTradingPage())).toContain("2 stored records could not be attributed");
  });

  it("empty states: no positions, no closed trades", async () => {
    const empty = history({ trades: [], totalCount: 0 });
    load.mockResolvedValue({
      portfolio: { ok: true, data: portfolio({ positions: [], currencies: [ccy({ currency: "INR", accountExists: false, openPositionCount: 0 }), ccy({ currency: "USDT", openPositionCount: 0 })] }) },
      history: empty,
    });
    const html = render(await PaperTradingPage());
    expect(html).toContain("No open USDT paper positions");
    expect(html).toContain("No closed USDT trades listed");
    expect(html).toContain("No INR paper account yet");
  });

  it("error state: a portfolio failure shows no balances at all", async () => {
    load.mockResolvedValue({ portfolio: { ok: false, message: "The portfolio could not be calculated right now." }, history: history() });
    const html = render(await PaperTradingPage());
    expect(html).toContain("Portfolio unavailable");
    expect(html).not.toContain("paper portfolio");
    expect(html).not.toMatch(/USDT<\/span>|\u20B9/);
  });

  it("a history failure leaves the portfolio visible and says history is unavailable", async () => {
    load.mockResolvedValue({ portfolio: { ok: true, data: portfolio() }, history: { ok: false, message: "The trade history could not be loaded right now." } });
    const html = render(await PaperTradingPage());
    expect(html).toContain("USDT paper portfolio");
    expect(html).toContain("Trade history unavailable");
  });

  it("notes truncation of the history honestly", async () => {
    load.mockResolvedValue({ portfolio: { ok: true, data: portfolio() }, history: history({ truncated: true, totalCount: 120 }) });
    expect(render(await PaperTradingPage())).toContain("120 in total");
  });
});

describe("positions and closed trades", () => {
  it("valued positions show cost, value, unrealized P&L, quote time and source; mock data is labelled", () => {
    const p = valued({ valuation: { ...(valued().valuation as { status: "VALUED" } & Record<string, unknown>), quote: { source: "mock", asOf: "2026-10-03T05:00:00Z", fetchedAt: "x", isMock: true } } as PortfolioPosition["valuation"] });
    const html = render(h(PositionsTable, { positions: [p], currency: "USDT" }));
    expect(html).toContain("100.15 USDT");
    expect(html).toContain("110.00 USDT");
    expect(html).toContain("+9.85 USDT");
    expect(html).toContain("MOCK DATA");
    expect(html).toContain("IST");
  });

  it("table has accessible structure: caption, column and row headers", () => {
    const html = render(h(PositionsTable, { positions: [valued()], currency: "USDT" }));
    expect(html).toContain("<caption");
    expect(html).toContain('scope="col"');
    expect(html).toContain('scope="row"');
  });

  it("every stale/unavailable reason is shown in words and offers a close attempt", () => {
    for (const reason of ["QUOTE_STALE", "QUOTE_UNAVAILABLE", "MARKET_CLOSED"] as const) {
      const html = render(h(PositionsTable, { positions: [unvalued(reason)], currency: "INR" }));
      expect(html).toContain("Unavailable");
      expect(html).toContain("Close RELIANCE paper position");
    }
  });

  it("a position that cannot be settled offers no close button", () => {
    const html = render(h(PositionsTable, { positions: [{ ...unvalued("QUOTE_STALE"), valuation: { status: "UNVALUED", reason: "POSITION_NOT_VALUABLE" } }], currency: "INR" }));
    expect(html).toContain("Cannot be closed here");
    expect(html).not.toContain("Close RELIANCE paper position");
  });

  it("closed trades show entry, exit, both fees and the stored realized P&L", () => {
    const t = (history() as { ok: true; data: ClosedTradeHistory }).data.trades;
    const html = render(h(ClosedTradesTable, { trades: t, currency: "USDT" }));
    for (const s of ["100.05 USDT", "109.945 USDT", "0.05 USDT", "0.05 USDT", "+4.84 USDT"]) expect(html).toContain(s);
    expect(html).toContain("Entry fee");
    expect(html).toContain("Exit fee");
  });
});

describe("close flow", () => {
  const props = { tradeId: T1, symbol: "BTC", currency: "USDT", quantityText: "1", entryCostText: "100.15000000", markValueText: "110.00000000", unrealizedText: "9.85000000" };

  it("starts as a single labelled Close button; nothing is closed without confirmation", () => {
    const html = render(h(ClosePositionButton, props));
    expect(html).toContain("Close BTC paper position");
    expect(html).not.toContain("Confirm close");
  });

  it("the confirmation step names the position, discloses the simulation and offers Cancel", () => {
    const html = render(h(ConfirmClosePanel, { ...props, pending: false, titleId: "t", onConfirm: () => {}, onCancel: () => {} }));
    expect(html).toContain("Close BTC paper position?");
    expect(html).toContain("Confirm close");
    expect(html).toContain("Cancel");
    expect(html).toContain("PAPER TRADING — NO REAL MONEY");
    expect(html).toContain("priced by the server");
    expect(html).toContain('aria-labelledby="t"');
  });

  it("while closing, both buttons are disabled so it cannot be submitted twice", () => {
    const html = render(h(ConfirmClosePanel, { ...props, pending: true, titleId: "t", onConfirm: () => {}, onCancel: () => {} }));
    expect((html.match(/disabled=""/g) ?? []).length).toBe(2);
    expect(html).toContain("Closing…");
  });

  it("an unvalued position's confirmation says valuation is unavailable instead of showing zero", () => {
    const html = render(h(ConfirmClosePanel, { ...props, markValueText: null, unrealizedText: null, pending: false, titleId: "t", onConfirm: () => {}, onCancel: () => {} }));
    expect((html.match(/Unavailable/g) ?? []).length).toBe(2);
    expect(html).not.toMatch(/0\.00 USDT/);
  });
});

describe("open-trade panel (asset page)", () => {
  const props = { assetId: "dddddddd-0000-4000-8000-000000000001", symbol: "BTC", currency: "USDT", wholeUnitsOnly: false };

  it("offers BUY and LONG only, with the simulation label and disclaimer", () => {
    const html = render(h(OpenTradePanel, props));
    expect(html).toContain('value="BUY"');
    expect(html).toContain('value="LONG"');
    expect(html).not.toMatch(/value="(SELL|SHORT)"/);
    expect(html).toContain("PAPER TRADING — NO REAL MONEY");
    expect(html).toContain("Only BUY and LONG are supported");
    expect(html).toMatch(/do not guarantee/i);
  });

  it("has a labelled quantity field and cannot open before an estimate exists", () => {
    const html = render(h(OpenTradePanel, props));
    expect(html).toMatch(/<label[^>]*for="paper-quantity"[^>]*>Quantity/);
    expect(html).toContain("Get estimate");
    expect(html).not.toMatch(/Open paper (BUY|LONG) position/);
  });

  it("states the quantity rule for whole-unit instruments", () => {
    expect(render(h(OpenTradePanel, { ...props, symbol: "RELIANCE", currency: "INR", wholeUnitsOnly: true }))).toContain("whole units");
  });
});
