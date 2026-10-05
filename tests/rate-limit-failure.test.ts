import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SERVICE_KEY = "service-role-key-0123456789-abcdef";
const h = vi.hoisted(() => ({
  appEnv: "production" as string | undefined,
  envThrows: false,
  rpc: vi.fn(),
  adminThrows: false,
  envReads: 0,
}));

vi.mock("@/lib/env.server", () => ({
  getServerEnv: () => {
    h.envReads += 1;
    if (h.envThrows) throw new Error("Invalid server environment variables: APP_ENV");
    return { APP_ENV: h.appEnv, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY };
  },
}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => {
    if (h.adminThrows) throw new Error("admin client unavailable");
    return { rpc: h.rpc };
  },
}));

import { checkRateLimit, rateLimitFailureMode, RATE_LIMITS } from "@/lib/rate-limit";

const RULE = RATE_LIMITS.paperTradeOpen;

let errSpy: { mock: { calls: unknown[][] }; mockRestore: () => void };

beforeEach(() => {
  // The limiter logs every failure at error level; capture it instead of spamming test output.
  errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  h.appEnv = "production";
  h.envThrows = false;
  h.adminThrows = false;
  h.envReads = 0;
  h.rpc.mockReset();
  h.rpc.mockResolvedValue({ data: true, error: null });
});

afterEach(() => errSpy.mockRestore());

describe("rateLimitFailureMode (pure policy)", () => {
  it("fails open ONLY for an explicit development", () => {
    expect(rateLimitFailureMode("development")).toBe("open");
  });
  it("fails closed for staging, production, undefined, empty and unrecognised values", () => {
    for (const v of ["staging", "production", undefined, "", "Development", "dev", "prod", "test"]) {
      expect(rateLimitFailureMode(v), String(v)).toBe("closed");
    }
  });
});

describe("checkRateLimit: healthy store", () => {
  it("allows when the store says true, in every environment, without consulting the failure policy", async () => {
    for (const env of ["development", "staging", "production"]) {
      h.appEnv = env;
      expect(await checkRateLimit(RULE, "user-1")).toBe(true);
    }
    expect(h.envReads).toBe(0);
  });

  it("denies when the store says false", async () => {
    h.rpc.mockResolvedValue({ data: false, error: null });
    expect(await checkRateLimit(RULE, "user-1")).toBe(false);
  });

  it("treats any non-`true` store answer as a denial (null, 1, 'true')", async () => {
    for (const data of [null, undefined, 1, "true"]) {
      h.rpc.mockResolvedValue({ data, error: null });
      expect(await checkRateLimit(RULE, "user-1"), String(data)).toBe(false);
    }
  });

  it("hashes the identifier: the raw id never reaches the RPC", async () => {
    await checkRateLimit(RULE, "203.0.113.9");
    const args = h.rpc.mock.calls[0]![1] as { p_key: string };
    expect(args.p_key).not.toContain("203.0.113.9");
  });
});

describe("checkRateLimit: store unavailable", () => {
  const failures: Array<[string, () => void]> = [
    ["rpc returns an error", () => h.rpc.mockResolvedValue({ data: null, error: new Error("relation does not exist") })],
    ["rpc rejects (network)", () => h.rpc.mockRejectedValue(new Error("fetch failed"))],
    ["admin client cannot be created", () => { h.adminThrows = true; }],
  ];

  for (const [name, arrange] of failures) {
    for (const env of ["staging", "production"]) {
      it(`${env}: fails CLOSED when ${name}`, async () => {
        h.appEnv = env;
        arrange();
        expect(await checkRateLimit(RULE, "user-1")).toBe(false);
      });
    }

    it(`explicit development: fails open when ${name} (local convenience)`, async () => {
      h.appEnv = "development";
      arrange();
      expect(await checkRateLimit(RULE, "user-1")).toBe(true);
    });

    it(`unset or invalid APP_ENV: fails CLOSED when ${name}`, async () => {
      for (const v of [undefined, "", "prod", "Development"]) {
        h.appEnv = v;
        arrange();
        expect(await checkRateLimit(RULE, "user-1"), String(v)).toBe(false);
      }
    });

    it(`unresolvable environment: fails CLOSED (and does not throw) when ${name}`, async () => {
      h.envThrows = true;
      arrange();
      await expect(checkRateLimit(RULE, "user-1")).resolves.toBe(false);
    });
  }

  it("logs the failure with its mode and never writes the service-role key or the raw identifier", async () => {
    h.appEnv = "production";
    h.rpc.mockRejectedValue(new Error("fetch failed"));
    await checkRateLimit(RULE, "203.0.113.9");
    const lines = errSpy.mock.calls.map((c) => String(c[0]));
    const line = lines.find((l) => l.includes("rate_limit.check_failed"));
    expect(line).toBeDefined();
    expect(JSON.parse(line!)).toMatchObject({ event: "rate_limit.check_failed", action: RULE.action, failMode: "closed" });
    for (const l of lines) {
      expect(l).not.toContain(SERVICE_KEY);
      expect(l).not.toContain("203.0.113.9");
    }
  });
});
