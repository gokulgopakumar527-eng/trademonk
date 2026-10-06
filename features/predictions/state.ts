import type { CreatedPrediction } from "@/services/predictions/types";

export type CreatePredictionResult =
  | { ok: true; prediction: CreatedPrediction }
  | { ok: false; error: string; reason?: string };
