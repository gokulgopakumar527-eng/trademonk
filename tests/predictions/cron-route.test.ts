import { beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "c".repeat(48);
const state = { secret: SECRET as string | undefined, allowed: true };
const run = vi.fn();

vi.mock("@/lib/env.server", () => ({ getServerEnv: () => ({ CRON_SECRET: state.secret }) }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async () => state.allowed,
  RATE_LIMITS: { predictionEvaluate: { action: "prediction.evaluate", limit: 60, windowSeconds: 3600 } },
}));
vi.mock("@/services/predictions/evaluator-runtime", () => ({ runPredictionEvaluation: (...a: unknown[]) => run(...a) }));

import { AppError } from "@/lib/errors";
import { GET, POST } from "@/app/api/cron/evaluate-predictions/route";

const call = (method: "GET" | "POST", query = "", auth?: string) =>
  (method === "GET" ? GET : POST)(
    new Request(`http://localhost/api/cron/evaluate-predictions${query}`, { method, headers: auth ? { authorization: auth } : {} }),
  );

beforeEach(() => {
  state.secret = SECRET;
  state.allowed = true;
  run.mockReset();
  run.mockResolvedValue({ scanned: 0, evaluated: 0, alreadyEvaluated: 0, unavailable: 0, skipped: 0, failed: 0, outcomes: [] });
});

describe("/api/cron/evaluate-predictions", () => {
  it("runs with the correct bearer secret (GET as Vercel Cron sends, and POST)", async () => {
    for (const m of ["GET", "POST"] as const) {
      const res = await call(m, "", `Bearer ${SECRET}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, scanned: 0 });
    }
    expect(run).toHaveBeenCalledTimes(2);
  });
  it("refuses without a header: 401, and nothing runs", async () => {
    const res = await call("GET");
    expect(res.status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });
  it("refuses a wrong secret", async () => {
    expect((await call("POST", "", `Bearer ${"x".repeat(48)}`)).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });
  it("does not accept the secret in the query string", async () => {
    expect((await call("GET", `?secret=${SECRET}&token=${SECRET}`)).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });
  it("fails closed (503) when CRON_SECRET is not configured, even for an empty bearer", async () => {
    state.secret = undefined;
    expect((await call("GET", "", `Bearer ${SECRET}`)).status).toBe(503);
    expect((await call("GET", "", "Bearer ")).status).toBe(503);
    expect(run).not.toHaveBeenCalled();
  });
  it("does not leak details in any refusal body", async () => {
    const bodies = await Promise.all([call("GET"), call("GET", "", "Bearer nope")].map(async (p) => (await p).text()));
    for (const b of bodies) expect(b).not.toContain(SECRET);
  });
  it("passes only the query params on; an unknown key reaches the strict schema and yields 400", async () => {
    run.mockRejectedValueOnce(new AppError("VALIDATION", "Unrecognized key"));
    const res = await call("GET", "?predictionId=9d8c7b6a-1111-4222-8333-444455556666", `Bearer ${SECRET}`);
    expect(res.status).toBe(400);
    expect(run).toHaveBeenCalledWith({ predictionId: "9d8c7b6a-1111-4222-8333-444455556666" });
  });
  it("forwards ?limit= untouched to the validator", async () => {
    await call("GET", "?limit=5", `Bearer ${SECRET}`);
    expect(run).toHaveBeenCalledWith({ limit: "5" });
  });
  it("is rate limited: 429 and nothing runs", async () => {
    state.allowed = false;
    expect((await call("GET", "", `Bearer ${SECRET}`)).status).toBe(429);
    expect(run).not.toHaveBeenCalled();
  });
  it("an unexpected failure is a generic 500 without internals", async () => {
    run.mockRejectedValueOnce(new Error("db password is hunter2"));
    const res = await call("GET", "", `Bearer ${SECRET}`);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("hunter2");
  });
});
