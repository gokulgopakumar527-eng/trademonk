import { describe, expect, it } from "vitest";
import {
  addItemSchema,
  createWatchlistSchema,
  removeItemSchema,
  MAX_ITEMS_PER_WATCHLIST,
  MAX_WATCHLISTS,
} from "@/services/watchlists/schemas";

const UUID = "3f2b8c1e-5a4d-4c7b-9e21-0a1b2c3d4e5f";

describe("watchlist schemas", () => {
  it("trims names and rejects empty or over-long names", () => {
    expect(createWatchlistSchema.parse({ name: "  Crypto  " }).name).toBe("Crypto");
    expect(createWatchlistSchema.safeParse({ name: "   " }).success).toBe(false);
    expect(createWatchlistSchema.safeParse({ name: "x".repeat(61) }).success).toBe(false);
    expect(createWatchlistSchema.safeParse({ name: "x".repeat(60) }).success).toBe(true);
  });
  it("requires UUIDs, so seed:* placeholder assets can never reach the database", () => {
    expect(addItemSchema.safeParse({ watchlistId: UUID, assetId: UUID }).success).toBe(true);
    expect(addItemSchema.safeParse({ watchlistId: UUID, assetId: "seed:btc" }).success).toBe(false);
    expect(addItemSchema.safeParse({ watchlistId: "nope", assetId: UUID }).success).toBe(false);
    expect(removeItemSchema.safeParse({ itemId: "1 or 1=1" }).success).toBe(false);
  });
  it("has sane caps", () => {
    expect(MAX_WATCHLISTS).toBeGreaterThan(0);
    expect(MAX_ITEMS_PER_WATCHLIST).toBeGreaterThan(0);
  });
});
