import Link from "next/link";
import { Button } from "@/components/ui/button";
import { addItemAction } from "@/features/watchlists/actions";
import { ActionForm } from "@/features/watchlists/action-form";
import type { Watchlist } from "@/services/watchlists/watchlist-service";

interface Props {
  assetId: string;
  persisted: boolean;
  watchlists: Watchlist[] | null;
}

export function AddToWatchlist({ assetId, persisted, watchlists }: Props) {
  if (!persisted) {
    return <p className="max-w-xs text-xs text-muted">Watchlists need the asset table to be seeded first.</p>;
  }
  if (watchlists === null) return <p className="text-xs text-muted">Watchlists unavailable right now.</p>;
  if (watchlists.length === 0) {
    return (
      <Button asChild variant="outline" size="sm">
        <Link href="/watchlists">Create a watchlist</Link>
      </Button>
    );
  }
  return (
    <ActionForm action={addItemAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="assetId" value={assetId} />
      <label htmlFor="wl-select" className="sr-only">
        Watchlist
      </label>
      <select
        id="wl-select"
        name="watchlistId"
        className="h-8 rounded-[4px] border border-line bg-ink px-2 text-sm"
        defaultValue={watchlists[0]!.id}
      >
        {watchlists.map((w) => {
          const has = w.items.some((i) => i.asset.id === assetId);
          return (
            <option key={w.id} value={w.id}>
              {w.name}
              {has ? " (added)" : ""}
            </option>
          );
        })}
      </select>
      <Button type="submit" variant="outline" size="sm">
        Add
      </Button>
    </ActionForm>
  );
}
