import { describe, expect, it } from "vitest";
import {
  PAPER_CURRENCIES,
  PAPER_MARKETS,
  PAPER_SIMULATION,
  PAPER_SIMULATION_NOTICE,
  PAPER_TRADING_BANNER,
  parsePaperSimulationConfig,
} from "@/config/paper-trading";
import { SEED_ASSETS } from "@/config/assets";
import { MARKETS } from "@/types/domain";

const valid = () => structuredClone(PAPER_SIMULATION) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("paper simulation configuration", () => {
  it("the shipped configuration validates, is versioned and is deeply frozen", () => {
    expect(PAPER_SIMULATION.version).toMatch(/^PAPER_SIM_V\d+$/);
    expect(Object.isFrozen(PAPER_SIMULATION)).toBe(true);
    expect(Object.isFrozen(PAPER_SIMULATION.startingCash)).toBe(true);
    expect(Object.isFrozen(PAPER_SIMULATION.markets.CRYPTO)).toBe(true);
  });
  it("covers every market the platform supports", () => {
    expect([...PAPER_MARKETS]).toEqual([...MARKETS]);
    expect(Object.keys(PAPER_SIMULATION.markets).sort()).toEqual([...MARKETS].sort());
  });
  it("has starting cash for every seeded asset currency", () => {
    for (const a of SEED_ASSETS) expect(PAPER_CURRENCIES).toContain(a.currency);
    for (const c of PAPER_CURRENCIES) expect(PAPER_SIMULATION.startingCash[c]).toBeGreaterThan(0);
  });
  it("labels itself as paper trading with simulation assumptions, not brokerage execution", () => {
    expect(PAPER_TRADING_BANNER).toBe("PAPER TRADING — NO REAL MONEY");
    expect(PAPER_SIMULATION_NOTICE).toMatch(/simulation assumptions/i);
    expect(PAPER_SIMULATION_NOTICE).toMatch(/not real brokerage/i);
  });
  it("accepts a well-formed alternative configuration", () => {
    const c = valid();
    c.markets.NSE = { feeBps: 0, slippageBps: 0 };
    expect(parsePaperSimulationConfig(c).markets.NSE.feeBps).toBe(0);
  });

  const bad: [string, (c: Record<string, any>) => void][] = [ // eslint-disable-line @typescript-eslint/no-explicit-any
    ["zero starting cash", (c) => (c.startingCash.INR = 0)],
    ["negative starting cash", (c) => (c.startingCash.USDT = -1)],
    ["NaN starting cash", (c) => (c.startingCash.INR = NaN)],
    ["Infinity starting cash", (c) => (c.startingCash.INR = Infinity)],
    ["string starting cash", (c) => (c.startingCash.INR = "1000000")],
    ["missing currency", (c) => delete c.startingCash.USDT],
    ["unknown currency", (c) => (c.startingCash.EUR = 5)],
    ["negative fee", (c) => (c.markets.CRYPTO.feeBps = -1)],
    ["absurd fee (above the 500 bp bound)", (c) => (c.markets.CRYPTO.feeBps = 501)],
    ["negative slippage", (c) => (c.markets.NSE.slippageBps = -0.1)],
    ["NaN slippage", (c) => (c.markets.BSE.slippageBps = NaN)],
    ["missing market", (c) => delete c.markets.BSE],
    ["unknown market", (c) => (c.markets.NYSE = { feeBps: 1, slippageBps: 1 })],
    ["unknown top-level key", (c) => (c.guaranteedReturn = 1)],
    ["empty version", (c) => (c.version = "")],
  ];
  it.each(bad)("rejects %s", (_name, mutate) => {
    const c = valid();
    mutate(c);
    expect(() => parsePaperSimulationConfig(c)).toThrow();
  });
  it("a parsed config cannot be mutated afterwards", () => {
    const parsed = parsePaperSimulationConfig(valid());
    expect(() => {
      (parsed.startingCash as { INR: number }).INR = 1;
    }).toThrow();
  });
});
