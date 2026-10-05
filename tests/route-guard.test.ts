import { describe, expect, it } from "vitest";
import { isAdminPath, isAuthPage, isProtectedPath } from "@/lib/supabase/route-guard";

describe("route guard", () => {
  it.each([
    "/dashboard",
    "/markets",
    "/markets/btc",
    "/predictions",
    "/paper-trading",
    "/settings",
    "/admin",
    "/admin/users",
  ])("protects %s", (p) => expect(isProtectedPath(p)).toBe(true));
  it.each([
    "/",
    "/login",
    "/signup",
    "/terms",
    "/privacy",
    "/risk-disclosure",
    "/legal",
    "/api/health",
    "/auth/callback",
  ])("leaves %s public", (p) => expect(isProtectedPath(p)).toBe(false));
  it("does not treat look-alike prefixes as protected", () => {
    expect(isProtectedPath("/marketsplace")).toBe(false);
    expect(isAdminPath("/administrator")).toBe(false);
  });
  it("identifies admin and auth pages", () => {
    expect(isAdminPath("/admin/anything")).toBe(true);
    expect(isAuthPage("/login")).toBe(true);
    expect(isAuthPage("/dashboard")).toBe(false);
  });
});
