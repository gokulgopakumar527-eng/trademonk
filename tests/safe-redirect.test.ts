import { describe, expect, it } from "vitest";
import { sanitizeNextPath } from "@/lib/safe-redirect";

describe("sanitizeNextPath", () => {
  it("keeps same-site paths including query strings", () => {
    expect(sanitizeNextPath("/markets/btc?tf=1d")).toBe("/markets/btc?tf=1d");
  });
  it.each([
    "https://evil.test",
    "//evil.test",
    "/\\evil.test",
    "javascript:alert(1)",
    "evil",
    "/a\nb",
    "",
  ])("rejects %j", (bad) => expect(sanitizeNextPath(bad)).toBe("/dashboard"));
  it("falls back for null/undefined", () => {
    expect(sanitizeNextPath(null)).toBe("/dashboard");
    expect(sanitizeNextPath(undefined, "/x")).toBe("/x");
  });
});
