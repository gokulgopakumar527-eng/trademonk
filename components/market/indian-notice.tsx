import type { MarketRow } from "@/features/markets/server";
import { PanelState } from "./unavailable";

/** True when every quote failed because no Indian vendor adapter is configured. */
export function indianVendorMissing(rows: readonly MarketRow[]): boolean {
  return rows.length > 0 && rows.every((r) => !r.quote.ok && r.quote.error.code === "NOT_CONFIGURED");
}

export function IndianNotice() {
  return (
    <div className="mb-4">
      <PanelState title="No Indian market data source is connected">
        Indian instruments show &ldquo;Data unavailable&rdquo; until a licensed data vendor is configured. TradeMonk does
        not use unofficial NSE or BSE endpoints and does not estimate prices. Market hours are still shown.
      </PanelState>
    </div>
  );
}
