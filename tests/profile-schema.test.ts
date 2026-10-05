import { describe, expect, it } from "vitest";
import { profileUpdateSchema } from "@/services/profiles/profile-schema";

const base = {
  name: "Asha",
  timezone: "Asia/Kolkata",
  preferred_currency: "INR",
  preferred_markets: ["NSE", "CRYPTO"],
};

describe("profileUpdateSchema", () => {
  it("accepts a valid profile", () =>
    expect(profileUpdateSchema.safeParse(base).success).toBe(true));
  it("rejects an unknown timezone", () =>
    expect(profileUpdateSchema.safeParse({ ...base, timezone: "Mars/Olympus" }).success).toBe(
      false,
    ));
  it("rejects lowercase or malformed currency", () => {
    expect(profileUpdateSchema.safeParse({ ...base, preferred_currency: "inr" }).success).toBe(
      false,
    );
    expect(profileUpdateSchema.safeParse({ ...base, preferred_currency: "RUPEE" }).success).toBe(
      false,
    );
  });
  it("rejects unknown markets", () =>
    expect(profileUpdateSchema.safeParse({ ...base, preferred_markets: ["NASDAQ"] }).success).toBe(
      false,
    ));
  it("does not accept a role field", () => {
    const parsed = profileUpdateSchema.parse({ ...base, role: "admin" } as never);
    expect("role" in parsed).toBe(false);
  });
});
