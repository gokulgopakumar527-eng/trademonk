import Link from "next/link";
import { Money } from "./money";
import { fmtDateTime, fmtPrice, fmtQuantity } from "@/features/paper-trading/format";
import type { ClosedTradeRecord } from "@/features/paper-trading/state";
import { assetSlug } from "@/config/assets";

const when = (iso: string) => fmtDateTime(iso) ?? "Unknown time";

/**
 * Closed trades for ONE currency, exactly as stored: entry, exit, the entry and exit fees and the
 * stored realized P&L. Nothing is recomputed here.
 */
export function ClosedTradesTable({ trades, currency }: { trades: ClosedTradeRecord[]; currency: string }) {
  return (
    <>
      <ul className="space-y-3 md:hidden" aria-label={`Closed ${currency} trades`}>
        {trades.map((t) => (
          <li key={t.tradeId} className="space-y-2 rounded-panel border border-line p-3 text-sm">
            <div className="flex items-baseline justify-between gap-2">
              <span>
                <Link href={`/markets/${assetSlug(t.symbol)}`} className="font-medium hover:underline">{t.symbol}</Link>{" "}
                <span className="text-xs text-muted">{t.side} · {fmtQuantity(t.quantity) ?? "?"}</span>
              </span>
              <Money value={t.realizedPnl} currency={currency} signed colored />
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
              <dt className="text-muted">Entry</dt><dd className="tabular-nums">{fmtPrice(t.entryPrice, currency) ?? "Unavailable"}</dd>
              <dt className="text-muted">Entry fee</dt><dd><Money value={t.entryFee} currency={currency} /></dd>
              <dt className="text-muted">Exit</dt><dd className="tabular-nums">{fmtPrice(t.exitPrice, currency) ?? "Unavailable"}</dd>
              <dt className="text-muted">Exit fee</dt><dd><Money value={t.exitFee} currency={currency} /></dd>
            </dl>
            <p className="text-xs text-muted">Opened {when(t.openedAt)} · closed {when(t.closedAt)}</p>
          </li>
        ))}
      </ul>

      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[52rem] text-left text-sm">
          <caption className="sr-only">Closed {currency} paper trades, most recent first</caption>
          <thead className="text-xs text-muted">
            <tr>
              <th scope="col" className="py-2 pr-4 font-medium">Asset</th>
              <th scope="col" className="py-2 pr-4 text-right font-medium">Quantity</th>
              <th scope="col" className="py-2 pr-4 text-right font-medium">Entry price</th>
              <th scope="col" className="py-2 pr-4 text-right font-medium">Entry fee</th>
              <th scope="col" className="py-2 pr-4 text-right font-medium">Exit price</th>
              <th scope="col" className="py-2 pr-4 text-right font-medium">Exit fee</th>
              <th scope="col" className="py-2 pr-4 text-right font-medium">Realized P&amp;L</th>
              <th scope="col" className="py-2 font-medium">Closed</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {trades.map((t) => (
              <tr key={t.tradeId} className="align-top">
                <th scope="row" className="py-3 pr-4 font-normal">
                  <Link href={`/markets/${assetSlug(t.symbol)}`} className="font-medium hover:underline">{t.symbol}</Link>
                  <span className="block text-xs text-muted">{t.side} · opened {when(t.openedAt)}</span>
                </th>
                <td className="py-3 pr-4 text-right tabular-nums">{fmtQuantity(t.quantity) ?? "Unavailable"}</td>
                <td className="py-3 pr-4 text-right tabular-nums">{fmtPrice(t.entryPrice, currency) ?? "Unavailable"}</td>
                <td className="py-3 pr-4 text-right"><Money value={t.entryFee} currency={currency} /></td>
                <td className="py-3 pr-4 text-right tabular-nums">{fmtPrice(t.exitPrice, currency) ?? "Unavailable"}</td>
                <td className="py-3 pr-4 text-right"><Money value={t.exitFee} currency={currency} /></td>
                <td className="py-3 pr-4 text-right"><Money value={t.realizedPnl} currency={currency} signed colored /></td>
                <td className="py-3 text-xs text-muted">{when(t.closedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
