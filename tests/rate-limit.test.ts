import { describe, expect, it } from "vitest";
import { buildRateLimitKey, clientIdFromHeaders, RATE_LIMITS } from "@/lib/rate-limit";

describe("rate limit helpers", () => {
  it("hashes identifiers so raw IPs are not stored", () => {
    const key = buildRateLimitKey("auth.sign_in", "203.0.113.9");
    expect(key.startsWith("auth.sign_in:")).toBe(true);
    expect(key).not.toContain("203.0.113.9");
  });
  it("is stable per identifier and distinct across identifiers/actions", () => {
    expect(buildRateLimitKey("a", "1.1.1.1")).toBe(buildRateLimitKey("a", "1.1.1.1"));
    expect(buildRateLimitKey("a", "1.1.1.1")).not.toBe(buildRateLimitKey("a", "2.2.2.2"));
    expect(buildRateLimitKey("a", "1.1.1.1")).not.toBe(buildRateLimitKey("b", "1.1.1.1"));
  });
  it("uses the first hop in x-forwarded-for", () => {
    expect(clientIdFromHeaders(new Headers({ "x-forwarded-for": "9.9.9.9, 10.0.0.1" }))).toBe(
      "9.9.9.9",
    );
  });
  it("falls back gracefully without proxy headers", () => {
    expect(clientIdFromHeaders(new Headers())).toBe("unknown");
  });
  it("defines sane limits for every auth action", () => {
    for (const rule of Object.values(RATE_LIMITS)) {
      expect(rule.limit).toBeGreaterThan(0);
      expect(rule.windowSeconds).toBeGreaterThanOrEqual(60);
    }
  });
});
