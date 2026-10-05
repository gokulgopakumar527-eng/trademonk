import { beforeEach, describe, expect, it, vi } from "vitest";

const from = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ from }),
}));

import { SEED_ASSETS } from "@/config/assets";
import {
  findAssetBySlug,
  isPersistedAsset,
  loadCatalog,
  SEED_ID_PREFIX,
} from "@/services/market-data/asset-repository";

function query(result: { data: unknown; error: unknown }) {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order"]) q[m] = () => q;
  q.then = (res: (v: unknown) => unknown) => Promise.resolve(result).then(res);
  return q;
}

describe("asset catalogue", () => {
  beforeEach(() => from.mockReset());

  it("uses database rows when present", async () => {
    from.mockReturnValue(
      query({ data: [{ id: "11111111-1111-4111-8111-111111111111", market: "CRYPTO", symbol: "BTC", name: "Bitcoin", asset_type: "CRYPTO", currency: "USDT" }], error: null }),
    );
    const c = await loadCatalog();
    expect(c.fromDatabase).toBe(true);
    expect(c.assets).toHaveLength(1);
    expect(isPersistedAsset(c.assets[0]!)).toBe(true);
  });

  it("falls back to the seed list, marked as not persisted, when the table is empty", async () => {
    from.mockReturnValue(query({ data: [], error: null }));
    const c = await loadCatalog();
    expect(c.fromDatabase).toBe(false);
    expect(c.assets).toHaveLength(SEED_ASSETS.length);
    expect(c.assets.every((a) => a.id.startsWith(SEED_ID_PREFIX) && !isPersistedAsset(a))).toBe(true);
  });

  it("falls back when the query errors", async () => {
    from.mockReturnValue(query({ data: null, error: new Error("relation does not exist") }));
    expect((await loadCatalog()).fromDatabase).toBe(false);
  });

  it("resolves slugs and rejects malformed ones", async () => {
    from.mockReturnValue(query({ data: [], error: null }));
    expect((await findAssetBySlug("bank-nifty"))?.symbol).toBe("BANK NIFTY");
    expect(await findAssetBySlug("btc")).not.toBeNull();
    expect(await findAssetBySlug("BTC; drop table")).toBeNull();
    expect(await findAssetBySlug("nope")).toBeNull();
  });
});
