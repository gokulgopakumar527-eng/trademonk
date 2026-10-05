/** Shared domain enums. Mirror the Postgres enums in supabase/migrations. */
export const MARKETS = ["CRYPTO", "NSE", "BSE"] as const;
export type Market = (typeof MARKETS)[number];

export const PREDICTION_DIRECTIONS = ["BULLISH", "BEARISH"] as const;
export type PredictionDirection = (typeof PREDICTION_DIRECTIONS)[number];

export const PREDICTION_RESULTS = [
  "OPEN",
  "WIN",
  "LOSS",
  "INVALIDATED",
  "EXPIRED",
  "PARTIAL",
] as const;
export type PredictionResultStatus = (typeof PREDICTION_RESULTS)[number];

export type UserRole = "user" | "admin";

export interface Profile {
  id: string;
  name: string | null;
  avatar_url: string | null;
  timezone: string;
  preferred_currency: string;
  preferred_markets: Market[];
  role: UserRole;
}
