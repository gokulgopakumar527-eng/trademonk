import Link from "next/link";
import { assetSlug } from "@/config/assets";
import { formatPrice } from "@/lib/format";
import type { MarketRow } from "@/features/markets/server";
import { Change } from "./change";
import { FreshnessLine } from "./freshness-line";
import { Unavailable } from "./unavailable";

/** Dashboard card: price, change, and its own freshness line. Unavailable => words, not numbers. */
export function OverviewCard({ row }: { row: MarketRow }) {
  const { asset, quote } = row;
  return (
    <li className="bg-panel p-4">
      <Link href={`/markets/${assetSlug(asset.symbol)}`} className="text-sm text-muted hover:text-fg">
        {asset.symbol}
      </Link>
      {quote.ok ? (
        <>
          <p className="mt-2 text-lg">{formatPrice(quote.data.price, quote.data.currency)}</p>
          <p className="text-sm">
            <Change change={quote.data.change} pct={quote.data.changePct} currency={quote.data.currency} />
          </p>
          <FreshnessLine
            className="mt-2"
            freshness={quote.freshness}
            servedFrom={quote.servedFrom}
            source={quote.data.source}
            isMock={quote.data.isMock}
          />
        </>
      ) : (
        <>
          <p className="mt-2 text-lg">
            <Unavailable message={quote.message} />
          </p>
          <p className="mt-2 text-xs text-muted">No live source for this instrument</p>
        </>
      )}
    </li>
  );
}
