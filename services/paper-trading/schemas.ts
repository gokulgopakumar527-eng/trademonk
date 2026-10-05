/**
 * Validation of rows read back from `paper_trades` / `paper_trade_results`, turning snake_case
 * database rows into the camelCase domain types. PostgREST may return `numeric` as a number or a
 * string; both are accepted and anything non-finite is rejected rather than coerced to NaN.
 */
import { z } from "zod";
import { parseQuantity } from "./money";
import {
  PAPER_TRADE_SIDES,
  PAPER_TRADE_STATUSES,
  type PaperTrade,
  type PaperTradeResult,
} from "./types";

const numeric = z
  .union([z.number(), z.string().trim().min(1)])
  .transform(Number)
  .pipe(z.number().finite());

const positive = numeric.pipe(z.number().positive());
const nonNegative = numeric.pipe(z.number().min(0));
const timestamp = z.string().min(1);

export const paperTradeSideSchema = z.enum(PAPER_TRADE_SIDES);
export const paperTradeStatusSchema = z.enum(PAPER_TRADE_STATUSES);

export const paperTradeRowSchema = z
  .object({
    id: z.uuid(),
    user_id: z.uuid(),
    asset_id: z.uuid(),
    side: paperTradeSideSchema,
    entry_price: positive,
    quantity: positive,
    stop_loss: positive.nullable(),
    take_profit: positive.nullable(),
    fees: nonNegative,
    strategy_tag: z.string().nullable(),
    status: paperTradeStatusSchema,
    opened_at: timestamp,
    created_at: timestamp,
    updated_at: timestamp,
  })
  .transform(
    (r): PaperTrade => ({
      id: r.id,
      userId: r.user_id,
      assetId: r.asset_id,
      side: r.side,
      entryPrice: r.entry_price,
      quantity: r.quantity,
      stopLoss: r.stop_loss,
      takeProfit: r.take_profit,
      fees: r.fees,
      strategyTag: r.strategy_tag,
      status: r.status,
      openedAt: r.opened_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }),
  );

export const paperTradeResultRowSchema = z
  .object({
    id: z.uuid(),
    paper_trade_id: z.uuid(),
    user_id: z.uuid(),
    exit_price: positive,
    fees: nonNegative,
    pnl: numeric,
    closed_at: timestamp,
  })
  .transform(
    (r): PaperTradeResult => ({
      id: r.id,
      paperTradeId: r.paper_trade_id,
      userId: r.user_id,
      exitPrice: r.exit_price,
      fees: r.fees,
      pnl: r.pnl,
      closedAt: r.closed_at,
    }),
  );

/** The raw database row shapes (what the store layer will receive from Supabase). */
export type PaperTradeRow = z.input<typeof paperTradeRowSchema>;
export type PaperTradeResultRow = z.input<typeof paperTradeResultRowSchema>;

export const parsePaperTradeRow = (raw: unknown): PaperTrade => paperTradeRowSchema.parse(raw);
export const parsePaperTradeResultRow = (raw: unknown): PaperTradeResult =>
  paperTradeResultRowSchema.parse(raw);

/**
 * The ONLY fields a client may send to open a trade. The schema is strict: a supplied user ID,
 * price, fee, slippage, timestamp, cash or balance is a validation error, never silently ignored.
 * Quantity is parsed to an exact fixed-point amount (max 8 decimals; extra precision is rejected).
 */
export const openPaperTradeInputSchema = z
  .object({
    assetId: z.uuid("Choose a valid asset"),
    side: paperTradeSideSchema,
    quantity: z
      .union([z.number(), z.string()])
      .refine((v) => parseQuantity(v) !== null, "Quantity must be a positive number with at most 8 decimal places")
      .transform((v) => parseQuantity(v)!),
  })
  .strict();

export type OpenPaperTradeInput = z.output<typeof openPaperTradeInputSchema>;

/**
 * The ONLY field a client may send to close a trade: which trade. The schema is strict, so a
 * supplied user ID, exit price, fee, slippage, timestamp, P&L, status or balance is a validation
 * error, never silently ignored.
 */
export const closePaperTradeInputSchema = z
  .object({ tradeId: z.uuid("Choose a valid trade") })
  .strict();

export type ClosePaperTradeInput = z.output<typeof closePaperTradeInputSchema>;

/**
 * A portfolio read takes NO client input. `undefined` or an empty object is accepted; a supplied
 * user id, balance, price, fee or P&L is a validation error, never silently ignored.
 */
export const portfolioInputSchema = z.object({}).strict().optional();

/** A closed-trade history read takes NO client input; anything supplied is a validation error. */
export const closedTradesInputSchema = z.object({}).strict().optional();
