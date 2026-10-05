import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/layout/page-header";
import { CatalogNotice } from "@/components/market/catalog-notice";
import { IndianNotice, indianVendorMissing } from "@/components/market/indian-notice";
import { MarketStatusPill } from "@/components/market/market-status-pill";
import { OverviewCard } from "@/components/market/overview-card";
import { loadMarketStatuses, loadRows } from "@/features/markets/server";
import { loadCatalog } from "@/services/market-data/asset-repository";

export const metadata: Metadata = { title: "Dashboard" };

const OVERVIEW_SYMBOLS = ["BTC", "ETH", "NIFTY 50", "BANK NIFTY", "SENSEX"] as const;

const later = [
  { title: "Portfolio", note: "The paper-trading portfolio arrives with the prediction and paper-trading phase." },
  { title: "AI briefing", note: "The daily briefing needs the AI layer, which is built after predictions." },
  { title: "Prediction performance", note: "Computed only from timestamped, immutable records, once predictions exist." },
  { title: "Alerts", note: "Alert rules arrive after the prediction and AI phases." },
];

export default async function DashboardPage() {
  const catalog = await loadCatalog();
  const assets = OVERVIEW_SYMBOLS.flatMap((s) => catalog.assets.filter((a) => a.symbol === s));
  const [rows, statuses] = await Promise.all([loadRows(assets), loadMarketStatuses(["CRYPTO", "NSE", "BSE"])]);
  const indianRows = rows.filter((r) => r.asset.market !== "CRYPTO");

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Every figure shows where it came from and how fresh it is. Anything without a source says so."
      />
      {!catalog.fromDatabase ? <CatalogNotice /> : null}

      <section aria-labelledby="overview" className="mb-10">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <h2 id="overview" className="font-medium">
            Market overview
          </h2>
          <div className="flex flex-wrap gap-x-6 gap-y-1">
            <span className="text-xs text-muted">Crypto: <MarketStatusPill status={statuses.CRYPTO!} /></span>
            <span className="text-xs text-muted">NSE: <MarketStatusPill status={statuses.NSE!} /></span>
          </div>
        </div>
        {indianVendorMissing(indianRows) ? <IndianNotice /> : null}
        <ul className="grid grid-cols-2 gap-px overflow-hidden rounded-panel border border-line bg-line md:grid-cols-5">
          {rows.map((row) => (
            <OverviewCard key={row.asset.id} row={row} />
          ))}
        </ul>
        <p className="mt-3 text-sm">
          <Link href="/markets" className="text-saffron hover:underline">
            Browse all markets
          </Link>
          <span className="text-muted"> · </span>
          <Link href="/watchlists" className="text-saffron hover:underline">
            Your watchlists
          </Link>
        </p>
      </section>

      <div className="grid gap-x-10 gap-y-8 md:grid-cols-2">
        {later.map((s) => (
          <section key={s.title} className="border-t border-line pt-4">
            <h2 className="font-medium">{s.title}</h2>
            <p className="mt-1 text-sm text-muted">{s.note}</p>
          </section>
        ))}
      </div>
    </>
  );
}
