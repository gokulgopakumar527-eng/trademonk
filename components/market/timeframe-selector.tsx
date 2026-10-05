import Link from "next/link";
import { TIMEFRAMES, type Timeframe } from "@/types/market";
import { cn } from "@/lib/utils";

/** Plain links (?tf=) so the timeframe is shareable and needs no client JS. */
export function TimeframeSelector({
  basePath,
  active,
  tab,
}: {
  basePath: string;
  active: Timeframe;
  tab: string;
}) {
  return (
    <nav aria-label="Timeframe" className="flex flex-wrap gap-1">
      {TIMEFRAMES.map((tf) => (
        <Link
          key={tf}
          href={`${basePath}?tab=${tab}&tf=${tf}`}
          aria-current={tf === active ? "true" : undefined}
          scroll={false}
          className={cn(
            "rounded-[4px] border px-2.5 py-1 text-xs",
            tf === active ? "border-saffron bg-raised font-medium" : "border-line text-muted hover:text-fg",
          )}
        >
          {tf.toUpperCase()}
        </Link>
      ))}
    </nav>
  );
}
