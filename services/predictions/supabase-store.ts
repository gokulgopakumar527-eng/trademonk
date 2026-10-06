import "server-only";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Market } from "@/types/domain";
import type { AssetKind } from "@/types/market";
import type { Asset } from "@/services/market-data/types";
import { isPredictionIdempotencyViolation, PredictionIdempotencyConflictError } from "./errors";
import type { PredictionStore } from "./prediction-service";
import type { InsertedPredictionRow, NewPredictionRow, StoredPredictionRecord } from "./types";

const REPLAY_COLUMNS =
  "id, asset_id, direction, timeframe, horizon_hours, entry_reference_price, target_price, invalidation_price, engine_version, signal_agreement, entry_quote_source, entry_quote_as_of, entry_quote_fetched_at, entry_quote_is_mock, engine_snapshot, created_at, expires_at, content_hash, hash_version, prediction_results(status)";

type Numeric = number | string;
const num = (v: Numeric | null): number | null => (v === null ? null : Number(v));

interface ReplayRow extends Omit<StoredPredictionRecord, "entry_reference_price" | "target_price" | "invalidation_price" | "evaluated"> {
  entry_reference_price: Numeric | null;
  target_price: Numeric;
  invalidation_price: Numeric;
  /** PostgREST returns an object (or null) for a UNIQUE foreign key; supabase-js types it as an array. */
  prediction_results: unknown;
}

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
    if (error) {
      // Lost the (user_id, idempotency_key) race: surface a sanitised, typed signal, never the raw error.
      if (isPredictionIdempotencyViolation(error)) throw new PredictionIdempotencyConflictError();
      throw error;
    }
    return data as InsertedPredictionRow;
  }

  /**
   * The caller's own prediction for this idempotency key, or null. Always filtered by user_id: the
   * service role bypasses RLS, so ownership is enforced here and a key never matches another user's row.
   */
  async findByIdempotencyKey(userId: string, idempotencyKey: string): Promise<StoredPredictionRecord | null> {
    const { data, error } = await createSupabaseAdminClient()
      .from("predictions")
      .select(REPLAY_COLUMNS)
      .eq("user_id", userId)
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const { prediction_results: embedded, ...r } = data as unknown as ReplayRow;
    const evaluated = Array.isArray(embedded) ? embedded.length > 0 : embedded != null;
    return {
      ...r,
      entry_reference_price: num(r.entry_reference_price),
      target_price: Number(r.target_price),
      invalidation_price: Number(r.invalidation_price),
      evaluated,
    };
  }
}
