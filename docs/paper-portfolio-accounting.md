# Paper portfolio accounting (Phase 5C-4)

PAPER TRADING — NO REAL MONEY. Simulation only. These definitions describe the simulator, not
any real account, and passing local tests does not make them production-verified.

Computed by `getPortfolio(userId)` (`services/paper-trading/portfolio.ts`), read-only, per currency
(INR and USDT are never summed; no conversion is modelled). All arithmetic is bigint fixed-point
(1e-8 units, half-up rounding, same helpers as open/close). Amounts are returned as exact decimal strings.

| Term | Definition |
|---|---|
| Cash balance | `paper_accounts.cash_balance`. Entry cost (notional + entry fee) has already left it. |
| Open entry cost | Sum of `cash_debited` over OPEN trades. Capital deployed (exposure at cost). **Not** added to equity on top of cash. |
| Realized P&L | Sum of `paper_trade_results.pnl` = sum(cash credited − cash debited); net of both fees and both slippages. |
| Mark value | Sum of `round(quote price × quantity)` over open positions, using the validated quote price (no slippage, no exit fee). |
| Unrealized P&L | Mark value − open entry cost. The entry fee is inside the cost base, so it is charged exactly once. No hypothetical exit fee or slippage is deducted. |
| Equity | Cash balance + mark value. |
| Book value | Cash balance + open entry cost (open positions at cost). Needs no quotes. |

Identity checked per currency (reported as `reconciliation`, never forced):
`cash + open entry cost == starting cash + realized P&L`, hence `equity == starting cash + realized + unrealized`.

Exposure vs equity: exposure (open entry cost) is how much is tied up in open positions; equity is the
whole account marked to market. Each entry cost and fee is counted once: as a deduction in cash, as the
cost base in unrealized P&L, never again on top of equity.

Quote handling: the same gates as open/close (unavailable, mock outside development, non-provider,
market closed, stale by facade status or by `maxQuoteAgeMs`, future-dated, wrong identity, invalid price).
A position that fails is `UNVALUED` with a reason; its currency's mark value, unrealized P&L and equity are
`null` (never zero or cost). Cash, entry cost, realized P&L and book value still return.

Known limitations: see the Phase 5C-4 report (market-closed positions are not marked; reads are not one
database transaction; no UI, history or per-asset/strategy analytics).

## Paper-trading UI (Phase 5C-5)

PAPER TRADING — NO REAL MONEY. The UI only displays what the server calculated; it adds no accounting.

- **Page:** `/paper-trading` (`app/(app)/paper-trading/page.tsx`) reads `getPortfolio` and the new `getClosedTrades` through
  `features/paper-trading/server.ts` for the session user only. INR and USDT render in separate sections and are never summed.
  An unavailable value (unvalued position, incomplete currency) is shown as words ("Unavailable"), never `0`.
- **Open:** asset page → Overview → "Paper trade" panel. `previewPaperTradeAction` returns a server-computed, read-only
  *estimate* (same gates and arithmetic as opening, writes nothing, own rate-limit bucket); `openPaperTradeAction` then re-quotes
  and fills. BUY/LONG only. The estimate is not a promise: the real fill can differ.
- **Close:** each open position has "Close" → confirmation step → `closePaperTradeAction({ tradeId })`. Exit price, fee and realized
  P&L come back from the server and are shown as returned.
- **History:** `getClosedTrades` returns the most recent 50 closed trades (newest first) with the true total, assembled from the stored
  `paper_trades` + immutable `paper_trade_results` rows (entry fee, exit fee, stored P&L). Nothing is recomputed. No migration was added.
- **Display rounding** (`features/paper-trading/format.ts`) is half-up on exact decimal strings and never feeds back into any calculation.
