import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { assetSlug, SEED_ASSETS } from "@/config/assets";
import { logger } from "@/lib/logger";
import type { Market } from "@/types/domain";
import type { AssetKind } from "@/types/market";
import type { Asset } from "./types";

interface Row {
  id: string;
  market: Market;
  symbol: string;
  name: string;
  asset_type: AssetKind;
  currency: string;
}

const toAsset = (r: Row): Asset => ({
  id: r.id,
  market: r.market,
  symbol: r.symbol,
  name: r.name,
  kind: r.asset_type,
  currency: r.currency,
});

export const SEED_ID_PREFIX = "seed:";

/** True when the asset has a database row (watchlists, predictions and alerts need one). */
export const isPersistedAsset = (a: Pick<Asset, "id">): boolean => !a.id.startsWith(SEED_ID_PREFIX);

export interface AssetCatalog {
  assets: Asset[];
  /** False when the instrument list came from config/assets.ts because the DB had no rows or was unreachable. */
  fromDatabase: boolean;
}

/**
 * Instrument catalogue. Reads the public assets table (RLS: readable by everyone; only the service
 * role can write). If the table is empty or unreachable it falls back to the seed list so pages can
 * still render. That list is instrument METADATA, not market data. Seed assets carry a `seed:` id and
 * cannot be used for anything that needs a foreign key.
 */
export async function loadCatalog(): Promise<AssetCatalog> {
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase
      .from("assets")
      .select("id, market, symbol, name, asset_type, currency")
      .eq("is_active", true)
      .order("market")
      .order("symbol");
    if (error) throw error;
    if (data && data.length > 0) return { assets: (data as Row[]).map(toAsset), fromDatabase: true };
  } catch (error) {
    logger.error("assets.list_failed", { error });
  }
  return {
    assets: SEED_ASSETS.map((s) => ({
      id: `${SEED_ID_PREFIX}${assetSlug(s.symbol)}`,
      market: s.market,
      symbol: s.symbol,
      name: s.name,
      kind: s.kind,
      currency: s.currency,
    })),
    fromDatabase: false,
  };
}

export async function listAssets(): Promise<Asset[]> {
  return (await loadCatalog()).assets;
}

export async function findAssetBySlug(slug: string): Promise<Asset | null> {
  const wanted = slug.trim().toLowerCase();
  if (!/^[a-z0-9-]{1,40}$/.test(wanted)) return null;
  return (await listAssets()).find((a) => assetSlug(a.symbol) === wanted) ?? null;
}

export async function searchAssets(query: string, limit = 10): Promise<Asset[]> {
  const q = query.trim().toLowerCase();
  if (q.length < 1 || q.length > 40) return [];
  return (await listAssets())
    .filter((a) => a.symbol.toLowerCase().includes(q) || a.name.toLowerCase().includes(q))
    .slice(0, limit);
}
