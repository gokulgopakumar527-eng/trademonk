"use server";

import { revalidatePath } from "next/cache";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import {
  addItemSchema,
  createWatchlistSchema,
  deleteWatchlistSchema,
  removeItemSchema,
} from "@/services/watchlists/schemas";
import {
  addWatchlistItem,
  createWatchlist,
  deleteWatchlist,
  removeWatchlistItem,
} from "@/services/watchlists/watchlist-service";
import { requireUser } from "@/services/profiles/profile-service";
import type { WatchlistFormState } from "./state";

const SEED_HINT =
  "This asset list isn't stored in the database yet, so it can't be added to a watchlist. Run the asset seed script first.";

async function guarded(fn: () => Promise<string>): Promise<WatchlistFormState> {
  try {
    const user = await requireUser();
    if (!(await checkRateLimit(RATE_LIMITS.watchlistWrite, user.id))) {
      return { error: "Too many changes. Wait a few minutes and try again." };
    }
    return { message: await fn() };
  } catch (err) {
    if (err instanceof AppError) {
      if (err.code === "UNAUTHENTICATED") return { error: "Your session has expired. Sign in again." };
      if (err.code === "VALIDATION" || err.code === "NOT_FOUND") return { error: err.message };
    }
    logger.error("watchlist.action_failed", { error: err });
    return { error: "Something went wrong. Try again." };
  }
}

export async function createWatchlistAction(_: WatchlistFormState, formData: FormData): Promise<WatchlistFormState> {
  const parsed = createWatchlistSchema.safeParse({ name: formData.get("name") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid name" };
  const res = await guarded(async () => {
    await createWatchlist(parsed.data.name);
    return "Watchlist created.";
  });
  if (res.message) revalidatePath("/watchlists");
  return res;
}

export async function deleteWatchlistAction(_: WatchlistFormState, formData: FormData): Promise<WatchlistFormState> {
  const parsed = deleteWatchlistSchema.safeParse({ watchlistId: formData.get("watchlistId") });
  if (!parsed.success) return { error: "Invalid watchlist" };
  const res = await guarded(async () => {
    await deleteWatchlist(parsed.data.watchlistId);
    return "Watchlist deleted.";
  });
  if (res.message) revalidatePath("/watchlists");
  return res;
}

export async function addItemAction(_: WatchlistFormState, formData: FormData): Promise<WatchlistFormState> {
  const parsed = addItemSchema.safeParse({
    watchlistId: formData.get("watchlistId"),
    assetId: formData.get("assetId"),
  });
  if (!parsed.success) {
    const assetBad = parsed.error.issues.some((i) => i.path[0] === "assetId");
    const listBad = parsed.error.issues.some((i) => i.path[0] === "watchlistId");
    return { error: assetBad ? SEED_HINT : listBad ? "Choose a watchlist first." : "Invalid request" };
  }
  const res = await guarded(async () => {
    await addWatchlistItem(parsed.data.watchlistId, parsed.data.assetId);
    return "Added to watchlist.";
  });
  if (res.message) {
    revalidatePath("/watchlists");
    revalidatePath("/markets", "layout");
  }
  return res;
}

export async function removeItemAction(_: WatchlistFormState, formData: FormData): Promise<WatchlistFormState> {
  const parsed = removeItemSchema.safeParse({ itemId: formData.get("itemId") });
  if (!parsed.success) return { error: "Invalid request" };
  const res = await guarded(async () => {
    await removeWatchlistItem(parsed.data.itemId);
    return "Removed.";
  });
  if (res.message) revalidatePath("/watchlists");
  return res;
}
