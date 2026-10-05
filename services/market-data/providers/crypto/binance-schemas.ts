import { z } from "zod";

/** Numeric strings as Binance sends them. Rejects NaN/Infinity/empty. */
const numStr = z
  .string()
  .min(1)
  .refine((v) => Number.isFinite(Number(v)), "not a finite number");

/** GET /api/v3/ticker/24hr?symbol=... (FULL response type). */
export const ticker24hrSchema = z.object({
  symbol: z.string(),
  priceChange: numStr,
  priceChangePercent: numStr,
  lastPrice: numStr,
  highPrice: numStr,
  lowPrice: numStr,
  volume: numStr,
  closeTime: z.number().int().positive(),
});
export type BinanceTicker24hr = z.infer<typeof ticker24hrSchema>;

/**
 * GET /api/v3/klines: array of 12-element arrays:
 * [openTime, open, high, low, close, volume, closeTime, quoteVolume, trades, takerBase, takerQuote, ignore]
 * We validate only the first 7 positions we use.
 */
export const klineRowSchema = z
  .array(z.unknown())
  .min(7)
  .transform((row, ctx) => {
    const parsed = z
      .tuple([z.number().int(), numStr, numStr, numStr, numStr, numStr, z.number().int()])
      .safeParse(row.slice(0, 7));
    if (!parsed.success) {
      ctx.addIssue({ code: "custom", message: "malformed kline row" });
      return z.NEVER;
    }
    return parsed.data;
  });
export const klinesSchema = z.array(klineRowSchema);

/** Binance error body: { code: -1121, msg: "Invalid symbol." } */
export const binanceErrorSchema = z.object({ code: z.number(), msg: z.string() });
