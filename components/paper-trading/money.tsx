import { fmtAmount, toneOfAmount, type AmountTone } from "@/features/paper-trading/format";
import { cn } from "@/lib/utils";

const TONE: Record<AmountTone, string> = { gain: "text-gain", loss: "text-loss", flat: "text-fg", none: "text-muted" };

/**
 * One money figure. A missing or unreadable value renders WORDS ("Unavailable"), never 0.
 * Colour is never the only signal: signed amounts carry an explicit + or -.
 */
export function Money({
  value,
  currency,
  signed = false,
  colored = false,
  unavailable = "Unavailable",
  className,
}: {
  value: string | null | undefined;
  currency: string;
  signed?: boolean;
  colored?: boolean;
  unavailable?: string;
  className?: string;
}) {
  const text = fmtAmount(value, currency, { signed });
  if (text === null) return <span className={cn("text-muted", className)}>{unavailable}</span>;
  return <span className={cn("tabular-nums", colored && TONE[toneOfAmount(value)], className)}>{text}</span>;
}
