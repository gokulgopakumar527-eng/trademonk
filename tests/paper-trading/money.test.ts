import { describe, expect, it } from "vitest";
import { formatMilliBps, formatScaled, mulDivRoundHalfUp, parseQuantity, priceToScaled, scaledToNumber, toMilliBps } from "@/services/paper-trading/money";

describe("parseQuantity", () => {
  it.each([
    [1, "1.00000000"],
    [0.5, "0.50000000"],
    [0.00000001, "0.00000001"],
    [123.45678901, "123.45678901"],
    ["2", "2.00000000"],
    ["0.25", "0.25000000"],
    [" 3.5 ", "3.50000000"],
  ])("accepts %s exactly", (input, text) => {
    expect(formatScaled(parseQuantity(input)!)).toBe(text);
  });

  it.each([
    0, -1, NaN, Infinity, -Infinity, 1e12, 1e21, 0.123456789, 0.1 + 0.2,
    "", "abc", "1e3", "-1", "0", "0.000000000", "1.123456789", "1,5", "0x10", "1 2", null, undefined, {}, [], true,
  ])("rejects %s (never silently rounds)", (input) => {
    expect(parseQuantity(input)).toBeNull();
  });
});

describe("priceToScaled", () => {
  it("normalises a provider float onto the 8-dp grid", () => {
    expect(formatScaled(priceToScaled(67321.55)!)).toBe("67321.55000000");
    expect(formatScaled(priceToScaled(0.1 + 0.2)!)).toBe("0.30000000");
  });
  it.each([0, -5, NaN, Infinity, 1e12, "100", null, undefined])("rejects %s", (p) => {
    expect(priceToScaled(p)).toBeNull();
  });
});

describe("rounding and rates", () => {
  it("rounds half up, never down or to even", () => {
    expect(mulDivRoundHalfUp(5n, 1n, 10n)).toBe(1n); // 0.5 -> 1
    expect(mulDivRoundHalfUp(15n, 1n, 10n)).toBe(2n); // 1.5 -> 2
    expect(mulDivRoundHalfUp(25n, 1n, 10n)).toBe(3n); // 2.5 -> 3 (not 2)
    expect(mulDivRoundHalfUp(4n, 1n, 10n)).toBe(0n);
    expect(mulDivRoundHalfUp(14n, 1n, 10n)).toBe(1n);
  });
  it("refuses negative operands rather than rounding them unpredictably", () => {
    expect(() => mulDivRoundHalfUp(-1n, 1n, 1n)).toThrow(RangeError);
    expect(() => mulDivRoundHalfUp(1n, 1n, 0n)).toThrow(RangeError);
  });
  it("converts basis points to milli-bps and back", () => {
    expect(toMilliBps(10)).toBe(10_000n);
    expect(toMilliBps(0.5)).toBe(500n);
    expect(formatMilliBps(10_000n)).toBe("10.000");
    expect(formatMilliBps(500n)).toBe("0.500");
    expect(formatMilliBps(1n)).toBe("0.001");
  });
  it("rejects invalid rates", () => {
    expect(() => toMilliBps(-1)).toThrow(RangeError);
    expect(() => toMilliBps(NaN)).toThrow(RangeError);
  });
  it("formats and converts without floating-point drift", () => {
    expect(formatScaled(12_345_678_901n)).toBe("123.45678901");
    expect(formatScaled(1n)).toBe("0.00000001");
    expect(scaledToNumber(20_030_010_000n)).toBe(200.3001);
    expect(() => formatScaled(-1n)).toThrow(RangeError);
  });
});
