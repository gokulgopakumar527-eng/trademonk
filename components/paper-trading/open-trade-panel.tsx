"use client";

import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { openPaperTradeAction, previewPaperTradeAction } from "@/features/paper-trading/actions";
import { openIntentFingerprint, resolveOpenIntent, type OpenIntent } from "@/features/paper-trading/idempotency";
import { PAPER_BANNER_TEXT, PAPER_RESULTS_DISCLAIMER, PAPER_SIDES_NOTE } from "@/features/paper-trading/copy";
import { fmtDateTime, fmtPrice, fmtQuantity, numberToDecimalText } from "@/features/paper-trading/format";
import type { OpenedPaperTrade, OpenTradeEstimate } from "@/features/paper-trading/state";
import { Money } from "./money";

interface Props {
  assetId: string;
  symbol: string;
  currency: string;
  /** Listed equities and ETFs trade in whole units; crypto is fractional. */
  wholeUnitsOnly: boolean;
}

const SIDES = ["BUY", "LONG"] as const;
type Side = (typeof SIDES)[number];

/** Light, friendly pre-check only. The server re-validates everything and is the only authority. */
function checkQuantity(raw: string, wholeOnly: boolean): string | undefined {
  const v = raw.trim();
  if (v === "") return "Enter a quantity";
  const pattern = wholeOnly ? /^\d+$/ : /^\d+(\.\d{1,8})?$/;
  if (!pattern.test(v)) return wholeOnly ? "Enter a whole number of units" : "Enter a number with at most 8 decimal places";
  if (!/[1-9]/.test(v)) return "Quantity must be greater than zero";
  return undefined;
}

/**
 * Open a simulated BUY/LONG position from an asset page. The browser sends only { assetId, side,
 * quantity, idempotencyKey }. One trade intent keeps ONE key across double clicks, re-renders and
 * retries; a changed side/quantity or a finished trade starts a new intent with a new key. The estimate and the final fill are both produced by the server from a gated quote,
 * with simulated slippage and fees; nothing here calculates a price, fee or balance.
 */
export function OpenTradePanel({ assetId, symbol, currency, wholeUnitsOnly }: Props) {
  const [side, setSide] = useState<Side>("BUY");
  const [quantity, setQuantity] = useState("");
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [estimate, setEstimate] = useState<OpenTradeEstimate | null>(null);
  const [opened, setOpened] = useState<OpenedPaperTrade | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  // The current trade intent. A ref, so a re-render never regenerates the key.
  const intent = useRef<OpenIntent | null>(null);
  const inFlight = useRef(false);

  const invalidate = () => { setEstimate(null); setError(null); setFieldError(undefined); };

  const getEstimate = () => {
    const problem = checkQuantity(quantity, wholeUnitsOnly);
    setError(null);
    setEstimate(null);
    if (problem) return setFieldError(problem);
    setFieldError(undefined);
    start(async () => {
      const res = await previewPaperTradeAction({ assetId, side, quantity: quantity.trim() });
      if (res.ok) setEstimate(res.estimate);
      else setError(res.error);
    });
  };

  const open = () => {
    if (pending || inFlight.current || !estimate) return;
    inFlight.current = true;
    setError(null);
    // Same side/quantity -> same intent -> same key (a retry); anything else -> a new key.
    const current = resolveOpenIntent(intent.current, openIntentFingerprint({ assetId, side, quantity }));
    intent.current = current;
    start(async () => {
      try {
        const res = await openPaperTradeAction({ assetId, side, quantity: quantity.trim(), idempotencyKey: current.key });
        if (res.ok) {
          setOpened(res.trade);
          setEstimate(null);
          intent.current = null; // done: the next trade is a new intent
        } else {
          if (res.reason === "IDEMPOTENCY_KEY_REUSED") intent.current = null;
          setError(res.error);
        }
      } catch {
        // Network/server failure: the outcome is unknown, so KEEP the key and let a retry replay it safely.
        setError("We could not confirm whether the paper trade was opened. Try again: it will not open twice.");
      } finally {
        inFlight.current = false;
      }
    });
  };

  const dec = numberToDecimalText;
  return (
    <section aria-labelledby="paper-open" className="rounded-panel border border-line p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="paper-open" className="font-medium">Paper trade {symbol}</h2>
        <span className="rounded-[4px] border border-saffron/50 px-2 py-0.5 text-xs font-semibold text-saffron">{PAPER_BANNER_TEXT}</span>
      </div>
      <p className="mt-1 text-xs text-muted">{PAPER_SIDES_NOTE}</p>

      {opened ? (
        <div role="status" className="mt-4 space-y-2 text-sm">
          <p className="font-medium">{opened.replayed ? "Paper position already opened (simulated). No second trade was made." : "Paper position opened (simulated)"}</p>
          <dl className="grid max-w-sm grid-cols-2 gap-x-4 gap-y-1">
            <dt className="text-muted">Quantity</dt>
            <dd className="tabular-nums">{fmtQuantity(dec(opened.quantity)) ?? "Unavailable"}</dd>
            <dt className="text-muted">Simulated fill price</dt>
            <dd className="tabular-nums">{fmtPrice(dec(opened.entryPrice), opened.currency) ?? "Unavailable"}</dd>
            <dt className="text-muted">Simulated fee</dt>
            <dd><Money value={dec(opened.fee)} currency={opened.currency} /></dd>
            <dt className="text-muted">Paper cash used</dt>
            <dd><Money value={dec(opened.cashDebited)} currency={opened.currency} /></dd>
            <dt className="text-muted">Paper cash after</dt>
            <dd><Money value={dec(opened.cashBalanceAfter)} currency={opened.currency} /></dd>
          </dl>
          <p className="text-xs text-muted">Priced by the server from a quote as of {fmtDateTime(opened.quote.asOf) ?? "an unknown time"} ({opened.quote.source}{opened.quote.isMock ? ", MOCK DATA" : ""}).</p>
          <Button asChild size="sm" variant="outline"><Link href="/paper-trading">View paper portfolio</Link></Button>
        </div>
      ) : (
        <div className="mt-4 space-y-4" aria-busy={pending}>
          <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
            <div className="space-y-1.5">
              <label htmlFor="paper-side" className="block text-sm font-medium">Side</label>
              <select
                id="paper-side"
                value={side}
                disabled={pending}
                onChange={(e) => { setSide(e.target.value as Side); invalidate(); }}
                className="h-10 w-full rounded-[4px] border border-line bg-ink px-2 text-sm"
              >
                {SIDES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <Field
              label={`Quantity (${wholeUnitsOnly ? "whole units" : "units, up to 8 decimals"})`}
              name="paper-quantity"
              inputMode="decimal"
              autoComplete="off"
              value={quantity}
              disabled={pending}
              error={fieldError}
              hint={`Priced in ${currency}`}
              onChange={(e) => { setQuantity(e.target.value); invalidate(); }}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); getEstimate(); } }}
            />
          </div>

          <Button variant="outline" onClick={getEstimate} disabled={pending}>
            {pending && !estimate ? "Getting estimate…" : "Get estimate"}
          </Button>

          {estimate ? (
            <div className="space-y-3 rounded-panel bg-raised p-3 text-sm">
              <p className="font-medium">Estimated cost (not yet traded)</p>
              <dl className="grid max-w-sm grid-cols-2 gap-x-4 gap-y-1">
                <dt className="text-muted">Quote price</dt>
                <dd className="tabular-nums">{fmtPrice(estimate.referencePrice, estimate.currency) ?? "Unavailable"}</dd>
                <dt className="text-muted">Estimated fill price</dt>
                <dd className="tabular-nums">{fmtPrice(estimate.estimatedFillPrice, estimate.currency) ?? "Unavailable"}</dd>
                <dt className="text-muted">Estimated value</dt>
                <dd><Money value={estimate.estimatedNotional} currency={estimate.currency} /></dd>
                <dt className="text-muted">Estimated fee</dt>
                <dd><Money value={estimate.estimatedFee} currency={estimate.currency} /></dd>
                <dt className="font-medium">Estimated total</dt>
                <dd className="font-medium"><Money value={estimate.estimatedTotalCost} currency={estimate.currency} /></dd>
              </dl>
              <p className="text-xs text-muted">
                Assumes {estimate.simulation.slippageBps} bps slippage and a {estimate.simulation.feeBps} bps fee ({estimate.simulation.version}).
                Quote from {estimate.quote.source}{estimate.quote.isMock ? " (MOCK DATA)" : ""} as of {fmtDateTime(estimate.quote.asOf) ?? "an unknown time"}.
                This is an estimate only: the real simulated fill is priced again when you confirm and can differ.
              </p>
              <Button onClick={open} disabled={pending}>
                {pending ? "Opening…" : `Open paper ${side} position`}
              </Button>
            </div>
          ) : null}

          {error ? <p role="alert" className="text-sm text-loss">{error}</p> : null}
        </div>
      )}
      <p className="mt-4 border-t border-line pt-3 text-xs text-muted">{PAPER_RESULTS_DISCLAIMER}</p>
    </section>
  );
}
