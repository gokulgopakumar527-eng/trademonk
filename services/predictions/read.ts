import "server-only";
import { AppError } from "@/lib/errors";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireUser } from "@/services/profiles/profile-service";
import { derivePredictionLifecycle, type PredictionLifecycle } from "./lifecycle";
import { predictionIdSchema } from "./schemas";

export interface StoredPredictionSummary {
  id: string;
  assetId: string;
  direction: "BULLISH" | "BEARISH";
  timeframe: string | null;
  horizonHours: number;
  entryReferencePrice: number | null;
  targetPrice: number;
  invalidationPrice: number;
  engineVersion: string | null;
  signalAgreement: number | null;
  createdAt: string;
  expiresAt: string;
  contentHash: string;
  hashVersion: number;
  lifecycle: PredictionLifecycle;
  /** The immutable evaluation result, or null while the prediction is not evaluated. */
  result: StoredResultSummary | null;
}

export interface StoredResultSummary {
  status: "WIN" | "LOSS" | "INVALIDATED" | "EXPIRED" | "PARTIAL";
  /** Server timestamp of the evaluation. */
  evaluatedAt: string;
  /** The server-observed evaluation price. */
  evaluationPrice: number | null;
  resultHash: string;
}

// `prediction_results(...)` is an embedded select; RLS on it follows the parent prediction.
const COLUMNS =
  "id, asset_id, direction, timeframe, horizon_hours, entry_reference_price, target_price, invalidation_price, engine_version, signal_agreement, created_at, expires_at, content_hash, hash_version, prediction_results(status, closed_at, exit_price, content_hash)";

interface Row {
  id: string;
  asset_id: string;
  direction: "BULLISH" | "BEARISH";
  timeframe: string | null;
  horizon_hours: number;
  entry_reference_price: number | string | null;
  target_price: number | string;
  invalidation_price: number | string;
  engine_version: string | null;
  signal_agreement: number | null;
  created_at: string;
  expires_at: string;
  content_hash: string;
  hash_version: number;
  /**
   * Embedded result. PostgREST returns an object (or null) for a UNIQUE foreign key, while
   * supabase-js types it as an array; `toSummary` accepts both so neither can break the read.
   */
  prediction_results: EmbeddedResult | EmbeddedResult[] | null;
}

interface EmbeddedResult {
  status: StoredResultSummary["status"];
  closed_at: string;
  exit_price: number | string | null;
  content_hash: string;
}

const num = (v: number | string | null): number | null => (v === null ? null : Number(v));

function toSummary(r: Row, now: Date): StoredPredictionSummary {
  const embedded = r.prediction_results;
  const res = Array.isArray(embedded) ? (embedded[0] ?? null) : (embedded ?? null);
  return {
    id: r.id,
    assetId: r.asset_id,
    direction: r.direction,
    timeframe: r.timeframe,
    horizonHours: r.horizon_hours,
    entryReferencePrice: num(r.entry_reference_price),
    targetPrice: Number(r.target_price),
    invalidationPrice: Number(r.invalidation_price),
    engineVersion: r.engine_version,
    signalAgreement: r.signal_agreement,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    contentHash: r.content_hash,
    hashVersion: r.hash_version,
    lifecycle: derivePredictionLifecycle({ createdAt: r.created_at, expiresAt: r.expires_at }, now, {
      evaluated: res !== null,
    }),
    result: res
      ? { status: res.status, evaluatedAt: res.closed_at, evaluationPrice: num(res.exit_price), resultHash: res.content_hash }
      : null,
  };
}

/** The caller's own predictions. Runs as the user, so RLS scopes it. Capped at 50. */
export async function listMyPredictions(limit = 20): Promise<StoredPredictionSummary[]> {
  const user = await requireUser();
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("predictions")
    .select(COLUMNS)
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(1, Math.trunc(limit)), 50));
  if (error) throw new AppError("INTERNAL", "Could not load predictions", error);
  const now = new Date();
  return (data as unknown as Row[]).map((r) => toSummary(r, now));
}

/** One prediction the caller may see (their own, or a PLATFORM one). RLS decides. */
export async function getMyPrediction(id: string): Promise<StoredPredictionSummary> {
  await requireUser();
  const parsed = predictionIdSchema.safeParse(id);
  if (!parsed.success) throw new AppError("VALIDATION", "Invalid prediction");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.from("predictions").select(COLUMNS).eq("id", parsed.data).maybeSingle();
  if (error) throw new AppError("INTERNAL", "Could not load the prediction", error);
  if (!data) throw new AppError("NOT_FOUND", "Prediction not found");
  return toSummary(data as unknown as Row, new Date());
}
