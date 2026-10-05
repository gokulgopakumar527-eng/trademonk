import { PAPER_BANNER_TEXT, PAPER_RESULTS_DISCLAIMER } from "@/features/paper-trading/copy";

/** The simulation label. Shown on every paper-trading surface. */
export function PaperBadge() {
  return (
    <p className="inline-block rounded-[4px] border border-saffron/50 px-3 py-1 text-xs font-semibold text-saffron">
      {PAPER_BANNER_TEXT}
    </p>
  );
}

export function PaperDisclosure({ notice }: { notice?: string }) {
  return (
    <div className="space-y-1 text-xs leading-relaxed text-muted">
      <p>{PAPER_RESULTS_DISCLAIMER}</p>
      {notice ? <p>{notice}</p> : null}
    </div>
  );
}
