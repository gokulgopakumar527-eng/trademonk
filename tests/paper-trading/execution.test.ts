import { describe, expect, it } from "vitest";
import { PAPER_SIMULATION } from "@/config/paper-trading";
import { simulateLongEntry } from "@/services/paper-trading/execution";
import { formatScaled, priceToScaled, parseQuantity } from "@/services/paper-trading/money";

const run = (price: number, qty: number | string, rates: { feeBps: number; slippageBps: number }) => {
  const f = simulateLongEntry({ referencePrice: priceToScaled(price)!, quantity: parseQuantity(qty)!, rates });
  return {
    entry: formatScaled(f.executionPrice), notional: formatScaled(f.notional), fee: formatScaled(f.fee),
    cash: formatScaled(f.cashRequired), slip: f.appliedSlippageBps, feeBps: f.appliedFeeBps,
  };
};

describe("simulated long entry (PAPER_SIM_V1 crypto rates: 10 bp fee, 5 bp adverse slippage)", () => {
  it("BTC 2 @ 100: price rises by slippage; fee is charged on the filled notional", () => {
    expect(run(100, 2, PAPER_SIMULATION.markets.CRYPTO)).toEqual({
      entry: "100.05000000", notional: "200.10000000", fee: "0.20010000", cash: "200.30010000", slip: "5.000", feeBps: "10.000",
    });
  });
  it("NSE equity: exact half-up rounding of the fee (3.752625375 -> 3.75262538)", () => {
    expect(run(2500.5, 3, PAPER_SIMULATION.markets.NSE)).toEqual({
      entry: "2501.75025000", notional: "7505.25075000", fee: "3.75262538", cash: "7509.00337538", slip: "5.000", feeBps: "5.000",
    });
  });
  it("slippage is always adverse for a buy: the fill is never below the reference price", () => {
    for (const price of [0.00000123, 1, 99.99, 67321.55, 250_000]) {
      const f = simulateLongEntry({ referencePrice: priceToScaled(price)!, quantity: parseQuantity(1)!, rates: { feeBps: 10, slippageBps: 5 } });
      expect(f.executionPrice).toBeGreaterThanOrEqual(f.referencePrice);
    }
  });
  it("is driven entirely by the supplied rates (zero rates -> fill at the reference price, no fee)", () => {
    expect(run(100, 2, { feeBps: 0, slippageBps: 0 })).toMatchObject({ entry: "100.00000000", fee: "0.00000000", cash: "200.00000000" });
    expect(run(100, 1, { feeBps: 100, slippageBps: 200 })).toMatchObject({ entry: "102.00000000", fee: "1.02000000", cash: "103.02000000" });
  });
  it("is deterministic: identical inputs always give identical amounts", () => {
    const a = run(67321.55, "0.12345678", PAPER_SIMULATION.markets.CRYPTO);
    for (let i = 0; i < 50; i++) expect(run(67321.55, "0.12345678", PAPER_SIMULATION.markets.CRYPTO)).toEqual(a);
  });
  it("cash required is exactly notional + fee in fixed point (no float drift)", () => {
    const f = simulateLongEntry({ referencePrice: priceToScaled(0.1)!, quantity: parseQuantity(3)!, rates: { feeBps: 10, slippageBps: 5 } });
    expect(f.cashRequired).toBe(f.notional + f.fee);
  });
  it("applies fractional basis-point rates and reports the rate actually applied", () => {
    expect(run(100, 1, { feeBps: 2.5, slippageBps: 0.5 })).toMatchObject({ slip: "0.500", feeBps: "2.500", entry: "100.00500000" });
  });
});
