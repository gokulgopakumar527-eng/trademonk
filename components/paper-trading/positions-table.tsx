import Link from "next/link";
import { ClosePositionButton } from "./close-position-button";
import { Money } from "./money";
import { VALUATION_REASON_TEXT } from "@/features/paper-trading/copy";
import { fmtDateTime, fmtPrice, fmtQuantity } from "@/features/paper-trading/format";
import type { PortfolioPosition } from "@/features/paper-trading/state";
import { assetSlug } from "@/config/assets";
import { cn } from "@/lib/utils";

interface RowView {
  quantityText: string;
  markValue: string | null;
  markPrice: string | null;
  unrealized: string | null;
  /** Short status label shown as a badge; never colour alone. */
  status: string;
  detail: string | null;
  isMock: boolean;
  stale: boolean;
  closable: boolean;
}

function viewOf(p: PortfolioPosition): RowView {
  const v = p.valuation;
  const base = { quantityText: fmtQuantity(p.quantity) ?? "Unavailable" };
  if (v.status === "VALUED") {
    return {
      ...base,
      markValue: v.markValue,
      markPrice: fmtPrice(v.markPrice, p.currency),
      unrealized: v.unrealizedPnl,
      status: "Valued",
      detail: `Price as of ${fmtDateTime(v.quote.asOf) ?? "an unknown time"} · ${v.quote.source}`,
      isMock: v.quote.isMock,
      stale: false,
      closable: p.entryCost !== null,
    };
  }
  return {
    ...base,
    markValue: null,
    markPrice: null,
    unrealized: null,
    status: v.reason === "QUOTE_STALE" ? "Stale price" : "Unvalued",
    detail: VALUATION_REASON_TEXT[v.reason] ?? "No valuation available",
    isMock: false,
    stale: v.reason === "QUOTE_STALE",
    closable: v.reason !== "POSITION_NOT_VALUABLE" && p.entryCost !== null,
  };
}

function StatusBadge({ r }: { r: RowView }) {
  return (
    <span className={cn("inline-block rounded-[3px] border px-1.5 py-px text-xs", r.status === "Valued" ? "border-line text-fg" : "border-saffron/60 text-saffron")}>
      {r.status}
    </span>
  );
}

function CloseCell({ p, r }: { p: PortfolioPosition; r: RowView }) {
  if (!r.closable || p.entryCost === null) return <span className="text-xs text-muted">Cannot be closed here</span>;
  return (
    <ClosePositionButton
      tradeId={p.tradeId}
      symbol={p.symbol}
      currency={p.currency}
      quantityText={r.quantityText}
      entryCostText={p.entryCost}
      markValueText={r.markValue}
      unrealizedText={r.unrealized}
    />
  );
}

const SymbolLink = ({ p }: { p: PortfolioPosition }) => (
  <Link href={`/markets/${assetSlug(p.symbol)}`} className="font-medium hover:underline">{p.symbol}</Link>
);

/** Open positions for ONE currency. Unavailable valuations say so in words; they are never shown as 0. */
export function PositionsTable({ positions, currency }: { positions: PortfolioPosition[]; currency: string }) {
  const rows = positions.map((p) => ({ p, r: viewOf(p) }));
  return (
    <>
      <ul className="space-y-3 md:hidden" aria-label={`Open ${currency} positions`}>
        {rows.map(({ p, r }) => (
          <li key={p.tradeId} className="space-y-2 rounded-panel border border-line p-3 text-sm">
            <div className="flex items-baseline justify-between gap-2">
              <span><SymbolLink p={p} /> <span className="text-xs text-muted">{p.side} · {p.market}</span></span>
              <StatusBadge r={r} />
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
              <dt className="text-muted">Quantity</dt><dd className="tabular-nums">{r.quantityText}</dd>
              <dt className="text-muted">Entry cost</dt><dd><Money value={p.entryCost} currency={currency} /></dd>
              <dt className="text-muted">Current value</dt><dd><Money value={r.markValue} currency={currency} /></dd>
              <dt className="text-muted">Unrealized P&amp;L</dt><dd><Money value={r.unrealized} currency={currency} signed colored /></dd>
            </dl>
            <p className="text-xs text-muted">{r.detail}{r.isMock ? " · MOCK DATA" : ""}</p>
            <CloseCell p={p} r={r} />
          </li>
        ))}
      </ul>

      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[44rem] text-left text-sm">
          <caption className="sr-only">Open {currency} paper positions</caption>
          <thead className="text-xs text-muted">
            <tr>
              <th scope="col" className="py-2 pr-4 font-medium">Asset</th>
              <th scope="col" className="py-2 pr-4 text-right font-medium">Quantity</th>
              <th scope="col" className="py-2 pr-4 text-right font-medium">Entry cost (incl. fee)</th>
              <th scope="col" className="py-2 pr-4 text-right font-medium">Current value</th>
              <th scope="col" className="py-2 pr-4 text-right font-medium">Unrealized P&amp;L</th>
              <th scope="col" className="py-2 pr-4 font-medium">Status</th>
              <th scope="col" className="py-2 font-medium"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map(({ p, r }) => (
              <tr key={p.tradeId} className="align-top">
                <th scope="row" className="py-3 pr-4 font-normal">
                  <SymbolLink p={p} />
                  <span className="block text-xs text-muted">{p.side} · {p.market} · opened {fmtDateTime(p.openedAt) ?? "unknown"}</span>
                </th>
                <td className="py-3 pr-4 text-right tabular-nums">{r.quantityText}</td>
                <td className="py-3 pr-4 text-right"><Money value={p.entryCost} currency={currency} /></td>
                <td className="py-3 pr-4 text-right">
                  <Money value={r.markValue} currency={currency} />
                  {r.markPrice ? <span className="block text-xs text-muted">@ {r.markPrice}</span> : null}
                </td>
                <td className="py-3 pr-4 text-right"><Money value={r.unrealized} currency={currency} signed colored /></td>
                <td className="py-3 pr-4">
                  <StatusBadge r={r} />
                  <span className="mt-1 block max-w-[14rem] text-xs text-muted">{r.detail}{r.isMock ? " · MOCK DATA" : ""}</span>
                </td>
                <td className="py-3"><CloseCell p={p} r={r} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
