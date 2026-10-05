import { z } from "zod";

export const MAX_WATCHLISTS = 10;
export const MAX_ITEMS_PER_WATCHLIST = 50;

export const watchlistNameSchema = z
  .string()
  .trim()
  .min(1, "Enter a name")
  .max(60, "Use 60 characters or fewer");

export const idSchema = z.uuid("Invalid identifier");

export const createWatchlistSchema = z.object({ name: watchlistNameSchema });
export const addItemSchema = z.object({ watchlistId: idSchema, assetId: idSchema });
export const removeItemSchema = z.object({ itemId: idSchema });
export const deleteWatchlistSchema = z.object({ watchlistId: idSchema });
