/**
 * Paper-trading SIMULATION ASSUMPTIONS: the single place these numbers live.
 *
 * These are illustrative modelling choices for a no-real-money simulator. They are NOT real
 * brokerage, exchange or tax charges, and a simulated fill says nothing about what a real order
 * would have achieved. Do not copy these constants elsewhere; read them through
 * `PAPER_SIMULATION` (or the paper-trading service) so they can be changed in one place.
 *
 * Rates are in basis points (1 bp = 0.01%) to keep them integers-friendly and unambiguous.
 */
import { z } from "zod";

/** Recorded with each future paper trade so old trades stay explainable if assumptions change. */
export const PAPER_SIMULATION_VERSION = "PAPER_SIM_V1";

export const PAPER_TRADING_BANNER = "PAPER TRADING — NO REAL MONEY";
export const PAPER_SIMULATION_NOTICE =
  "Simulation assumptions only. Fees and slippage are illustrative, are not real brokerage, exchange or tax charges, and simulated fills do not predict real execution.";

/** Currencies paper cash is tracked in. Must cover every seeded asset currency (enforced by a test). */
export const PAPER_CURRENCIES = ["INR", "USDT"] as const;
export type PaperCurrency = (typeof PAPER_CURRENCIES)[number];

/** Mirrors `Market` in types/domain.ts (CRYPTO, NSE, BSE); a test keeps the two in step. */
export const PAPER_MARKETS = ["CRYPTO", "NSE", "BSE"] as const;
export type PaperMarket = (typeof PAPER_MARKETS)[number];

const MAX_BPS = 500; // 5%: an upper sanity bound, not a recommendation
const MAX_CASH = 1_000_000_000_000;

const bps = z.number().finite().min(0).max(MAX_BPS);
const cash = z.number().finite().positive().max(MAX_CASH);

const marketAssumptionSchema = z.object({ feeBps: bps, slippageBps: bps }).strict();

export const paperSimulationConfigSchema = z
  .object({
    version: z.string().min(1),
    /** Starting simulated cash per currency. No cross-currency conversion is modelled. */
    startingCash: z.object({ INR: cash, USDT: cash }).strict(),
    /** Simulated per-side fee and adverse slippage, by market. */
    markets: z
      .object({
        CRYPTO: marketAssumptionSchema,
        NSE: marketAssumptionSchema,
        BSE: marketAssumptionSchema,
      })
      .strict(),
  })
  .strict();

export type PaperSimulationConfig = z.infer<typeof paperSimulationConfigSchema>;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

/** Validates and freezes a config. Throws a ZodError on anything out of range or unknown. */
export function parsePaperSimulationConfig(raw: unknown): Readonly<PaperSimulationConfig> {
  return deepFreeze(paperSimulationConfigSchema.parse(raw));
}

export const PAPER_SIMULATION: Readonly<PaperSimulationConfig> = parsePaperSimulationConfig({
  version: PAPER_SIMULATION_VERSION,
  startingCash: { INR: 1_000_000, USDT: 10_000 },
  markets: {
    CRYPTO: { feeBps: 10, slippageBps: 5 },
    NSE: { feeBps: 5, slippageBps: 5 },
    BSE: { feeBps: 5, slippageBps: 5 },
  },
});

/**
 * Guard rails for opening a simulated trade. Kept next to the simulation assumptions so nothing in
 * the execution path hard-codes a limit. These are safety bounds, not trading advice.
 */
export const paperExecutionLimitsSchema = z
  .object({
    /** An entry quote older than this is refused, even if the market-data facade calls it fresh. */
    maxQuoteAgeMs: z.number().int().positive().max(60 * 60_000),
    /** A quote stamped further in the future than this is treated as inconsistent. */
    maxQuoteFutureSkewMs: z.number().int().min(0).max(5 * 60_000),
    /** Upper sanity bounds, in whole units. They also keep every product inside the DB's numeric range. */
    maxQuantity: z.number().positive().max(1_000_000_000),
    maxPrice: z.number().positive().max(1_000_000_000),
  })
  .strict();

export type PaperExecutionLimits = z.infer<typeof paperExecutionLimitsSchema>;

export function parsePaperExecutionLimits(raw: unknown): Readonly<PaperExecutionLimits> {
  return deepFreeze(paperExecutionLimitsSchema.parse(raw));
}

export const PAPER_EXECUTION_LIMITS: Readonly<PaperExecutionLimits> = parsePaperExecutionLimits({
  maxQuoteAgeMs: 2 * 60_000,
  maxQuoteFutureSkewMs: 60_000,
  maxQuantity: 1_000_000_000,
  maxPrice: 1_000_000_000,
});
