/**
 * The simulated-fill arithmetic. PAPER TRADING — SIMULATION ONLY.
 *
 *   executionPrice = round(referencePrice * (1 + slippage))      adverse: a buy fills HIGHER
 *   notional       = round(executionPrice * quantity)
 *   fee            = round(notional * feeRate)
 *   cashRequired   = notional + fee
 *
 * Closing a long is a simulated SELL, so slippage is adverse in the other direction:
 *
 *   exitPrice      = round(referencePrice * (1 - slippage))      adverse: a sell fills LOWER
 *   grossProceeds  = round(exitPrice * quantity)
 *   exitFee        = round(grossProceeds * feeRate)
 *   cashCredited   = grossProceeds - exitFee
 *   realizedPnl    = cashCredited - cashDebited                  (cashDebited = entry notional + entry fee)
 *
 * Rates come from the caller (the centralised simulation config); nothing is hard-coded here.
 * Slippage and fees are illustrative assumptions, not real brokerage or exchange charges, and a
 * simulated fill says nothing about what a real order would have achieved.
 */
import {
  MILLI_BPS_DENOMINATOR,
  SCALE,
  formatMilliBps,
  mulDivRoundHalfUp,
  toMilliBps,
  type Scaled,
} from "./money";

export interface ExecutionRates {
  feeBps: number;
  slippageBps: number;
}

export interface SimulatedExecution {
  referencePrice: Scaled;
  executionPrice: Scaled;
  quantity: Scaled;
  notional: Scaled;
  fee: Scaled;
  cashRequired: Scaled;
  /** The rates actually applied after rounding to milli-bps (what the database re-derives from). */
  appliedSlippageBps: string;
  appliedFeeBps: string;
}

/** BUY and LONG are both fully cash-funded long exposure, so they share one execution model. */
export function simulateLongEntry(input: {
  referencePrice: Scaled;
  quantity: Scaled;
  rates: ExecutionRates;
}): SimulatedExecution {
  const slip = toMilliBps(input.rates.slippageBps);
  const fee = toMilliBps(input.rates.feeBps);

  const executionPrice = mulDivRoundHalfUp(input.referencePrice, MILLI_BPS_DENOMINATOR + slip, MILLI_BPS_DENOMINATOR);
  const notional = mulDivRoundHalfUp(executionPrice, input.quantity, SCALE);
  const feeAmount = mulDivRoundHalfUp(notional, fee, MILLI_BPS_DENOMINATOR);

  return {
    referencePrice: input.referencePrice,
    executionPrice,
    quantity: input.quantity,
    notional,
    fee: feeAmount,
    cashRequired: notional + feeAmount,
    appliedSlippageBps: formatMilliBps(slip),
    appliedFeeBps: formatMilliBps(fee),
  };
}

export interface SimulatedExit {
  referencePrice: Scaled;
  executionPrice: Scaled;
  quantity: Scaled;
  grossProceeds: Scaled;
  fee: Scaled;
  /** grossProceeds - fee: exactly what enters the simulated account. */
  cashCredited: Scaled;
  appliedSlippageBps: string;
  appliedFeeBps: string;
}

/**
 * Exit of a BUY/LONG position (a simulated sell). Slippage is adverse for a sell, so the fill is
 * never above the reference price. Same rounding (half-up on an 8-dp grid) and same centralised
 * per-side rates as the entry; the database re-derives every figure from the locked trade row.
 */
export function simulateLongExit(input: {
  referencePrice: Scaled;
  quantity: Scaled;
  rates: ExecutionRates;
}): SimulatedExit {
  const slip = toMilliBps(input.rates.slippageBps);
  const fee = toMilliBps(input.rates.feeBps);
  if (slip >= MILLI_BPS_DENOMINATOR) throw new RangeError("slippage must be below 100%");

  const executionPrice = mulDivRoundHalfUp(input.referencePrice, MILLI_BPS_DENOMINATOR - slip, MILLI_BPS_DENOMINATOR);
  const grossProceeds = mulDivRoundHalfUp(executionPrice, input.quantity, SCALE);
  const feeAmount = mulDivRoundHalfUp(grossProceeds, fee, MILLI_BPS_DENOMINATOR);

  return {
    referencePrice: input.referencePrice,
    executionPrice,
    quantity: input.quantity,
    grossProceeds,
    fee: feeAmount,
    cashCredited: grossProceeds - feeAmount,
    appliedSlippageBps: formatMilliBps(slip),
    appliedFeeBps: formatMilliBps(fee),
  };
}

/** Realized P&L of a closed long: what came back minus what left. May be negative. Pure integer maths. */
export function realizedLongPnl(input: { cashCredited: Scaled; cashDebited: Scaled }): Scaled {
  return input.cashCredited - input.cashDebited;
}
