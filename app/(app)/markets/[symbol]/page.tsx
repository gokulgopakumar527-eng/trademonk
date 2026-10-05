import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CandleChart } from "@/components/charts/candle-chart";
import { AddToWatchlist } from "@/components/market/add-to-watchlist";
import { AssetTabs, parseTab } from "@/components/market/asset-tabs";
import { Change } from "@/components/market/change";
import { FreshnessLine } from "@/components/market/freshness-line";
import { MarketStatusPill } from "@/components/market/market-status-pill";
import { StructurePanel } from "@/components/market/structure-panel";
import { TechnicalPanel } from "@/components/market/technical-panel";
import { TimeframeSelector } from "@/components/market/timeframe-selector";
import { PanelState, Unavailable } from "@/components/market/unavailable";
import { OpenTradePanel } from "@/components/paper-trading/open-trade-panel";
import { paperTradeEligibility } from "@/features/paper-trading/eligibility";
import { loadAssetPage, parseTimeframe, type AssetPageData } from "@/features/markets/server";
import { formatCompact, formatPrice } from "@/lib/format";
import { logger } from "@/lib/logger";
import { assetSlug } from "@/config/assets";
import { findAssetBySlug, isPersistedAsset } from "@/services/market-data/asset-repository";
import { listMyWatchlists, type Watchlist } from "@/services/watchlists/watchlist-service";

export async function generateMetadata({ params }: { params: Promise<{ symbol: string }> }): Promise<Metadata> {
  const { symbol } = await params;
  const asset = await findAssetBySlug(symbol);
  return { title: asset ? asset.symbol : "Asset" };
}

type SP = Promise<{ tab?: string | string[]; tf?: string | string[] }>;

export default async function AssetPage({ params, searchParams }: { params: Promise<{ symbol: string }>; searchParams: SP }) {
  const [{ symbol }, sp] = await Promise.all([params, searchParams]);
  const asset = await findAssetBySlug(symbol);
  if (!asset) notFound();

  const tab = parseTab(sp.tab);
  const timeframe = parseTimeframe(sp.tf);
  const basePath = `/markets/${assetSlug(asset.symbol)}`;

  const persisted = isPersistedAsset(asset);
  const [data, watchlists] = await Promise.all([
    loadAssetPage(asset, timeframe),
    persisted ? listMyWatchlists().catch((e): Watchlist[] | null => (logger.warn("watchlist.load_failed", { error: e }), null)) : Promise.resolve(null),
  ]);

  return (
    <>
      <Header data={data} persisted={persisted} watchlists={watchlists} />
      <div className="mt-6">
        <AssetTabs basePath={basePath} active={tab} timeframe={timeframe} />
      </div>
      <div className="mt-6">
        {tab === "overview" ? <Overview data={data} basePath={basePath} /> : null}
        {tab === "overview" ? <PaperTradeSection asset={asset} persisted={persisted} /> : null}
        {tab === "chart" ? <ChartTab data={data} basePath={basePath} /> : null}
        {tab === "analysis" ? <Analysis data={data} /> : null}
        {tab === "predictions" ? (
          <PanelState title="Predictions for this asset">
            Prediction creation and history arrive in the next phase. Every prediction will be timestamped by the server
            from a real quote and stay immutable.
          </PanelState>
        ) : null}
        {tab === "news" ? (
          <PanelState title="No news source connected">
            TradeMonk does not display headlines until a licensed news provider is configured, and never generates them.
          </PanelState>
        ) : null}
      </div>
    </>
  );
}

function PaperTradeSection({ asset, persisted }: { asset: AssetPageData["asset"]; persisted: boolean }) {
  const eligibility = paperTradeEligibility(asset, persisted);
  return (
    <div className="mt-8">
      {eligibility.eligible ? (
        <OpenTradePanel assetId={asset.id} symbol={asset.symbol} currency={asset.currency} wholeUnitsOnly={eligibility.wholeUnitsOnly} />
      ) : (
        <PanelState title="Paper trading not available for this asset">{eligibility.reason}</PanelState>
      )}
    </div>
  );
}

function Header({ data, persisted, watchlists }: { data: AssetPageData; persisted: boolean; watchlists: Watchlist[] | null }) {
  const { asset, quote, status } = data;
  return (
    <header className="flex flex-wrap items-start justify-between gap-6">
      <div className="min-w-0">
        <p className="text-sm text-muted">
          {asset.name} · {asset.market} · {asset.kind.toLowerCase()}
        </p>
        <h1 className="font-display text-3xl font-medium">{asset.symbol}</h1>
        {quote.ok ? (
          <>
            <p className="mt-2 flex flex-wrap items-baseline gap-x-4 text-2xl">
              {formatPrice(quote.data.price, quote.data.currency)}
              <Change change={quote.data.change} pct={quote.data.changePct} currency={quote.data.currency} showAbsolute className="text-base" />
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
          <div className="mt-2">
            <p className="text-2xl"><Unavailable message={quote.message} /></p>
            <p className="mt-1 text-xs text-muted">
              {quote.error.code === "NOT_CONFIGURED"
                ? "No data source is configured for this market."
                : "The provider could not supply a quote and no saved copy exists."}
            </p>
          </div>
        )}
        <div className="mt-2">
          <MarketStatusPill status={status} />
        </div>
      </div>
      <AddToWatchlist assetId={asset.id} persisted={persisted} watchlists={watchlists} />
    </header>
  );
}

function ChartBlock({ data, height }: { data: AssetPageData; height: number }) {
  const { candles, technical, asset, timeframe } = data;
  if (!candles.ok || !technical) {
    return (
      <PanelState title="Chart unavailable" tone="warn">
        {candles.ok ? "" : candles.message}. No candles are drawn without a source.
      </PanelState>
    );
  }
  if (technical.chartCandles.length === 0) return <PanelState title="No candles returned for this timeframe" />;
  const levels = technical.structure.status === "OK" ? technical.structure.levels.map((l) => ({ price: l.price, kind: l.kind })) : [];
  return (
    <>
      <CandleChart
        candles={technical.chartCandles}
        overlays={technical.overlays}
        levels={levels}
        height={height}
        symbol={asset.symbol}
        timeframe={timeframe}
      />
      <FreshnessLine
        className="mt-2"
        freshness={candles.freshness}
        servedFrom={candles.servedFrom}
        source={candles.data.source}
        isMock={candles.data.isMock}
      />
      <p className="mt-1 text-xs text-muted">
        Includes the forming candle (marked as such in the data); indicators and levels use closed candles only.
        {levels.length ? " Dashed lines: S = support, R = resistance." : ""}
      </p>
    </>
  );
}

function Overview({ data, basePath }: { data: AssetPageData; basePath: string }) {
  const { quote, timeframe } = data;
  return (
    <div className="space-y-8">
      <section aria-label="Price chart">
        <div className="mb-3">
          <TimeframeSelector basePath={basePath} active={timeframe} tab="overview" />
        </div>
        <ChartBlock data={data} height={360} />
      </section>
      <section aria-labelledby="stats">
        <h2 id="stats" className="mb-3 font-medium">Market statistics</h2>
        {quote.ok ? (
          <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-panel border border-line bg-line sm:grid-cols-4">
            {[
              ["High (24h / session)", quote.data.high === null ? "\u2014" : formatPrice(quote.data.high, quote.data.currency)],
              ["Low (24h / session)", quote.data.low === null ? "\u2014" : formatPrice(quote.data.low, quote.data.currency)],
              ["Volume", formatCompact(quote.data.volume)],
              ["Quote currency", quote.data.currency],
            ].map(([k, v]) => (
              <div key={k} className="bg-panel p-4">
                <dt className="text-xs text-muted">{k}</dt>
                <dd className="mt-1">{v}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <PanelState title="Statistics unavailable">{quote.message}</PanelState>
        )}
      </section>
    </div>
  );
}

function ChartTab({ data, basePath }: { data: AssetPageData; basePath: string }) {
  return (
    <section aria-label="Chart">
      <div className="mb-3">
        <TimeframeSelector basePath={basePath} active={data.timeframe} tab="chart" />
      </div>
      <ChartBlock data={data} height={520} />
    </section>
  );
}

function Analysis({ data }: { data: AssetPageData }) {
  const { technical, asset, timeframe, candles } = data;
  if (!technical || !candles.ok) {
    return <PanelState title="Analysis unavailable" tone="warn">{candles.ok ? "" : candles.message}. Indicators need candle data.</PanelState>;
  }
  const basePath = `/markets/${assetSlug(asset.symbol)}`;
  return (
    <div className="space-y-10">
      <TimeframeSelector basePath={basePath} active={timeframe} tab="analysis" />
      <section aria-labelledby="structure">
        <h2 id="structure" className="mb-3 font-medium">Market structure</h2>
        <StructurePanel structure={technical.structure} currency={asset.currency} />
      </section>
      <section aria-labelledby="indicators">
        <h2 id="indicators" className="mb-1 font-medium">Technical indicators</h2>
        <TechnicalPanel snapshot={technical.snapshot} currency={asset.currency} timeframe={timeframe} />
      </section>
      <p className="border-t border-line pt-4 text-xs text-muted">
        Educational analysis computed by fixed rules from market data. It is not investment advice and not a forecast.
      </p>
    </div>
  );
}
