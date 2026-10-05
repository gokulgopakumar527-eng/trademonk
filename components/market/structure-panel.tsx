import { formatPrice } from "@/lib/format";
import type { InsufficientData, MarketStructure } from "@/services/indicators/structure";
import { PanelState } from "./unavailable";

const STRUCTURE_TEXT: Record<MarketStructure["structure"], string> = {
  HIGHER_HIGH_HIGHER_LOW: "Higher highs and higher lows",
  LOWER_HIGH_LOWER_LOW: "Lower highs and lower lows",
  EXPANDING_RANGE: "Higher highs with lower lows (widening range)",
  CONTRACTING_RANGE: "Lower highs with higher lows (narrowing range)",
  UNDEFINED: "Not enough swing points to classify",
};
const TREND_TEXT = { BULLISH: "Bullish", BEARISH: "Bearish", NEUTRAL: "Neutral" } as const;
const BREAKOUT_TEXT = {
  BREAKOUT: "Closed above the prior 20-candle high",
  BREAKDOWN: "Closed below the prior 20-candle low",
  NONE: "No break of the prior 20-candle range",
} as const;
const VOL_TEXT = { EXPANDING: "Expanding", CONTRACTING: "Contracting", STABLE: "Stable" } as const;
const RISK_TEXT = { LOW: "Low", MEDIUM: "Medium", HIGH: "High" } as const;

interface Props {
  structure: MarketStructure | InsufficientData;
  currency: string;
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-line py-3">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 text-sm">{children}</dd>
    </div>
  );
}

export function StructurePanel({ structure: s, currency }: Props) {
  if (s.status === "INSUFFICIENT_DATA") {
    return (
      <PanelState title="Not enough data for market structure">
        Structure analysis needs {s.needed} closed candles; {s.have} are available for this timeframe.
      </PanelState>
    );
  }
  const supports = s.levels.filter((l) => l.kind === "SUPPORT");
  const resistances = s.levels.filter((l) => l.kind === "RESISTANCE");
  return (
    <div>
      <dl className="grid gap-x-8 sm:grid-cols-2">
        <Item label="Trend (rule-based)">{TREND_TEXT[s.trend]}</Item>
        <Item label="Swing structure">{STRUCTURE_TEXT[s.structure]}</Item>
        <Item label="Regime">{s.regime === "RANGE" ? "Range-bound" : "Trending"}</Item>
        <Item label="Volatility (ATR vs recent average)">{VOL_TEXT[s.volatility]}</Item>
        <Item label="Breakout / breakdown">{BREAKOUT_TEXT[s.breakout]}</Item>
        <Item label="Breakout risk (squeeze and proximity to range edge)">{RISK_TEXT[s.breakoutRisk]}</Item>
      </dl>

      <div className="mt-2 rounded-panel border border-line bg-panel p-4">
        <p className="text-xs text-muted">Agreement score</p>
        <p className="mt-1 text-2xl font-medium tabular-nums">
          {Math.round(s.confidence * s.signals.total)} of {s.signals.total}
          <span className="ml-2 text-sm font-normal text-muted">signals agree</span>
        </p>
        <p className="mt-2 text-sm text-muted">
          The share of five independent checks (swing structure, price vs EMA 20, EMA 20 vs EMA 50, MACD histogram, RSI vs
          50) that point the same way. <strong className="font-medium text-fg">It is not a probability of profit and not a
          forecast that the move will continue.</strong> Today: {s.signals.bullish} bullish, {s.signals.bearish} bearish.
        </p>
      </div>

      <div className="mt-6 grid gap-6 sm:grid-cols-2">
        <LevelList title="Resistance above" levels={resistances} currency={currency} />
        <LevelList title="Support below" levels={supports} currency={currency} />
      </div>
      <p className="mt-4 text-xs text-muted">
        Based on {s.candlesUsed} closed candles, newest opened {new Date(s.asOf).toISOString().replace("T", " ").slice(0, 16)} UTC.
        Levels are clusters of past swing highs and lows, not guarantees that price will react there.
      </p>
    </div>
  );
}

function LevelList({
  title,
  levels,
  currency,
}: {
  title: string;
  levels: MarketStructure["levels"];
  currency: string;
}) {
  return (
    <section>
      <h3 className="text-sm font-medium">{title}</h3>
      {levels.length === 0 ? (
        <p className="mt-2 text-sm text-muted">No level with 2 or more touches found.</p>
      ) : (
        <ul className="mt-2 divide-y divide-line text-sm">
          {levels.map((l) => (
            <li key={`${l.kind}-${l.price}`} className="flex items-baseline justify-between gap-4 py-2">
              <span className="tabular-nums">{formatPrice(l.price, currency)}</span>
              <span className="text-xs text-muted">
                {l.touches} touches · {(l.distancePct * 100).toFixed(2)}% from last close
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
