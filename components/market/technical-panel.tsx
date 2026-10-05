import { describeMacd, describeRsi, describeVolume, type TechnicalSnapshot } from "@/features/markets/technical";
import { formatCompact, formatNumber, formatPrice } from "@/lib/format";
import type { Timeframe } from "@/types/market";
import { PanelState } from "./unavailable";

interface Props {
  snapshot: TechnicalSnapshot;
  currency: string;
  timeframe: Timeframe;
}

function Row({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="grid grid-cols-[8.5rem_1fr] gap-x-4 gap-y-0.5 py-2.5 text-sm sm:grid-cols-[10rem_9rem_1fr]">
      <dt className="text-muted">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
      {note ? <dd className="col-span-2 text-xs text-muted sm:col-span-1 sm:text-sm">{note}</dd> : null}
    </div>
  );
}

/** Latest indicator values, computed from CLOSED candles only. Labels describe the number; they are not signals to trade. */
export function TechnicalPanel({ snapshot: s, currency, timeframe }: Props) {
  if (s.closedCount < 15) {
    return (
      <PanelState title="Not enough closed candles for indicators">
        {s.closedCount} closed {timeframe.toUpperCase()} candles available. Most indicators need at least 15 to 30.
      </PanelState>
    );
  }
  const p = (v: number | null) => (v === null ? "\u2014" : formatPrice(v, currency));
  return (
    <div>
      <dl className="divide-y divide-line">
        <Row label="RSI (14)" value={formatNumber(s.rsi14, 1)} note={describeRsi(s.rsi14)} />
        <Row
          label="MACD (12, 26, 9)"
          value={formatNumber(s.macd, 4)}
          note={`Signal ${formatNumber(s.macdSignal, 4)} · Histogram ${formatNumber(s.macdHistogram, 4)} · ${describeMacd(s.macdHistogram)}`}
        />
        <Row label="EMA 20" value={p(s.ema20)} />
        <Row label="EMA 50" value={p(s.ema50)} />
        <Row label="SMA 200" value={p(s.sma200)} note={s.sma200 === null ? "Needs 200 closed candles" : undefined} />
        <Row
          label="Bollinger (20, 2)"
          value={p(s.bbMiddle)}
          note={`Upper ${p(s.bbUpper)} · Lower ${p(s.bbLower)} · %B ${formatNumber(s.percentB, 2)}`}
        />
        <Row label="ATR (14)" value={p(s.atr14)} note="Average true range, in price units" />
        <Row
          label="Stochastic RSI"
          value={formatNumber(s.stochRsiK, 1)}
          note={`%D ${formatNumber(s.stochRsiD, 1)} (scale 0 to 100)`}
        />
        <Row
          label="VWAP"
          value={p(s.vwap)}
          note={s.vwap === null ? "Not shown on 1D and 1W (resets each UTC day on intraday timeframes)" : "Resets each UTC day"}
        />
        <Row label="Volume (last closed)" value={formatCompact(s.lastVolume)} note={describeVolume(s.volumeVsAvg)} />
        <Row
          label="Historical volatility"
          value={s.histVol20 === null ? "\u2014" : `${(s.histVol20 * 100).toFixed(2)}%`}
          note="Std-dev of log returns over 20 candles, per candle, not annualised"
        />
      </dl>
      <p className="mt-3 text-xs text-muted">
        {timeframe.toUpperCase()} candles · {s.closedCount} closed candles used · newest closed candle opened{" "}
        {s.asOf ? new Date(s.asOf).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "\u2014"}. The forming candle
        is excluded from every indicator.
      </p>
    </div>
  );
}
