import { describe, expect, it } from "vitest";
import { paperTradeEligibility } from "@/features/paper-trading/eligibility";
import { fmtAmount, fmtPrice, fmtQuantity, numberToDecimalText, toneOfAmount } from "@/features/paper-trading/format";

describe("paper-trading display formatting", () => {
  it("never turns a missing or unreadable value into zero", () => {
    for (const bad of [null, undefined, "", "NaN", "Infinity", "1e5", "abc", "--1"]) {
      expect(fmtAmount(bad, "INR")).toBeNull();
      expect(fmtPrice(bad, "USDT")).toBeNull();
      expect(fmtQuantity(bad)).toBeNull();
      expect(toneOfAmount(bad)).toBe("none");
    }
    expect(numberToDecimalText(NaN)).toBeNull();
    expect(numberToDecimalText(null)).toBeNull();
  });

  it("formats INR and USDT with their own symbol and grouping, never mixed", () => {
    expect(fmtAmount("1000000.00000000", "INR")).toBe("\u20B910,00,000.00");
    expect(fmtAmount("10000.00000000", "USDT")).toBe("10,000.00 USDT");
  });

  it("signs P&L explicitly and does not sign zero or a rounded-to-zero loss", () => {
    expect(fmtAmount("19.37001000", "USDT", { signed: true })).toBe("+19.37 USDT");
    expect(fmtAmount("-4.50000000", "USDT", { signed: true })).toBe("-4.50 USDT");
    expect(fmtAmount("0.00000000", "USDT", { signed: true })).toBe("0.00 USDT");
    expect(fmtAmount("-0.00400000", "USDT", { signed: true })).toBe("0.00 USDT");
  });

  it("rounds half-up on the magnitude without float drift", () => {
    expect(fmtAmount("1.00500000", "USDT")).toBe("1.01 USDT");
    expect(fmtAmount("1.00499999", "USDT")).toBe("1.00 USDT");
    expect(fmtAmount("0.99500000", "USDT")).toBe("1.00 USDT");
    expect(fmtAmount("-1.00500000", "USDT")).toBe("-1.01 USDT");
    expect(fmtAmount("123456789012345.12345678", "USDT", { dp: 8 })).toBe("123,456,789,012,345.12345678 USDT");
  });

  it("keeps small prices readable and trims quantities", () => {
    expect(fmtPrice("67120.50000000", "USDT")).toBe("67,120.50 USDT");
    expect(fmtPrice("0.00001234", "USDT")).toBe("0.00001234 USDT");
    expect(fmtQuantity("0.50000000")).toBe("0.5");
    expect(fmtQuantity("10.00000000")).toBe("10");
  });

  it("tone follows the sign", () => {
    expect(toneOfAmount("1.5")).toBe("gain");
    expect(toneOfAmount("-1.5")).toBe("loss");
    expect(toneOfAmount("0.00000000")).toBe("flat");
  });
});

describe("paperTradeEligibility (display only; the server re-checks)", () => {
  it("offers crypto fractionally and listed equities in whole units", () => {
    expect(paperTradeEligibility({ kind: "CRYPTO", market: "CRYPTO", currency: "USDT" }, true)).toEqual({ eligible: true, wholeUnitsOnly: false });
    expect(paperTradeEligibility({ kind: "EQUITY", market: "NSE", currency: "INR" }, true)).toEqual({ eligible: true, wholeUnitsOnly: true });
  });
  it("hides it for indices, unseeded assets and unknown markets or currencies", () => {
    expect(paperTradeEligibility({ kind: "INDEX", market: "NSE", currency: "INR" }, true)).toMatchObject({ eligible: false });
    expect(paperTradeEligibility({ kind: "CRYPTO", market: "CRYPTO", currency: "USDT" }, false)).toMatchObject({ eligible: false });
    expect(paperTradeEligibility({ kind: "EQUITY", market: "NYSE", currency: "INR" }, true)).toMatchObject({ eligible: false });
    expect(paperTradeEligibility({ kind: "EQUITY", market: "NSE", currency: "EUR" }, true)).toMatchObject({ eligible: false });
  });
});
