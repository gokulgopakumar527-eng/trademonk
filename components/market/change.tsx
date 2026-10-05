import { formatPct, formatSigned, toneClass, toneOf } from "@/lib/format";
import { cn } from "@/lib/utils";

export function Change({
  change,
  pct,
  currency,
  showAbsolute = false,
  className,
}: {
  change: number | null;
  pct: number | null;
  currency: string;
  showAbsolute?: boolean;
  className?: string;
}) {
  const tone = toneOf(pct ?? change);
  return (
    <span className={cn("tabular-nums", toneClass[tone], className)}>
      {formatPct(pct)}
      {showAbsolute && change !== null ? <span className="ml-2 text-muted">{formatSigned(change, currency)}</span> : null}
    </span>
  );
}
