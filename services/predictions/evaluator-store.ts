import "server-only";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Asset } from "@/services/market-data/types";
import {
  DuplicateResultError,
  type EvaluablePrediction,
  type EvaluatorStore,
  type NewResultRow,
  type StoredResult,
} from "./evaluator";
import { SupabasePredictionStore } from "./supabase-store";

interface PredictionRow {
  id: string;
  asset_id: string;
  direction: "BULLISH" | "BEARISH";
  target_price: number | string;
  invalidation_price: number | string;
  horizon_hours: number;
  timeframe: string | null;
  entry_reference_price: number | string | null;
  engine_version: string | null;
  entry_quote_is_mock: boolean | null;
  created_at: string;
  expires_at: string;
  content_hash: string;
}

interface ResultRow {
  id: string;
  prediction_id: string;
  status: StoredResult["status"];
  closed_at: string;
  exit_price: number | string;
  content_hash: string;
}

const PREDICTION_COLUMNS =
  "id, asset_id, direction, target_price, invalidation_price, horizon_hours, timeframe, entry_reference_price, engine_version, entry_quote_is_mock, created_at, expires_at, content_hash";
const RESULT_COLUMNS = "id, prediction_id, status, closed_at, exit_price, content_hash";

const toPrediction = (r: PredictionRow): EvaluablePrediction => ({
  id: r.id,
  assetId: r.asset_id,
  direction: r.direction,
  targetPrice: Number(r.target_price),
  invalidationPrice: Number(r.invalidation_price),
  horizonHours: r.horizon_hours,
  timeframe: r.timeframe,
  entryReferencePrice: r.entry_reference_price === null ? null : Number(r.entry_reference_price),
  engineVersion: r.engine_version,
  entryQuoteIsMock: r.entry_quote_is_mock,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  contentHash: r.content_hash,
});

const toResult = (r: ResultRow): StoredResult => ({
  id: r.id,
  predictionId: r.prediction_id,
  status: r.status,
  closedAt: r.closed_at,
  exitPrice: Number(r.exit_price),
  contentHash: r.content_hash,
});

/**
 * Evaluator persistence. Uses the SERVICE ROLE on purpose: API roles hold no INSERT grant on
 * prediction_results and no EXECUTE on the discovery function. This class only ever INSERTs
 * results and reads; it has no update or delete path (the tables are append-only in the database
 * as well). It is constructed only by server code that has already authenticated the trigger
 * (cron secret) or is a local script.
 */
export class SupabaseEvaluatorStore implements EvaluatorStore {
  private readonly assets = new SupabasePredictionStore();

  async listDue(limit: number): Promise<EvaluablePrediction[]> {
    const { data, error } = await createSupabaseAdminClient().rpc("predictions_due_for_evaluation", { p_limit: limit });
    if (error) throw error;
    return ((data ?? []) as PredictionRow[]).map(toPrediction);
  }

  async getPrediction(id: string): Promise<EvaluablePrediction | null> {
    const { data, error } = await createSupabaseAdminClient()
      .from("predictions")
      .select(PREDICTION_COLUMNS)
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    return data ? toPrediction(data as PredictionRow) : null;
  }

  getAssetById(id: string): Promise<Asset | null> {
    return this.assets.getAssetById(id);
  }

  async getResult(predictionId: string): Promise<StoredResult | null> {
    const { data, error } = await createSupabaseAdminClient()
      .from("prediction_results")
      .select(RESULT_COLUMNS)
      .eq("prediction_id", predictionId)
      .maybeSingle();
    if (error) throw error;
    return data ? toResult(data as ResultRow) : null;
  }

  async insertResult(row: NewResultRow): Promise<StoredResult> {
    // closed_at is NOT supplied: the database trigger sets it (and created_at and content_hash).
    const { data, error } = await createSupabaseAdminClient()
      .from("prediction_results")
      .insert(row)
      .select(RESULT_COLUMNS)
      .single();
    if (error) {
      if (error.code === "23505") throw new DuplicateResultError(row.prediction_id);
      throw error;
    }
    return toResult(data as ResultRow);
  }
}

