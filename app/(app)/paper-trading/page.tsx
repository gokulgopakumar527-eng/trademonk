import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PanelState } from "@/components/market/unavailable";
import { PageHeader } from "@/components/layout/page-header";
import { CurrencySection } from "@/components/paper-trading/currency-section";
import { PaperBadge, PaperDisclosure } from "@/components/paper-trading/paper-banner";
import { fmtDateTime } from "@/features/paper-trading/format";
import { loadPaperTradingPage } from "@/features/paper-trading/server";
import { AppError } from "@/lib/errors";

export const metadata: Metadata = { title: "Paper Trading" };
export const dynamic = "force-dynamic";

export default async function PaperTradingPage() {
  let data;
  try {
    data = await loadPaperTradingPage(); // identity comes from the verified session inside
  } catch (error) {
    if (error instanceof AppError && error.code === "UNAUTHENTICATED") redirect("/login");
    throw error;
  }
  const { portfolio, history } = data;

  return (
    <>
      <PageHeader
        title="Paper Trading"
        description="Practise with simulated trades. Open a position from an asset page; no real order is ever placed."
      />
      <div className="mb-8 space-y-3">
        <PaperBadge />
        <PaperDisclosure notice={portfolio.ok ? portfolio.data.notice : undefined} />
      </div>

      {!portfolio.ok ? (
        <PanelState title="Portfolio unavailable" tone="warn">
          {portfolio.message} No balances or P&amp;L are shown rather than guessed ones. Reload to try again.
        </PanelState>
      ) : (
        <div className="space-y-12">
          {portfolio.data.unattributedRecords > 0 ? (
            <div role="alert" className="rounded-panel border border-loss/50 p-4 text-sm">
              {portfolio.data.unattributedRecords} stored record{portfolio.data.unattributedRecords === 1 ? "" : "s"} could not be
              attributed to a paper account, so the totals below may not be trustworthy.
            </div>
          ) : null}
          <p className="text-xs text-muted">
            Calculated {fmtDateTime(portfolio.data.calculatedAt) ?? "just now"} with live quotes fetched when this page loaded.
            INR and USDT are shown separately and are never added together; no currency conversion is modelled.
          </p>
          {portfolio.data.currencies.map((c) => (
            <CurrencySection
              key={c.currency}
              portfolio={c}
              positions={portfolio.data.positions.filter((p) => p.currency === c.currency)}
              history={history}
            />
          ))}
        </div>
      )}
    </>
  );
}
