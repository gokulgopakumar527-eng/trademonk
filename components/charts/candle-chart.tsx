"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  type IChartApi,
  type UTCTimestamp,
} from "lightweight-charts";
import type { ChartCandle, Overlays } from "@/features/markets/technical";

export interface ChartLevel {
  price: number;
  kind: "SUPPORT" | "RESISTANCE";
}

interface Props {
  candles: ChartCandle[];
  overlays: Overlays;
  levels?: ChartLevel[];
  height?: number;
  /** For the accessible description. */
  symbol: string;
  timeframe: string;
}

type OverlayKey = "ema20" | "ema50" | "sma200" | "bb" | "vwap";

const OVERLAY_LABEL: Record<OverlayKey, string> = {
  ema20: "EMA 20",
  ema50: "EMA 50",
  sma200: "SMA 200",
  bb: "Bollinger (20, 2)",
  vwap: "VWAP (daily reset)",
};

const COLORS = {
  up: "#5db88c",
  down: "#e27a66",
  text: "#8fa3ac",
  grid: "#1b2c34",
  ema20: "#e3a23b",
  ema50: "#6cb2e6",
  sma200: "#b79cf0",
  bb: "#8fa3ac",
  vwap: "#e6ecee",
};

const t = (s: number) => s as UTCTimestamp;

/**
 * Candlestick chart (TradingView lightweight-charts, Apache-2.0). Receives only data the server
 * already fetched through the market-data service; it never calls a provider. The library's
 * attribution logo is left on, as its licence requires.
 */
export function CandleChart({ candles, overlays, levels = [], height = 420, symbol, timeframe }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const [on, setOn] = useState<Record<OverlayKey, boolean>>({
    ema20: true,
    ema50: false,
    sma200: false,
    bb: false,
    vwap: false,
  });

  const available = useMemo<OverlayKey[]>(
    () => (["ema20", "ema50", "sma200", "bb", ...(overlays.vwap ? (["vwap"] as const) : [])] as OverlayKey[]).filter((k) =>
      k === "bb" ? overlays.bbUpper.length > 0 : k === "vwap" ? (overlays.vwap?.length ?? 0) > 0 : overlays[k].length > 0,
    ),
    [overlays],
  );

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const chart = createChart(el, {
      height,
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: COLORS.text,
        fontFamily: "inherit",
      },
      grid: { vertLines: { color: COLORS.grid }, horzLines: { color: COLORS.grid } },
      rightPriceScale: { borderColor: COLORS.grid },
      timeScale: { borderColor: COLORS.grid, timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
    });
    chartRef.current = chart;

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: COLORS.up,
      downColor: COLORS.down,
      borderVisible: false,
      wickUpColor: COLORS.up,
      wickDownColor: COLORS.down,
    });
    candleSeries.setData(candles.map((c) => ({ time: t(c.time), open: c.open, high: c.high, low: c.low, close: c.close })));

    for (const lv of levels) {
      candleSeries.createPriceLine({
        price: lv.price,
        color: lv.kind === "SUPPORT" ? COLORS.up : COLORS.down,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: lv.kind === "SUPPORT" ? "S" : "R",
      });
    }

    // Volume in its own scale along the bottom. Candles with unknown volume are omitted, not zeroed.
    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "vol",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    volume.setData(
      candles
        .filter((c) => c.volume !== null)
        .map((c) => ({ time: t(c.time), value: c.volume as number, color: c.close >= c.open ? "#5db88c55" : "#e27a6655" })),
    );

    const addLine = (pts: { time: number; value: number }[], color: string, dashed = false) => {
      const s = chart.addSeries(LineSeries, {
        color,
        lineWidth: 1,
        lastValueVisible: false,
        priceLineVisible: false,
        crosshairMarkerVisible: false,
        lineStyle: dashed ? LineStyle.Dashed : LineStyle.Solid,
      });
      s.setData(pts.map((p) => ({ time: t(p.time), value: p.value })));
    };
    if (on.ema20) addLine(overlays.ema20, COLORS.ema20);
    if (on.ema50) addLine(overlays.ema50, COLORS.ema50);
    if (on.sma200) addLine(overlays.sma200, COLORS.sma200);
    if (on.bb) {
      addLine(overlays.bbUpper, COLORS.bb, true);
      addLine(overlays.bbLower, COLORS.bb, true);
    }
    if (on.vwap && overlays.vwap) addLine(overlays.vwap, COLORS.vwap);

    chart.timeScale().fitContent();
    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, [candles, overlays, levels, height, on]);

  const shown = candles.length;
  return (
    <div>
      <fieldset className="mb-3 flex flex-wrap gap-x-4 gap-y-2 text-xs">
        <legend className="sr-only">Chart overlays</legend>
        {available.map((k) => (
          <label key={k} className="inline-flex cursor-pointer items-center gap-1.5 text-muted has-[:checked]:text-fg">
            <input
              type="checkbox"
              checked={on[k]}
              onChange={(e) => setOn((prev) => ({ ...prev, [k]: e.target.checked }))}
              className="accent-[#e3a23b]"
            />
            {OVERLAY_LABEL[k]}
          </label>
        ))}
      </fieldset>
      <div
        ref={ref}
        role="img"
        aria-label={`${symbol} candlestick chart, ${timeframe} candles, ${shown} candles shown`}
        style={{ height }}
        className="w-full"
      />
    </div>
  );
}
