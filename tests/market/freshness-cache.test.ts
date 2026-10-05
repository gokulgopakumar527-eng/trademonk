import { describe, expect, it } from "vitest";
import { assessFreshness, assessSeriesFreshness, formatClock } from "@/services/market-data/freshness";
import { TtlCache } from "@/services/market-data/cache";
import { seriesAt } from "./helpers";

// 2026-09-28T05:02:00Z == 10:32 IST
const T = "2026-09-28T05:02:00.000Z";
const at = (msAfter: number) => new Date(Date.parse(T) + msAfter);

describe("freshness", () => {
  it("formats IST clock labels", () => {
    expect(formatClock(T)).toBe("10:32 IST");
    expect(assessFreshness({ asOf: T, isMock: false }, { now: at(30_000) }).label).toBe("Data updated 10:32 IST");
  });
  it("flags stale quotes and never calls them updated", () => {
    const f = assessFreshness({ asOf: T, isMock: false }, { now: at(5 * 60_000), maxAgeMs: 120_000 });
    expect(f.status).toBe("STALE");
    expect(f.label).toMatch(/^Stale · data as of 10:32 IST$/);
  });
  it("closed/holiday markets show last close instead of stale", () => {
    for (const marketState of ["CLOSED", "HOLIDAY"] as const) {
      const f = assessFreshness({ asOf: T, isMock: false }, { now: at(20 * 3600_000), marketState });
      expect(f.status).toBe("LAST_CLOSE");
      expect(f.label).toContain("Market closed");
    }
  });
  it("labels mock data in every state", () => {
    expect(assessFreshness({ asOf: T, isMock: true }, { now: at(0) }).label.startsWith("MOCK DATA")).toBe(true);
    expect(assessFreshness({ asOf: T, isMock: true }, { now: at(9e6) }).label.startsWith("MOCK DATA")).toBe(true);
  });
  it("treats an unparseable asOf as stale", () => {
    expect(assessFreshness({ asOf: "nope", isMock: false }).status).toBe("STALE");
  });
  it("candle series: fresh when the newest candle is recent, stale when it is older than 2 timeframes", () => {
    const fresh = seriesAt(T, { openTime: T, closed: false });
    expect(assessSeriesFreshness(fresh, { now: at(10 * 60_000) }).status).toBe("FRESH");
    const old = seriesAt(T, { openTime: T, closed: true });
    const f = assessSeriesFreshness(old, { now: at(3 * 3600_000) });
    expect(f.status).toBe("STALE");
    expect(f.label).toMatch(/^Stale/);
    expect(assessSeriesFreshness({ ...old, candles: [] }).label).toBe("No candles available");
  });
});

describe("TtlCache", () => {
  it("expires entries and coalesces concurrent loads", async () => {
    let t = 0;
    const cache = new TtlCache<number>(10, () => t);
    let loads = 0;
    const load = async () => { loads++; return 7; };
    const [a, b] = await Promise.all([cache.getOrLoad("k", () => 1000, load), cache.getOrLoad("k", () => 1000, load)]);
    expect([a, b, loads]).toEqual([7, 7, 1]);
    t = 999; expect(cache.get("k")).toBe(7);
    t = 1000; expect(cache.get("k")).toBeUndefined();
  });
  it("does not cache when ttl is 0 and evicts oldest at capacity", async () => {
    const cache = new TtlCache<number>(2, () => 0);
    await cache.getOrLoad("z", () => 0, async () => 1);
    expect(cache.get("z")).toBeUndefined();
    cache.set("a", 1, 100); cache.set("b", 2, 100); cache.set("c", 3, 100);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("c")).toBe(3);
  });
});
