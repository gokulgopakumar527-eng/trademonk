import { describe, expect, it } from "vitest";
import { derivePredictionLifecycle, PREDICTION_LIFECYCLE } from "@/services/predictions/lifecycle";

const created = "2026-09-29T00:00:00.000Z";
const expires = "2026-09-30T00:00:00.000Z";
const at = (iso: string) => new Date(iso);

describe("derived lifecycle CREATED -> ACTIVE -> EXPIRED -> EVALUATED", () => {
  it("is CREATED only when the caller marks the creation call", () => {
    expect(derivePredictionLifecycle({ createdAt: created, expiresAt: expires }, at(created), { justCreated: true })).toBe("CREATED");
  });
  it("is ACTIVE on any ordinary read before expiry", () => {
    expect(derivePredictionLifecycle({ createdAt: created, expiresAt: expires }, at(created))).toBe("ACTIVE");
    expect(derivePredictionLifecycle({ createdAt: created, expiresAt: expires }, at("2026-09-29T23:59:59.999Z"))).toBe("ACTIVE");
  });
  it("is EXPIRED exactly at and after expires_at", () => {
    expect(derivePredictionLifecycle({ createdAt: created, expiresAt: expires }, at(expires))).toBe("EXPIRED");
    expect(derivePredictionLifecycle({ createdAt: created, expiresAt: expires }, at("2027-01-01T00:00:00Z"))).toBe("EXPIRED");
  });
  it("EXPIRED wins over CREATED", () => {
    expect(derivePredictionLifecycle({ createdAt: created, expiresAt: expires }, at(expires), { justCreated: true })).toBe("EXPIRED");
  });
  it("throws on invalid or inverted timestamps rather than guessing", () => {
    expect(() => derivePredictionLifecycle({ createdAt: "x", expiresAt: expires }, at(created))).toThrow(RangeError);
    expect(() => derivePredictionLifecycle({ createdAt: expires, expiresAt: created }, at(created))).toThrow(RangeError);
    expect(() => derivePredictionLifecycle({ createdAt: created, expiresAt: created }, at(created))).toThrow(RangeError);
  });
  it("has lifecycle states only; outcomes live in prediction_results, never in the lifecycle", () => {
    expect([...PREDICTION_LIFECYCLE]).toEqual(["CREATED", "ACTIVE", "EXPIRED", "EVALUATED"]);
  });
  it("is EVALUATED once a result exists, and that is final", () => {
    expect(derivePredictionLifecycle({ createdAt: created, expiresAt: expires }, at(expires), { evaluated: true })).toBe("EVALUATED");
    expect(derivePredictionLifecycle({ createdAt: created, expiresAt: expires }, at("2027-01-01T00:00:00Z"), { evaluated: true })).toBe("EVALUATED");
  });
  it("an expired prediction without a result stays EXPIRED (not evaluated yet)", () => {
    expect(derivePredictionLifecycle({ createdAt: created, expiresAt: expires }, at(expires), { evaluated: false })).toBe("EXPIRED");
  });
});
