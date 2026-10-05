import { describe, expect, it } from "vitest";
import { primaryNav } from "@/config/nav";

describe("primary navigation", () => {
  it("matches the product spec order", () => {
    expect(primaryNav.map((n) => n.label)).toEqual([
      "Dashboard",
      "Markets",
      "Watchlists",
      "Predictions",
      "Paper Trading",
      "AI Research",
      "Alerts",
      "News",
      "Settings",
    ]);
  });
  it("has unique hrefs", () => {
    expect(new Set(primaryNav.map((n) => n.href)).size).toBe(primaryNav.length);
  });
});
