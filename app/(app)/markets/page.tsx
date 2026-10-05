import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { AssetTable } from "@/components/market/asset-table";
import { CatalogNotice } from "@/components/market/catalog-notice";
import { IndianNotice, indianVendorMissing } from "@/components/market/indian-notice";
import { MarketStatusPill } from "@/components/market/market-status-pill";
import { PanelState } from "@/components/market/unavailable";
import { loadMarketStatuses, loadRows } from "@/features/markets/server";
import { loadCatalog } from "@/services/market-data/asset-repository";

export const metadata: Metadata = { title: "Markets" };

/** The header search is hidden below the sm breakpoint; this is its mobile counterpart. */
function MobileSearch() {
  return (
    <form role="search" action="/markets" className="mb-8 sm:hidden">
      <label htmlFor="m-search" className="sr-only">Search assets</label>
      <input
        id="m-search"
        name="q"
        maxLength={40}
        autoComplete="off"
        placeholder="Search assets, e.g. BTC or NIFTY"
        className="h-10 w-full rounded-[4px] border border-line bg-ink px-3 text-sm placeholder:text-muted/70"
      />
    </form>
  );
}

export default async function MarketsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const sp = await searchParams;
  const raw = Array.isArray(sp.q) ? sp.q[0] : sp.q;
  const q = (raw ?? "").trim().slice(0, 40);
  const catalog = await loadCatalog();

  if (q) {
    const needle = q.toLowerCase();
    const hits = catalog.assets
      .filter((a) => a.symbol.toLowerCase().includes(needle) || a.name.toLowerCase().includes(needle))
      .slice(0, 12);
    const rows = await loadRows(hits);
    return (
      <>
        <PageHeader title="Search" description={`Results for \u201c${q}\u201d`} />
        {rows.length === 0 ? (
          <PanelState title="No matching assets">
            Only instruments TradeMonk tracks can be searched. More symbols are added over time.
          </PanelState>
        ) : (
          <AssetTable rows={rows} caption={`Assets matching ${q}`} />
        )}
      </>
    );
  }

  const cryptoAssets = catalog.assets.filter((a) => a.market === "CRYPTO");
  const indianAssets = catalog.assets.filter((a) => a.market !== "CRYPTO");
  const [crypto, indian, statuses] = await Promise.all([
    loadRows(cryptoAssets),
    loadRows(indianAssets),
    loadMarketStatuses(["CRYPTO", "NSE"]),
  ]);

  return (
    <>
      <PageHeader
        title="Markets"
        description="Trend and RSI columns use daily candles. Prices carry the freshness of their source."
      />
      {!catalog.fromDatabase ? <CatalogNotice /> : null}
      <MobileSearch />

      <section aria-labelledby="crypto" className="mb-12">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="crypto" className="font-medium">Crypto</h2>
          <MarketStatusPill status={statuses.CRYPTO!} />
        </div>
        {crypto.length ? <AssetTable rows={crypto} caption="Crypto assets" /> : <PanelState title="No crypto assets" />}
        {crypto[0]?.quote.ok ? (
          <p className="mt-2 text-xs text-muted">
            Prices are quoted in USDT (a dollar-pegged stablecoin), not INR. Source: {crypto[0].quote.data.source}.
          </p>
        ) : null}
      </section>

      <section aria-labelledby="india">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="india" className="font-medium">Indian markets</h2>
          <MarketStatusPill status={statuses.NSE!} />
        </div>
        {indianVendorMissing(indian) ? <IndianNotice /> : null}
        {indian.length ? <AssetTable rows={indian} caption="Indian indices and equities" /> : <PanelState title="No Indian instruments" />}
      </section>
    </>
  );
}
