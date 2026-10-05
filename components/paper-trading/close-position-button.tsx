"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { closePaperTradeAction } from "@/features/paper-trading/actions";
import { PAPER_BANNER_TEXT } from "@/features/paper-trading/copy";
import { fmtPrice, numberToDecimalText } from "@/features/paper-trading/format";
import type { ClosedPaperTrade } from "@/features/paper-trading/state";
import { Money } from "./money";

interface Props {
  tradeId: string;
  symbol: string;
  currency: string;
  /** Pre-formatted by the server page; this component does no accounting. */
  quantityText: string;
  entryCostText: string;
  /** Server-calculated mark, or null when the position is unvalued. */
  markValueText: string | null;
  unrealizedText: string | null;
}

type Phase =
  | { kind: "idle" }
  | { kind: "confirming" }
  | { kind: "closing" }
  | { kind: "closed"; trade: ClosedPaperTrade }
  | { kind: "error"; message: string };

/**
 * Close one open position, behind an explicit confirmation. The browser sends ONLY the trade id; the
 * exit price, fee, slippage and realized P&L are computed by the server from a fresh quote and are
 * shown here exactly as returned. Nothing on this surface is a real order.
 */
export function ClosePositionButton(p: Props) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [pending, start] = useTransition();
  const panel = useRef<HTMLDivElement>(null);
  const titleId = `close-${p.tradeId}`;
  const triggerId = `close-btn-${p.tradeId}`;

  useEffect(() => {
    if (phase.kind === "confirming") panel.current?.focus();
  }, [phase.kind]);

  const cancel = () => {
    setPhase({ kind: "idle" });
    setTimeout(() => document.getElementById(triggerId)?.focus(), 0);
  };

  const confirm = () => {
    if (pending) return; // a second click while the first is in flight does nothing
    setPhase({ kind: "closing" });
    start(async () => {
      const res = await closePaperTradeAction({ tradeId: p.tradeId });
      setPhase(res.ok ? { kind: "closed", trade: res.trade } : { kind: "error", message: res.error });
    });
  };

  if (phase.kind === "closed") {
    const t = phase.trade;
    const dec = (n: number) => numberToDecimalText(n);
    return (
      <div role="status" className="space-y-2 rounded-panel border border-line bg-raised p-3 text-sm">
        <p className="font-medium">{p.symbol} closed (simulated)</p>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
          <dt className="text-muted">Exit price</dt>
          <dd className="tabular-nums">{fmtPrice(dec(t.exitPrice), t.currency) ?? "Unavailable"}</dd>
          <dt className="text-muted">Exit fee</dt>
          <dd><Money value={dec(t.exitFee)} currency={t.currency} /></dd>
          <dt className="text-muted">Realized P&amp;L</dt>
          <dd><Money value={dec(t.realizedPnl)} currency={t.currency} signed colored /></dd>
          <dt className="text-muted">Paper cash after</dt>
          <dd><Money value={dec(t.cashBalanceAfter)} currency={t.currency} /></dd>
        </dl>
        <p className="text-xs text-muted">{PAPER_BANNER_TEXT}. Calculated by the server from a fresh quote with simulated slippage and fees.</p>
        <Button size="sm" variant="outline" onClick={() => router.refresh()}>
          Update portfolio
        </Button>
      </div>
    );
  }

  if (phase.kind === "idle" || phase.kind === "error") {
    return (
      <div className="space-y-1">
        <Button id={triggerId} size="sm" variant="outline" onClick={() => setPhase({ kind: "confirming" })} aria-label={`Close ${p.symbol} paper position`}>
          Close
        </Button>
        {phase.kind === "error" ? (
          <p role="alert" className="max-w-xs text-xs text-loss">{phase.message}</p>
        ) : null}
      </div>
    );
  }

  return (
    <ConfirmClosePanel
      {...p}
      pending={pending}
      panelRef={panel}
      titleId={titleId}
      onConfirm={confirm}
      onCancel={cancel}
    />
  );
}

/** The confirmation step, kept presentational so it renders (and is tested) without a browser. */
export function ConfirmClosePanel(
  p: Props & {
    pending: boolean;
    titleId: string;
    panelRef?: React.Ref<HTMLDivElement>;
    onConfirm: () => void;
    onCancel: () => void;
  },
) {
  return (
    <div
      ref={p.panelRef}
      tabIndex={-1}
      role="group"
      aria-labelledby={p.titleId}
      onKeyDown={(e) => { if (e.key === "Escape" && !p.pending) p.onCancel(); }}
      className="max-w-sm space-y-3 rounded-panel border border-saffron/50 bg-raised p-3 text-sm"
    >
      <p id={p.titleId} className="font-medium">Close {p.symbol} paper position?</p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
        <dt className="text-muted">Quantity</dt>
        <dd className="tabular-nums">{p.quantityText}</dd>
        <dt className="text-muted">Entry cost</dt>
        <dd><Money value={p.entryCostText} currency={p.currency} /></dd>
        <dt className="text-muted">Last valuation</dt>
        <dd><Money value={p.markValueText} currency={p.currency} unavailable="Unavailable" /></dd>
        <dt className="text-muted">Unrealized P&amp;L</dt>
        <dd><Money value={p.unrealizedText} currency={p.currency} signed colored /></dd>
      </dl>
      <p className="text-xs text-muted">
        {PAPER_BANNER_TEXT}. The exit is priced by the server from a fresh quote when you confirm, with simulated
        slippage and a simulated fee, so the final result can differ from the valuation above. If no live price is
        available the position stays open.
      </p>
      <div className="flex gap-2">
        <Button size="sm" onClick={p.onConfirm} disabled={p.pending} aria-busy={p.pending}>
          {p.pending ? "Closing…" : "Confirm close"}
        </Button>
        <Button size="sm" variant="ghost" onClick={p.onCancel} disabled={p.pending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
