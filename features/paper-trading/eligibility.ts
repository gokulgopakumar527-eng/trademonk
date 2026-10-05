import { PAPER_CURRENCIES, PAPER_SIMULATION } from "@/config/paper-trading";

export type PaperEligibility =
  | { eligible: true; wholeUnitsOnly: boolean }
  | { eligible: false; reason: string };

interface AssetLike {
  kind: string;
  market: string;
  currency: string;
}

/**
 * Whether an asset page may offer the open-trade flow. This only decides what to SHOW; the server
 * re-checks every rule when a trade is previewed or opened, so a wrong answer here can never open
 * an ineligible trade. Mirrors the service's rules: persisted, not an index, a simulated market and
 * currency; listed equities and ETFs trade in whole units.
 */
export function paperTradeEligibility(asset: AssetLike, persisted: boolean): PaperEligibility {
  if (!persisted) return { eligible: false, reason: "Paper trading needs the asset table to be seeded first." };
  if (asset.kind === "INDEX") return { eligible: false, reason: "An index cannot be paper traded directly." };
  const marketKnown = (PAPER_SIMULATION.markets as Record<string, unknown>)[asset.market] !== undefined;
  const currencyKnown = (PAPER_CURRENCIES as readonly string[]).includes(asset.currency);
  if (!marketKnown || !currencyKnown) return { eligible: false, reason: "This instrument is not part of the paper-trading simulation." };
  return { eligible: true, wholeUnitsOnly: asset.kind !== "CRYPTO" };
}
