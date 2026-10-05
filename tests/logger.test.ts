import { describe, expect, it } from "vitest";
import { redact } from "@/lib/logger";

describe("logger redaction", () => {
  it("redacts sensitive keys at any depth", () => {
    const out = redact({
      email: "a@b.test",
      password: "hunter2",
      nested: { apiKey: "k", SUPABASE_SERVICE_ROLE_KEY: "s", access_token: "t", ok: 1 },
      list: [{ authorization: "Bearer x" }],
    }) as {
      password: string;
      email: string;
      nested: Record<string, unknown>;
      list: Array<Record<string, unknown>>;
    };
    expect(out.password).toBe("[REDACTED]");
    expect(out.nested.apiKey).toBe("[REDACTED]");
    expect(out.nested.SUPABASE_SERVICE_ROLE_KEY).toBe("[REDACTED]");
    expect(out.nested.access_token).toBe("[REDACTED]");
    expect(out.list[0]?.authorization).toBe("[REDACTED]");
    expect(out.nested.ok).toBe(1);
    expect(out.email).toBe("a@b.test");
  });

  it("serialises errors without stack traces", () => {
    expect(redact(new Error("boom"))).toEqual({ name: "Error", message: "boom" });
  });

  it("stops at a maximum depth instead of recursing forever", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => JSON.stringify(redact(a))).not.toThrow();
  });
});
