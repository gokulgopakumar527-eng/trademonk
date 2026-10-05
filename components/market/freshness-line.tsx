import { cn } from "@/lib/utils";
import type { Freshness } from "@/services/market-data/freshness";

const dot: Record<Freshness["status"], string> = {
  FRESH: "bg-gain",
  STALE: "bg-saffron",
  LAST_CLOSE: "bg-muted",
};

interface Props {
  freshness: Freshness;
  servedFrom?: "PROVIDER" | "STORE";
  source?: string;
  isMock?: boolean;
  className?: string;
}

/** The provenance line every market value carries: how fresh, where from, and whether it is mock. */
export function FreshnessLine({ freshness, servedFrom, source, isMock, className }: Props) {
  return (
    <p className={cn("flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted", className)}>
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", dot[freshness.status])} />
      <span>{freshness.label}</span>
      {servedFrom === "STORE" ? (
        <span className="rounded-[3px] border border-line px-1 py-px">Saved copy, provider unreachable</span>
      ) : null}
      {source ? <span>· Source: {source}</span> : null}
      {isMock ? (
        <span className="rounded-[3px] bg-saffron px-1 py-px font-semibold text-saffron-ink">MOCK DATA</span>
      ) : null}
    </p>
  );
}
