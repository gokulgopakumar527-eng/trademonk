import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { AssetTable } from "@/components/market/asset-table";
import { CatalogNotice } from "@/components/market/catalog-notice";
import { PanelState } from "@/components/market/unavailable";
import { loadRows } from "@/features/markets/server";
import { ActionForm } from "@/features/watchlists/action-form";
import { addItemAction, createWatchlistAction, deleteWatchlistAction, removeItemAction } from "@/features/watchlists/actions";
import { isPersistedAsset, loadCatalog } from "@/services/market-data/asset-repository";
import { MAX_WATCHLISTS } from "@/services/watchlists/schemas";
import { listMyWatchlists } from "@/services/watchlists/watchlist-service";

export const metadata: Metadata = { title: "Watchlists" };

export default async function WatchlistsPage() {
  const [lists, catalog] = await Promise.all([listMyWatchlists(), loadCatalog()]);
  const addable = catalog.assets.filter(isPersistedAsset);

  // Fetch each distinct asset once, even if it appears in several lists.
  const distinct = [...new Map(lists.flatMap((l) => l.items.map((i) => [i.asset.id, i.asset] as const))).values()];
  const rowById = new Map((await loadRows(distinct)).map((r) => [r.asset.id, r]));

  return (
    <>
      <PageHeader
        title="Watchlists"
        description="Group the assets you follow. Price, change, volume, trend and RSI come from the same sources as the markets pages."
      />
      {!catalog.fromDatabase ? <CatalogNotice /> : null}

      <ActionForm action={createWatchlistAction} className="mb-10 max-w-md">
        <label htmlFor="wl-name" className="block text-sm font-medium">
          New watchlist
        </label>
        <div className="mt-1.5 flex gap-2">
          <input
            id="wl-name"
            name="name"
            required
            maxLength={60}
            placeholder="e.g. Crypto, Long term"
            className="h-9 min-w-0 flex-1 rounded-[4px] border border-line bg-ink px-3 text-sm placeholder:text-muted/70"
          />
          <Button type="submit" size="sm" className="h-9">Create</Button>
        </div>
        <p className="mt-1 text-xs text-muted">Up to {MAX_WATCHLISTS} watchlists.</p>
      </ActionForm>

      {lists.length === 0 ? (
        <PanelState title="No watchlists yet">Create one above, then add assets from here or from any asset page.</PanelState>
      ) : (
        <div className="space-y-12">
          {lists.map((list) => {
            const rows = list.items.flatMap((i) => {
              const r = rowById.get(i.asset.id);
              return r ? [{ row: r, itemId: i.itemId }] : [];
            });
            const itemIdByAsset = new Map(list.items.map((i) => [i.asset.id, i.itemId]));
            const options = addable.filter((a) => !itemIdByAsset.has(a.id));
            return (
              <section key={list.id} aria-labelledby={`wl-${list.id}`}>
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                  <h2 id={`wl-${list.id}`} className="font-medium">
                    {list.name} <span className="text-sm font-normal text-muted">({list.items.length})</span>
                  </h2>
                  <ActionForm action={deleteWatchlistAction}>
                    <input type="hidden" name="watchlistId" value={list.id} />
                    <Button type="submit" variant="ghost" size="sm" aria-label={`Delete watchlist ${list.name}`}>
                      Delete list
                    </Button>
                  </ActionForm>
                </div>

                {rows.length === 0 ? (
                  <PanelState title="This watchlist is empty" />
                ) : (
                  <AssetTable
                    rows={rows.map((r) => r.row)}
                    caption={`Assets in ${list.name}`}
                    actionLabel="Remove"
                    action={(row) => (
                      <ActionForm action={removeItemAction}>
                        <input type="hidden" name="itemId" value={itemIdByAsset.get(row.asset.id) ?? ""} />
                        <Button type="submit" variant="ghost" size="sm" aria-label={`Remove ${row.asset.symbol} from ${list.name}`}>
                          Remove
                        </Button>
                      </ActionForm>
                    )}
                  />
                )}

                {options.length > 0 ? (
                  <ActionForm action={addItemAction} className="mt-3 flex flex-wrap items-center gap-2">
                    <input type="hidden" name="watchlistId" value={list.id} />
                    <label htmlFor={`add-${list.id}`} className="sr-only">
                      Add asset to {list.name}
                    </label>
                    <select id={`add-${list.id}`} name="assetId" className="h-8 rounded-[4px] border border-line bg-ink px-2 text-sm" defaultValue="">
                      <option value="" disabled>
                        Add an asset…
                      </option>
                      {options.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.symbol} · {a.name}
                        </option>
                      ))}
                    </select>
                    <Button type="submit" variant="outline" size="sm">Add</Button>
                  </ActionForm>
                ) : null}
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}
