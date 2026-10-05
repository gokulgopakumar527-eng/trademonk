import Link from "next/link";
import { PanelState } from "@/components/market/unavailable";
import { RECONCILIATION_TEXT } from "@/features/paper-trading/copy";
import type {
  ClosedTradeHistory,
  CurrencyPortfolio,
  LoadResult,
  PortfolioPosition,
} from "@/features/paper-trading/state";
import { ClosedTradesTable } from "./closed-trades-table";
import { Money } from "./money";
import { PositionsTable } from "./positions-table";

function Tile({ label, children, note }: { label: string; children: React.ReactNode; note?: string }) {
  return (
    <div className="bg-panel p-4">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-1 text-lg">{children}</dd>
      {note ? <p className="mt-1 text-xs text-muted">{note}</p> : null}
    </div>
  );
}

function Reconciliation({ c }: { c: CurrencyPortfolio }) {
  const { status, difference } = c.reconciliation;
  const tone = status === "CONSISTENT" ? "text-gain" : status === "MISMATCH" ? "text-loss" : "text-saffron";
  return (
    <p className="text-sm" role={status === "CONSISTENT" ? undefined : "alert"}>
      <span className="text-muted">Reconciliation: </span>
      <span className={tone}>{RECONCILIATION_TEXT[status]}</span>
      {status === "MISMATCH" && difference !== null ? (
        <span className="text-muted"> (cash differs from the records by <Money value={difference} currency={c.currency} signed />)</span>
      ) : null}
    </p>
  );
}

/**
 * One currency's paper portfolio. INR and USDT are rendered in separate sections and are never
 * added together: no conversion is modelled. Every number is the server-calculated value.
 */
export function CurrencySection({
  portfolio: c,
  positions,
  history,
}: {
  portfolio: CurrencyPortfolio;
  positions: PortfolioPosition[];
  history: LoadResult<ClosedTradeHistory>;
}) {
  const id = `ccy-${c.currency}`;
  const incomplete = c.valuation === "INCOMPLETE";
  const valuationNote = incomplete
    ? `${c.unvaluedPositionCount} open position${c.unvaluedPositionCount === 1 ? "" : "s"} could not be valued`
    : undefined;
  const closed = history.ok ? history.data.trades.filter((t) => t.currency === c.currency) : [];

  return (
    <section aria-labelledby={id} className="space-y-6">
      <div>
        <h2 id={id} className="font-display text-xl font-medium">{c.currency} paper portfolio</h2>
        {!c.accountExists ? (
          <p className="mt-1 text-sm text-muted">
            No {c.currency} paper account yet. It is created with your first {c.currency} trade; cash shows the opening balance.
          </p>
        ) : null}
      </div>

      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-panel border border-line bg-line lg:grid-cols-5">
        <Tile label="Equity" note={valuationNote}><Money value={c.equity} currency={c.currency} /></Tile>
        <Tile label="Paper cash"><Money value={c.cashBalance} currency={c.currency} /></Tile>
        <Tile label="Open exposure (at cost)" note={`${c.openPositionCount} open position${c.openPositionCount === 1 ? "" : "s"}`}>
          <Money value={c.openPositionsEntryCost} currency={c.currency} />
        </Tile>
        <Tile label="Realized P&L" note={`${c.closedTradeCount} closed trade${c.closedTradeCount === 1 ? "" : "s"}`}>
          <Money value={c.realizedPnl} currency={c.currency} signed colored />
        </Tile>
        <Tile label="Unrealized P&L" note={valuationNote}>
          <Money value={c.unrealizedPnl} currency={c.currency} signed colored />
        </Tile>
      </dl>
      <Reconciliation c={c} />

      <div>
        <h3 className="mb-3 font-medium">Open positions</h3>
        {positions.length === 0 ? (
          <PanelState title={`No open ${c.currency} paper positions`}>
            Open one from an asset page, for example in <Link href="/markets" className="text-saffron hover:underline">Markets</Link>.
          </PanelState>
        ) : (
          <PositionsTable positions={positions} currency={c.currency} />
        )}
      </div>

      <div>
        <h3 className="mb-3 font-medium">Closed trades</h3>
        {!history.ok ? (
          <PanelState title="Trade history unavailable" tone="warn">{history.message} Nothing is shown rather than guessed values.</PanelState>
        ) : closed.length === 0 ? (
          <PanelState title={`No closed ${c.currency} trades listed`}>
            {c.closedTradeCount > 0
              ? `You have ${c.closedTradeCount} closed ${c.currency} trade${c.closedTradeCount === 1 ? "" : "s"}, but none are among the ${history.data.limit} most recent trades listed.`
              : "Closed trades appear here with their entry, exit, fees and realized P&L."}
          </PanelState>
        ) : (
          <>
            <ClosedTradesTable trades={closed} currency={c.currency} />
            {history.data.truncated ? (
              <p className="mt-2 text-xs text-muted">
                Showing your {history.data.limit} most recent closed trades across all currencies ({history.data.totalCount} in total).
              </p>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
