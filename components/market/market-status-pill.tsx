import type { MarketStatus } from "@/types/market";
import type { Result } from "@/types/market";
import { cn } from "@/lib/utils";
import { formatClock } from "@/services/market-data/freshness";

const LABEL: Record<MarketStatus["state"], string> = {
  OPEN: "Market open",
  PRE_OPEN: "Pre-open session",
  CLOSED: "Market closed",
  HOLIDAY: "Market holiday",
  ALWAYS_OPEN: "Trades 24/7",
  UNKNOWN: "Status unknown",
};

const DOT: Record<MarketStatus["state"], string> = {
  OPEN: "bg-gain",
  PRE_OPEN: "bg-saffron",
  CLOSED: "bg-muted",
  HOLIDAY: "bg-muted",
  ALWAYS_OPEN: "bg-gain",
  UNKNOWN: "bg-muted",
};

export function MarketStatusPill({ status, className }: { status: Result<MarketStatus>; className?: string }) {
  if (!status.ok) {
    return <span className={cn("text-xs text-muted", className)}>Market status unavailable</span>;
  }
  const s = status.data;
  const caveat =
    s.basis === "SCHEDULE_ONLY" ? "Based on trading hours only; exchange holiday calendar not loaded" : (s.note ?? null);
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-x-2 text-xs", className)} title={caveat ?? undefined}>
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className={cn("size-1.5 rounded-full", DOT[s.state])} />
        {LABEL[s.state]}
      </span>
      {s.nextChangeAt && s.state !== "ALWAYS_OPEN" ? (
        <span className="text-muted">· next change {formatClock(s.nextChangeAt)}</span>
      ) : null}
      {caveat ? <span className="text-muted">· {caveat}</span> : null}
    </span>
  );
}
