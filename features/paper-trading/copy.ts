/** Fixed wording for the paper-trading UI. One place, so every surface says the same thing. */
export const PAPER_BANNER_TEXT = "PAPER TRADING — NO REAL MONEY";

export const PAPER_RESULTS_DISCLAIMER =
  "Paper-trading results are simulations. They do not guarantee, and are not a forecast of, performance in live markets. No real order is ever placed.";

export const PAPER_SIDES_NOTE =
  "Only BUY and LONG are supported. SELL and SHORT need margin and borrow accounting that is not modelled.";

/** Why a position has no valuation, in words. Never a number. */
export const VALUATION_REASON_TEXT: Record<string, string> = {
  QUOTE_UNAVAILABLE: "No live price available",
  QUOTE_STALE: "Price is stale",
  QUOTE_NOT_LIVE: "Only a saved price is available",
  MARKET_CLOSED: "Market closed, no live price",
  MOCK_DATA_NOT_ALLOWED: "Only mock data is available",
  DATA_INCONSISTENT: "Market data was inconsistent",
  POSITION_NOT_VALUABLE: "This position cannot be valued",
};

export const RECONCILIATION_TEXT = {
  CONSISTENT: "Balances reconcile",
  MISMATCH: "Balances do not reconcile",
  INCOMPLETE_RECORDS: "Some records are unusable, so no reconciliation is claimed",
} as const;
