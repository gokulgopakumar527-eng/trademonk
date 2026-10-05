import { cn } from "@/lib/utils";
import type { RowAnalytics } from "@/features/markets/technical";

const STYLE = {
  BULLISH: "text-gain",
  BEARISH: "text-loss",
  NEUTRAL: "text-fg",
} as const;

const TEXT = { BULLISH: "Bullish", BEARISH: "Bearish", NEUTRAL: "Neutral" } as const;

/** Rule-based trend label from the structure engine. Descriptive, not a recommendation. */
export function TrendBadge({ trend, note }: { trend: RowAnalytics["trend"]; note?: string | null }) {
  if (!trend) return <span className="text-muted" title={note ?? undefined}>{"\u2014"}</span>;
  return <span className={cn("font-medium", STYLE[trend])}>{TEXT[trend]}</span>;
}
