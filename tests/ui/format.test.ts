import { describe, expect, it } from "vitest";
import { formatCompact, formatNumber, formatPct, formatPrice, formatSigned, toneOf } from "@/lib/format";

describe("format", () => {
  it("never renders a number for missing or non-finite input", () => {
    for (const v of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatPrice(v, "USDT")).toBe("\u2014");
      expect(formatPct(v)).toBe("\u2014");
      expect(formatCompact(v)).toBe("\u2014");
      expect(formatNumber(v)).toBe("\u2014");
      expect(formatSigned(v, "INR")).toBe("\u2014");
      expect(toneOf(v)).toBe("none");
    }
  });
  it("formats INR with the rupee sign and Indian grouping", () => {
    expect(formatPrice(2435010.5, "INR")).toBe("\u20B924,35,010.50");
  });
  it("formats other currencies with a suffix and keeps precision for small prices", () => {
    expect(formatPrice(67120.5, "USDT")).toBe("67,120.50 USDT");
    expect(formatPrice(0.0821, "USDT")).toBe("0.0821 USDT");
    expect(formatPrice(0.000123, "USDT")).toBe("0.000123 USDT");
  });
  it("signs percentages and tones them", () => {
    expect(formatPct(1.234)).toBe("+1.23%");
    expect(formatPct(-0.5)).toBe("-0.50%");
    expect(formatPct(0)).toBe("0.00%");
    expect(toneOf(1)).toBe("gain");
    expect(toneOf(-1)).toBe("loss");
    expect(toneOf(0)).toBe("flat");
  });
  it("formats signed absolute changes", () => {
    expect(formatSigned(-12.5, "USDT")).toBe("-12.50 USDT");
    expect(formatSigned(12.5, "USDT")).toBe("+12.50 USDT");
  });
  it("compacts volume", () => {
    expect(formatCompact(1_234_567)).toBe("1.23M");
  });
});
