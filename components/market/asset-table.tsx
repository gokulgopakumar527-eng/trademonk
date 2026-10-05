import Link from "next/link";
import { assetSlug } from "@/config/assets";
import { formatCompact, formatNumber, formatPrice } from "@/lib/format";
import type { MarketRow } from "@/features/markets/server";
import { Change } from "./change";
import { TrendBadge } from "./trend-badge";
import { Unavailable } from "./unavailable";

interface Props {
  rows: readonly MarketRow[];
  caption: string;
  /** Optional trailing cell, e.g. a remove button. */
  action?: (row: MarketRow) => React.ReactNode;
  actionLabel?: string;
}

/**
 * One row per asset. Price/change/volume come from the quote; trend and RSI from DAILY candles.
 * A missing value is a dash or "Data unavailable", never a default number.
 */
export function AssetTable({ rows, caption, action, actionLabel = "Actions" }: Props) {
  return (
    <div className="overflow-x-auto rounded-panel border border-line">
      <table className="w-full min-w-[34rem] text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-panel text-left text-xs text-muted">
          <tr>
            <th scope="col" className="px-4 py-2.5 font-medium">Asset</th>
            <th scope="col" className="px-4 py-2.5 text-right font-medium">Price</th>
            <th scope="col" className="px-4 py-2.5 text-right font-medium">Change</th>
            <th scope="col" className="hidden px-4 py-2.5 text-right font-medium md:table-cell">Volume</th>
            <th scope="col" className="hidden px-4 py-2.5 font-medium sm:table-cell">Trend (1D)</th>
            <th scope="col" className="hidden px-4 py-2.5 text-right font-medium sm:table-cell">RSI 14 (1D)</th>
            {action ? <th scope="col" className="px-4 py-2.5 text-right font-medium">{actionLabel}</th> : null}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((row) => {
            const { asset, quote } = row;
            const q = quote.ok ? quote.data : null;
            return (
              <tr key={asset.id} className="hover:bg-raised/40">
                <th scope="row" className="px-4 py-3 text-left font-normal">
                  <Link href={`/markets/${assetSlug(asset.symbol)}`} className="font-medium hover:text-saffron">
                    {asset.symbol}
                  </Link>
                  <span className="block text-xs text-muted">{asset.name}</span>
                </th>
                <td className="px-4 py-3 text-right">
                  {q ? formatPrice(q.price, q.currency) : <Unavailable message={quote.ok ? "" : quote.message} />}
                  {quote.ok && quote.freshness.status !== "FRESH" ? (
                    <span className="block text-xs text-muted">
                      {quote.freshness.status === "STALE" ? "Stale" : "Last close"}
                    </span>
                  ) : null}
                  {q?.isMock ? <span className="block text-xs font-semibold text-saffron">MOCK DATA</span> : null}
                </td>
                <td className="px-4 py-3 text-right">
                  {q ? <Change change={q.change} pct={q.changePct} currency={q.currency} /> : "\u2014"}
                </td>
                <td className="hidden px-4 py-3 text-right md:table-cell">{q ? formatCompact(q.volume) : "\u2014"}</td>
                <td className="hidden px-4 py-3 sm:table-cell">
                  {row.analytics ? (
                    <TrendBadge trend={row.analytics.trend} note={row.analytics.note} />
                  ) : (
                    <span className="text-muted" title={row.analyticsMessage ?? undefined}>{"\u2014"}</span>
                  )}
                </td>
                <td className="hidden px-4 py-3 text-right sm:table-cell">
                  {row.analytics ? formatNumber(row.analytics.rsi14, 1) : "\u2014"}
                </td>
                {action ? <td className="px-4 py-3 text-right">{action(row)}</td> : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
