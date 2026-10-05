import { describe, expect, it } from "vitest";
import { magicLinkSchema, signInSchema, signUpSchema } from "@/features/auth/schemas";

describe("auth schemas", () => {
  it("normalises email case and whitespace", () => {
    expect(magicLinkSchema.parse({ email: "  Alice@Example.COM " }).email).toBe(
      "alice@example.com",
    );
  });
  it("rejects an invalid email", () => {
    expect(signInSchema.safeParse({ email: "nope", password: "x" }).success).toBe(false);
  });
  it("requires a password on sign-in", () => {
    expect(signInSchema.safeParse({ email: "a@b.co", password: "" }).success).toBe(false);
  });
  it.each([
    ["short1", false],
    ["allletterspassword", false],
    ["1234567890123", false],
    ["longenough123", true],
  ])("sign-up password %s valid=%s", (password, valid) => {
    expect(signUpSchema.safeParse({ name: "A", email: "a@b.co", password }).success).toBe(valid);
  });
  it("requires a name on sign-up", () => {
    expect(
      signUpSchema.safeParse({ name: "  ", email: "a@b.co", password: "longenough123" }).success,
    ).toBe(false);
  });
});
