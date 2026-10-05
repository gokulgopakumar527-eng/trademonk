import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { AppError } from "@/lib/errors";
import type { Market } from "@/types/domain";
import type { AssetKind } from "@/types/market";
import type { Asset } from "@/services/market-data/types";
import { requireUser } from "@/services/profiles/profile-service";
import { MAX_ITEMS_PER_WATCHLIST, MAX_WATCHLISTS } from "./schemas";

export interface WatchlistItem {
  itemId: string;
  asset: Asset;
}
export interface Watchlist {
  id: string;
  name: string;
  items: WatchlistItem[];
}

interface AssetRow {
  id: string;
  market: Market;
  symbol: string;
  name: string;
  asset_type: AssetKind;
  currency: string;
}
interface ListRow {
  id: string;
  name: string;
  watchlist_items: Array<{ id: string; created_at: string; assets: AssetRow | AssetRow[] | null }>;
}

const one = <T>(v: T | T[] | null): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);

/** All of the signed-in user's watchlists. RLS scopes the query to the caller. */
export async function listMyWatchlists(): Promise<Watchlist[]> {
  await requireUser();
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("watchlists")
    .select("id, name, watchlist_items(id, created_at, assets(id, market, symbol, name, asset_type, currency))")
    .order("created_at", { ascending: true });
  if (error) throw new AppError("INTERNAL", "Could not load watchlists", error);
  return (data as unknown as ListRow[]).map((w) => ({
    id: w.id,
    name: w.name,
    items: [...w.watchlist_items]
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .flatMap((i) => {
        const a = one(i.assets);
        return a
          ? [{ itemId: i.id, asset: { id: a.id, market: a.market, symbol: a.symbol, name: a.name, kind: a.asset_type, currency: a.currency } }]
          : [];
      }),
  }));
}

export async function createWatchlist(name: string): Promise<void> {
  const user = await requireUser();
  const supabase = await createSupabaseServerClient();
  const { count, error: countErr } = await supabase.from("watchlists").select("id", { count: "exact", head: true });
  if (countErr) throw new AppError("INTERNAL", "Could not create watchlist", countErr);
  if ((count ?? 0) >= MAX_WATCHLISTS) {
    throw new AppError("VALIDATION", `You can have up to ${MAX_WATCHLISTS} watchlists`);
  }
  const { error } = await supabase.from("watchlists").insert({ user_id: user.id, name });
  if (error) {
    if (error.code === "23505") throw new AppError("VALIDATION", "You already have a watchlist with that name");
    throw new AppError("INTERNAL", "Could not create watchlist", error);
  }
}

export async function deleteWatchlist(watchlistId: string): Promise<void> {
  await requireUser();
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("watchlists").delete().eq("id", watchlistId);
  if (error) throw new AppError("INTERNAL", "Could not delete watchlist", error);
}

export async function addWatchlistItem(watchlistId: string, assetId: string): Promise<void> {
  await requireUser();
  const supabase = await createSupabaseServerClient();
  const { count, error: countErr } = await supabase
    .from("watchlist_items")
    .select("id", { count: "exact", head: true })
    .eq("watchlist_id", watchlistId);
  if (countErr) throw new AppError("INTERNAL", "Could not add asset", countErr);
  if ((count ?? 0) >= MAX_ITEMS_PER_WATCHLIST) {
    throw new AppError("VALIDATION", `A watchlist can hold up to ${MAX_ITEMS_PER_WATCHLIST} assets`);
  }
  const { error } = await supabase.from("watchlist_items").insert({ watchlist_id: watchlistId, asset_id: assetId });
  if (error) {
    if (error.code === "23505") throw new AppError("VALIDATION", "That asset is already in this watchlist");
    // RLS rejects a list the caller does not own; do not reveal whether it exists.
    if (error.code === "42501" || error.code === "23503") throw new AppError("NOT_FOUND", "Watchlist or asset not found");
    throw new AppError("INTERNAL", "Could not add asset", error);
  }
}

export async function removeWatchlistItem(itemId: string): Promise<void> {
  await requireUser();
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("watchlist_items").delete().eq("id", itemId);
  if (error) throw new AppError("INTERNAL", "Could not remove asset", error);
}
