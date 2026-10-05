import "server-only";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Market } from "@/types/domain";
import type { AssetKind } from "@/types/market";
import type { Asset } from "@/services/market-data/types";
import type { PredictionStore } from "./prediction-service";
import type { InsertedPredictionRow, NewPredictionRow } from "./types";

interface AssetRow {
  id: string;
  market: Market;
  symbol: string;
  name: string;
  asset_type: AssetKind;
  currency: string;
}

/**
 * Writes with the SERVICE ROLE. This is intentional: `authenticated` has no column grant on
 * entry_reference_price or any engine field, so a signed-in client cannot forge them. The caller
 * (createEnginePrediction) receives `userId` from the verified session, never from the client.
 * The append-only triggers still fire for the service role.
 */
export class SupabasePredictionStore implements PredictionStore {
  async getAssetById(id: string): Promise<Asset | null> {
    const { data, error } = await createSupabaseAdminClient()
      .from("assets")
      .select("id, market, symbol, name, asset_type, currency")
      .eq("id", id)
      .eq("is_active", true)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const a = data as AssetRow;
    return { id: a.id, market: a.market, symbol: a.symbol, name: a.name, kind: a.asset_type, currency: a.currency };
  }

  async insert(row: NewPredictionRow): Promise<InsertedPredictionRow> {
    const { data, error } = await createSupabaseAdminClient()
      .from("predictions")
      .insert(row)
      .select("id, created_at, expires_at, content_hash, hash_version")
      .single();
    if (error) throw error;
    return data as InsertedPredictionRow;
  }
}
