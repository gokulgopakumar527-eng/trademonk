import { PanelState } from "./unavailable";

/** Shown when the instrument list came from config because the assets table is empty or unreachable. */
export function CatalogNotice() {
  return (
    <div className="mb-6">
      <PanelState title="Asset list is running from configuration" tone="warn">
        The <code>assets</code> table has no rows (or could not be read), so the built-in instrument list is used.
        Prices and charts still come from the data providers. Watchlists need the table to be seeded
        (<code>pnpm seed:assets</code>).
      </PanelState>
    </div>
  );
}
