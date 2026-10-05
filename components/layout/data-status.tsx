/**
 * Every region that will show market data carries a provenance line. Until a provider
 * is connected (Phase 2) it says so explicitly. Nothing here is a real or mock value.
 */
export function DataStatus({ children }: { children?: React.ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-xs text-muted">
      <span aria-hidden className="size-1.5 rounded-full bg-muted/60" />
      {children ?? "No data source connected"}
    </p>
  );
}

export function DataUnavailable() {
  return <span className="text-muted">Data unavailable</span>;
}
