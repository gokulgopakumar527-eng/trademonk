/**
 * Paper portfolio calculations. PAPER TRADING — SIMULATION ONLY, NO REAL MONEY.
 *
 * Flow:  verified user -> (no client input) -> owner-scoped database snapshot -> ownership check ->
 *        market-data facade quotes for open positions (gated) -> fixed-point accounting -> result.
 *
 * Nothing here accepts a balance, price, fee or P&L from a client, writes anything, or reaches a
 * provider, `fetch` or the database directly.
 *
 * ACCOUNTING (per currency; INR and USDT are never summed, no conversion is modelled)
 *
 *   cashBalance            paper_accounts.cash_balance. Entry cost has ALREADY left it.
 *   openPositionsEntryCost sum(cash_debited) of OPEN trades = entry notional + entry fee. A measure of
 *                          capital deployed (exposure at cost). It is NOT added to equity on top of
 *                          cash: that would count the same money twice.
 *   realizedPnl            sum(paper_trade_results.pnl) = sum(cash credited - cash debited). Net of
 *                          both fees and both slippages.
 *   markValue              sum(round(quote price * quantity)) over open positions.
 *   unrealizedPnl          markValue - openPositionsEntryCost. The entry fee is inside the cost, so it
 *                          is charged once; no hypothetical exit fee or slippage is deducted.
 *   equity                 cashBalance + markValue.
 *   bookValue              cashBalance + openPositionsEntryCost (open positions held at cost).
 *
 * Identity (checked per currency as `reconciliation`, never forced):
 *
 *   cashBalance + openPositionsEntryCost == startingCash + realizedPnl
 *   so  equity == startingCash + realizedPnl + unrealizedPnl
 *
 * Exposure vs equity: entry cost says how much is tied up in open positions; equity says what the
 * whole account is worth marked to market. Entry cost + fees appear in cash (as a deduction), in
 * entry cost and in unrealized P&L (as the cost base), but each only once in equity.
 *
 * Quotes are gated like the open and close flows. A position that cannot be priced is UNVALUED with
 * a reason; its currency's unrealizedPnl, markValue and equity are null, never zero or a cost proxy.
 */
import { PAPER_SIMULATION_NOTICE, PAPER_TRADING_BANNER, PAPER_CURRENCIES } from "@/config/paper-trading";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import type { DataView } from "@/services/market-data/market-data-service";
import type { Asset } from "@/services/market-data/types";
import type { Quote } from "@/types/market";
import {
  SCALE,
  formatScaled,
  formatSignedScaled,
  mulDivRoundHalfUp,
  parseDecimalAmount,
  parseQuantity,
  parseSignedDecimalAmount,
  priceToScaled,
  type Scaled,
} from "./money";
import type { PaperTradingDeps, PortfolioOpenTradeRow, PortfolioSnapshot } from "./ports";
import { portfolioInputSchema } from "./schemas";
import {
  isOpenablePaperSide,
  type CurrencyPortfolio,
  type PaperPortfolio,
  type PortfolioPosition,
  type PortfolioQuoteProvenance,
  type PortfolioReconciliationStatus,
  type PortfolioValuationReason,
} from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FAILED = "Could not calculate the paper portfolio. Nothing was changed.";

type QuoteAssessment =
  | { ok: true; price: Scaled; quote: PortfolioQuoteProvenance }
  | { ok: false; reason: PortfolioValuationReason };

/** The same gates, in the same order, as the open and close flows, but returning a reason instead of throwing. */
export function assessQuoteForValuation(
  view: DataView<Quote>,
  asset: Asset,
  now: Date,
  deps: Pick<PaperTradingDeps, "limits" | "allowMockData">,
): QuoteAssessment {
  if (!view.ok) return { ok: false, reason: "QUOTE_UNAVAILABLE" };
  const q = view.data;
  if (q.isMock && !deps.allowMockData) return { ok: false, reason: "MOCK_DATA_NOT_ALLOWED" };
  if (view.servedFrom !== "PROVIDER") return { ok: false, reason: "QUOTE_NOT_LIVE" };
  if (view.freshness.status === "LAST_CLOSE") return { ok: false, reason: "MARKET_CLOSED" };
  if (view.freshness.status !== "FRESH") return { ok: false, reason: "QUOTE_STALE" };
  const age = now.getTime() - new Date(q.asOf).getTime();
  if (Number.isNaN(age) || age > deps.limits.maxQuoteAgeMs) return { ok: false, reason: "QUOTE_STALE" };
  if (age < -deps.limits.maxQuoteFutureSkewMs) return { ok: false, reason: "DATA_INCONSISTENT" };
  if (q.market !== asset.market || q.symbol !== asset.symbol || q.currency !== asset.currency) {
    return { ok: false, reason: "DATA_INCONSISTENT" };
  }
  const price = priceToScaled(q.price);
  if (price === null || q.price > deps.limits.maxPrice) return { ok: false, reason: "DATA_INCONSISTENT" };
  return { ok: true, price, quote: { source: q.source, asOf: q.asOf, fetchedAt: q.fetchedAt, isMock: q.isMock } };
}

/** Parses an amount the database must always be able to supply; corruption fails loudly, never as zero. */
function mustParse(text: unknown, signed: boolean, what: string): Scaled {
  const v = signed ? parseSignedDecimalAmount(text) : parseDecimalAmount(text);
  if (v === null) {
    logger.error("paper_portfolio.unparsable_amount", { what });
    throw new AppError("INTERNAL", FAILED);
  }
  return v;
}

function ownershipGuard(userId: string, snap: PortfolioSnapshot): void {
  const foreign =
    snap.accounts.some((r) => r.userId !== userId) ||
    snap.openTrades.some((r) => r.userId !== userId) ||
    snap.results.some((r) => r.userId !== userId);
  if (foreign) {
    // A store that returned someone else's rows is a bug or an attack: expose nothing.
    logger.error("paper_portfolio.ownership_violation", {});
    throw new AppError("INTERNAL", FAILED);
  }
}

const sum = (xs: Scaled[]): Scaled => xs.reduce((a, b) => a + b, 0n);

export async function getPaperPortfolio(
  userId: string,
  rawInput: unknown,
  deps: PaperTradingDeps,
): Promise<PaperPortfolio> {
  // 0. Identity comes from the verified session, passed by the caller. Never from the input.
  if (typeof userId !== "string" || !UUID.test(userId)) {
    throw new AppError("UNAUTHENTICATED", "Sign in to continue");
  }
  // 1. No client input is meaningful here; anything supplied is refused.
  const parsed = portfolioInputSchema.safeParse(rawInput);
  if (!parsed.success) throw new AppError("VALIDATION", "A portfolio request takes no input");

  // 2. Authoritative, owner-scoped records.
  let snap: PortfolioSnapshot;
  try {
    snap = await deps.store.getPortfolioSnapshot(userId);
  } catch (error) {
    logger.error("paper_portfolio.snapshot_failed", { error });
    throw new AppError("INTERNAL", FAILED, error);
  }
  ownershipGuard(userId, snap);

  const now = deps.now();

  // 3. Quote each distinct priceable asset once, through the facade only.
  const priceable = (t: PortfolioOpenTradeRow): boolean =>
    isOpenablePaperSide(t.side) &&
    t.simVersion !== null &&
    t.asset.kind !== "INDEX" &&
    deps.config.markets[t.asset.market] !== undefined;
  const distinct = new Map<string, Asset>();
  for (const t of snap.openTrades) if (priceable(t)) distinct.set(t.asset.id, t.asset);
  const assessments = new Map<string, QuoteAssessment>();
  await Promise.all(
    [...distinct.values()].map(async (asset) => {
      try {
        assessments.set(asset.id, assessQuoteForValuation(await deps.marketData.getQuote(asset), asset, now, deps));
      } catch (error) {
        logger.warn("paper_portfolio.quote_threw", { error });
        assessments.set(asset.id, { ok: false, reason: "QUOTE_UNAVAILABLE" });
      }
    }),
  );

  // 4. Positions, valued one by one.
  const accountById = new Map(snap.accounts.map((a) => [a.id, a]));
  const positions: PortfolioPosition[] = [];
  const costByTrade = new Map<string, Scaled | null>();
  const markByTrade = new Map<string, Scaled>();
  const badRecord = new Set<string>(); // trade ids whose stored data is unusable or mis-attributed
  const sorted = [...snap.openTrades].sort((a, b) => a.openedAt.localeCompare(b.openedAt) || a.tradeId.localeCompare(b.tradeId));
  for (const t of sorted) {
    const cost = parseDecimalAmount(t.cashDebited);
    const quantity = parseQuantity(t.quantity);
    costByTrade.set(t.tradeId, cost);
    const acct = t.accountId ? accountById.get(t.accountId) : undefined;
    if (cost === null || quantity === null || !acct || acct.currency !== t.asset.currency) badRecord.add(t.tradeId);

    const base = {
      tradeId: t.tradeId, assetId: t.asset.id, symbol: t.asset.symbol, market: t.asset.market,
      currency: t.asset.currency, side: t.side, quantity: t.quantity,
      entryCost: cost === null ? null : formatScaled(cost), openedAt: t.openedAt,
    };
    const unvalued = (reason: PortfolioValuationReason): PortfolioPosition => ({ ...base, valuation: { status: "UNVALUED", reason } });

    if (!priceable(t) || cost === null || quantity === null) {
      positions.push(unvalued("POSITION_NOT_VALUABLE"));
      continue;
    }
    const a = assessments.get(t.asset.id);
    if (!a || !a.ok) {
      positions.push(unvalued(a && !a.ok ? a.reason : "QUOTE_UNAVAILABLE"));
      continue;
    }
    const markValue = mulDivRoundHalfUp(a.price, quantity, SCALE);
    if (markValue <= 0n) {
      positions.push(unvalued("DATA_INCONSISTENT"));
      continue;
    }
    markByTrade.set(t.tradeId, markValue);
    positions.push({
      ...base,
      valuation: {
        status: "VALUED", markPrice: formatScaled(a.price), markValue: formatScaled(markValue),
        unrealizedPnl: formatSignedScaled(markValue - cost), quote: a.quote,
      },
    });
  }

  // 5. Per-currency accounting.
  let unattributed = snap.results.filter((r) => !r.accountId || !accountById.has(r.accountId)).length;
  const currencies: CurrencyPortfolio[] = PAPER_CURRENCIES.map((currency) => {
    const account = snap.accounts.find((a) => a.currency === currency);
    const configured = (deps.config.startingCash as Record<string, number | undefined>)[currency];
    const start = account
      ? mustParse(account.startingCash, false, "starting_cash")
      : mustParse(configured === undefined ? null : configured.toFixed(8), false, "configured starting cash");
    const cash = account ? mustParse(account.cashBalance, false, "cash_balance") : start;

    const open = sorted.filter((t) => t.asset.currency === currency);
    const costs = open.flatMap((t) => { const c = costByTrade.get(t.tradeId); return c == null ? [] : [c]; });
    const entryCost = sum(costs);
    const results = snap.results.filter((r) => account !== undefined && r.accountId === account.id);
    const realized = sum(results.map((r) => mustParse(r.pnl, true, "pnl")));

    const unvalued = open.filter((t) => !markByTrade.has(t.tradeId)).length;
    const complete = unvalued === 0;
    const mark = complete ? sum(open.map((t) => markByTrade.get(t.tradeId)!)) : null;

    const recordsOk = open.every((t) => !badRecord.has(t.tradeId)) && (account !== undefined || (open.length === 0 && results.length === 0));
    let status: PortfolioReconciliationStatus = "INCOMPLETE_RECORDS";
    let difference: string | null = null;
    if (recordsOk) {
      const diff = cash - (start - entryCost + realized);
      status = diff === 0n ? "CONSISTENT" : "MISMATCH";
      difference = formatSignedScaled(diff);
    }
    if (status !== "CONSISTENT") logger.warn("paper_portfolio.reconciliation", { currency, status });
    if (!complete) logger.warn("paper_portfolio.unvalued_positions", { currency, count: unvalued });

    return {
      currency, accountExists: account !== undefined, startingCash: formatScaled(start), cashBalance: formatScaled(cash),
      openPositionCount: open.length, openPositionsEntryCost: formatScaled(entryCost),
      closedTradeCount: results.length, realizedPnl: formatSignedScaled(realized),
      valuation: complete ? "COMPLETE" : "INCOMPLETE", unvaluedPositionCount: unvalued,
      markValue: mark === null ? null : formatScaled(mark),
      unrealizedPnl: mark === null ? null : formatSignedScaled(mark - entryCost),
      equity: mark === null ? null : formatScaled(cash + mark),
      bookValue: formatScaled(cash + entryCost),
      reconciliation: { status, difference },
    };
  });
  // Open trades in a currency the simulator does not track cannot belong to any row above.
  unattributed += sorted.filter((t) => !(PAPER_CURRENCIES as readonly string[]).includes(t.asset.currency)).length;

  return {
    banner: PAPER_TRADING_BANNER,
    notice: PAPER_SIMULATION_NOTICE,
    simulationVersion: deps.config.version,
    calculatedAt: now.toISOString(),
    currencies,
    positions: positions.filter((p) => (PAPER_CURRENCIES as readonly string[]).includes(p.currency)),
    unattributedRecords: unattributed,
  };
}
