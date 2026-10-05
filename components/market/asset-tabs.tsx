import Link from "next/link";
import type { Timeframe } from "@/types/market";
import { cn } from "@/lib/utils";

export const ASSET_TABS = [
  { id: "overview", label: "Overview" },
  { id: "chart", label: "Chart" },
  { id: "analysis", label: "Analysis" },
  { id: "predictions", label: "Predictions" },
  { id: "news", label: "News" },
] as const;
export type AssetTab = (typeof ASSET_TABS)[number]["id"];

export function parseTab(v: string | string[] | undefined): AssetTab {
  const s = Array.isArray(v) ? v[0] : v;
  return ASSET_TABS.find((t) => t.id === s)?.id ?? "overview";
}

export function AssetTabs({ basePath, active, timeframe }: { basePath: string; active: AssetTab; timeframe: Timeframe }) {
  return (
    <nav aria-label="Asset sections" className="flex gap-1 overflow-x-auto border-b border-line">
      {ASSET_TABS.map((t) => (
        <Link
          key={t.id}
          href={`${basePath}?tab=${t.id}&tf=${timeframe}`}
          aria-current={t.id === active ? "page" : undefined}
          className={cn(
            "-mb-px whitespace-nowrap border-b-2 px-4 py-2.5 text-sm",
            t.id === active ? "border-saffron font-medium" : "border-transparent text-muted hover:text-fg",
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
