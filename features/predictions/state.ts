import type { PredictionView } from "@/services/predictions/types";

export type CreatePredictionResult =
  | { ok: true; prediction: PredictionView }
  | { ok: false; error: string; reason?: string };
