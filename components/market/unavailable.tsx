import { cn } from "@/lib/utils";

/** Inline "no data" text. Always words, never a placeholder number. */
export function Unavailable({ message = "Data unavailable", className }: { message?: string; className?: string }) {
  return <span className={cn("text-muted", className)}>{message}</span>;
}

/** Block-level empty/error state for panels. */
export function PanelState({
  title,
  children,
  tone = "neutral",
}: {
  title: string;
  children?: React.ReactNode;
  tone?: "neutral" | "warn";
}) {
  return (
    <div
      role="status"
      className={cn(
        "rounded-panel border border-dashed p-6 text-sm",
        tone === "warn" ? "border-saffron/50" : "border-line",
      )}
    >
      <p className="font-medium">{title}</p>
      {children ? <div className="mt-1 text-muted">{children}</div> : null}
    </div>
  );
}
