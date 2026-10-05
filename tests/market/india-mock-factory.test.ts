import { describe, expect, it } from "vitest";
import { computeIndiaMarketStatus, istParts } from "@/services/market-data/india-market-status";
import { EMPTY_INDIA_CALENDAR, type IndiaHolidayCalendar } from "@/config/market-calendars/india";
import { loadIndiaCalendar } from "@/services/market-data/calendar-loader";
import { IndianMarketProvider, type IndianVendorAdapter } from "@/services/market-data/providers/indian/indian-provider";
import { MockMarketProvider } from "@/services/market-data/providers/mock/mock-provider";
import { buildRegistry } from "@/services/market-data/registry-factory";
import { ok } from "@/services/market-data/result";
import { BTC, NIFTY, quoteAt } from "./helpers";

// TEST calendar: dates are synthetic and do NOT assert real exchange holidays.
const TEST_CAL: IndiaHolidayCalendar = {
  verified: true,
  sourceUrl: "https://example.test/circular",
  verifiedOn: "2026-09-01",
  coveredYears: [2026],
  holidays: [{ date: "2026-09-29", description: "TEST HOLIDAY" }],
  specialSessions: [{ date: "2026-10-04", start: "18:00", end: "19:15", description: "TEST SPECIAL SESSION" }],
};
// IST -> UTC helper: IST = UTC + 5:30
const ist = (d: string, hhmm: string) => new Date(`${d}T${hhmm}:00+05:30`);
const status = (d: Date, cal = TEST_CAL) => computeIndiaMarketStatus("NSE", d, cal, "t");

describe("NSE/BSE market status", () => {
  it("follows the regular weekday session (Mon 2026-09-28)", () => {
    expect(status(ist("2026-09-28", "08:59")).state).toBe("CLOSED");
    expect(status(ist("2026-09-28", "09:00")).state).toBe("PRE_OPEN");
    expect(status(ist("2026-09-28", "09:15")).state).toBe("OPEN");
    expect(status(ist("2026-09-28", "15:29")).state).toBe("OPEN");
    expect(status(ist("2026-09-28", "15:30")).state).toBe("CLOSED");
  });
  it("is closed on weekends and on listed holidays", () => {
    expect(status(ist("2026-10-03", "11:00")).state).toBe("CLOSED"); // Saturday
    const h = status(ist("2026-09-29", "11:00"));
    expect(h.state).toBe("HOLIDAY");
    expect(h.note).toContain("TEST HOLIDAY");
  });
  it("supports special sessions on otherwise closed days", () => {
    expect(status(ist("2026-10-04", "18:30")).state).toBe("OPEN"); // Sunday special session
    expect(status(ist("2026-10-04", "20:00")).state).toBe("CLOSED");
  });
  it("basis is CALENDAR only with a verified calendar covering the year", () => {
    expect(status(ist("2026-09-28", "10:00")).basis).toBe("CALENDAR");
    const none = status(ist("2026-09-28", "10:00"), EMPTY_INDIA_CALENDAR);
    expect(none.basis).toBe("SCHEDULE_ONLY");
    expect(none.note).toMatch(/Holiday calendar not loaded/);
    expect(status(ist("2027-01-04", "10:00")).basis).toBe("SCHEDULE_ONLY"); // year not covered
  });
  it("computes the next transition, skipping holidays and weekends", () => {
    expect(status(ist("2026-09-28", "10:00")).nextChangeAt).toBe(ist("2026-09-28", "15:30").toISOString());
    // After close Monday, Tuesday is a (test) holiday, so the next change is Wed pre-open.
    expect(status(ist("2026-09-28", "16:00")).nextChangeAt).toBe(ist("2026-09-30", "09:00").toISOString());
  });
  it("converts instants to IST parts across the UTC date boundary", () => {
    const p = istParts(new Date("2026-09-27T20:00:00Z")); // 01:30 IST Monday
    expect(p).toMatchObject({ date: "2026-09-28", weekday: 1, minutes: 90 });
  });
});

describe("calendar loader", () => {
  it("ships an unverified, empty calendar (no unverified holiday dates)", () => {
    const c = loadIndiaCalendar();
    expect(c.verified).toBe(false);
    expect(c.holidays).toEqual([]);
  });
  it("falls back to empty on malformed input and distrusts 'verified' without provenance", () => {
    expect(loadIndiaCalendar({ nope: true })).toEqual(EMPTY_INDIA_CALENDAR);
    expect(loadIndiaCalendar({ ...TEST_CAL, sourceUrl: null }).verified).toBe(false);
    expect(loadIndiaCalendar(TEST_CAL).verified).toBe(true);
  });
});

describe("IndianMarketProvider", () => {
  it("without a vendor: data => NOT_CONFIGURED, status still works, other markets UNSUPPORTED", async () => {
    const p = new IndianMarketProvider({ calendar: TEST_CAL, now: () => ist("2026-09-28", "10:00") });
    const q = await p.getQuote(NIFTY);
    expect(!q.ok && q.error.code).toBe("NOT_CONFIGURED");
    expect(p.capabilities.supports).toMatchObject({ quote: false, historical: false, marketStatus: true });
    const st = await p.getMarketStatus("NSE");
    expect(st.ok && st.data.state).toBe("OPEN");
    const c = await p.getQuote(BTC);
    expect(!c.ok && c.error.code).toBe("UNSUPPORTED");
  });
  it("delegates to a plugged-in vendor adapter and inherits its capabilities", async () => {
    const adapter: IndianVendorAdapter = {
      id: "vendor-x",
      displayName: "Vendor X",
      capabilities: {
        markets: ["NSE", "BSE"],
        supports: { quote: true, historical: false, marketStatus: false, search: false, orderBook: false, fundingRate: false, openInterest: false, news: false },
        timeframes: ["1d"],
        maxCandlesPerRequest: 100,
      },
      getQuote: async () => ok(quoteAt("2026-09-28T05:00:00.000Z", { market: "NSE", symbol: "NIFTY 50", currency: "INR", source: "vendor-x" })),
      getHistoricalData: async () => { throw new Error("unused"); },
    };
    const p = new IndianMarketProvider({ adapter });
    expect(p.id).toBe("indian:vendor-x");
    expect(p.capabilities.supports.quote).toBe(true);
    const q = await p.getQuote(NIFTY);
    expect(q.ok && q.data.source).toBe("vendor-x");
  });
});

describe("MockMarketProvider and registry factory", () => {
  it("refuses to be constructed outside development", () => {
    expect(() => new MockMarketProvider({ appEnv: "production" })).toThrow();
    expect(() => new MockMarketProvider({ appEnv: "staging" })).toThrow();
  });
  it("labels everything isMock and is deterministic per symbol/time", async () => {
    const now = new Date("2026-09-28T05:00:00Z");
    const m = new MockMarketProvider({ appEnv: "development", now: () => now });
    const a = await m.getQuote(BTC);
    const b = await m.getQuote(BTC);
    expect(a.ok && a.data.isMock).toBe(true);
    expect(a.ok && b.ok && a.data.price).toBe(b.ok ? b.data.price : -1);
    const s = await m.getHistoricalData({ asset: BTC, timeframe: "1h", limit: 50 });
    expect(s.ok && s.data.isMock && s.data.candles.length).toBe(50);
    if (s.ok) for (const c of s.data.candles) expect(c.high).toBeGreaterThanOrEqual(Math.max(c.open, c.close));
  });
  it("never routes to mock outside development, even if configured", () => {
    const reg = buildRegistry({ APP_ENV: "production", CRYPTO_PROVIDER: "mock", BINANCE_BASE_URL: undefined, INDIAN_MARKET_PROVIDER: "mock" });
    expect(reg.primary("CRYPTO")?.id).toBe("binance-public");
    expect(reg.chain("NSE").map((p) => p.id)).toEqual(["indian:unconfigured"]);
  });
  it("keeps crypto and Indian chains separate, and honours mock in development", () => {
    const reg = buildRegistry({ APP_ENV: "development", CRYPTO_PROVIDER: "binance", BINANCE_BASE_URL: undefined, INDIAN_MARKET_PROVIDER: "mock" });
    expect(reg.chain("CRYPTO").map((p) => p.id)).toEqual(["binance-public"]);
    expect(reg.chain("NSE").map((p) => p.id)).toEqual(["indian:unconfigured", "mock"]);
  });
});
