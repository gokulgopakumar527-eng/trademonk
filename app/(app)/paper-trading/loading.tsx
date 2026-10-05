export default function Loading() {
  return (
    <div role="status" aria-live="polite" className="space-y-6">
      <span className="sr-only">Loading your paper portfolio</span>
      <div className="h-8 w-48 animate-pulse rounded-[4px] bg-raised" />
      <div className="h-6 w-64 animate-pulse rounded-[4px] bg-raised" />
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-panel border border-line bg-line lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-24 animate-pulse bg-panel" />
        ))}
      </div>
      <div className="h-48 animate-pulse rounded-panel bg-panel" />
    </div>
  );
}
