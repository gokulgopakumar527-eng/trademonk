import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONFIRM_PREFIX,
  argValue,
  evaluateSmokeGuard,
  isSmokeEmail,
  newRunId,
  projectRefFromUrl,
  smokeEmail,
  unverifiedJwtClaims,
} from "../scripts/lib/staging-smoke-guard";

const STAGING = "stagingrefabcdefghij";
const PROD = "prodrefabcdefghijklm";
const jwt = (claims: Record<string, unknown>) =>
  `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

const goodEnv = (): Record<string, string> => ({
  APP_ENV: "staging",
  NEXT_PUBLIC_SUPABASE_URL: `https://${STAGING}.supabase.co`,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: jwt({ role: "anon", ref: STAGING }),
  SUPABASE_SERVICE_ROLE_KEY: jwt({ role: "service_role", ref: STAGING }),
  STAGING_SUPABASE_PROJECT_REF: STAGING,
  PRODUCTION_SUPABASE_PROJECT_REF: PROD,
});
const argv = (...a: string[]) => ["--project-ref", STAGING, ...a];
const problems = (env: Record<string, string | undefined>, a = argv()) => {
  const r = evaluateSmokeGuard({ env, argv: a });
  if (r.ok) throw new Error("expected a refusal");
  return r.problems.join("\n");
};

describe("staging smoke guard", () => {
  it("allows a read-only dry run when everything agrees", () => {
    expect(evaluateSmokeGuard({ env: goodEnv(), argv: argv() })).toEqual({
      ok: true,
      target: { projectRef: STAGING, mode: "dry-run" },
    });
  });

  it("enters write mode only with the exact confirmation for this project", () => {
    expect(
      evaluateSmokeGuard({
        env: goodEnv(),
        argv: argv("--confirm-writes", `${CONFIRM_PREFIX}${STAGING}`),
      }),
    ).toEqual({
      ok: true,
      target: { projectRef: STAGING, mode: "write" },
    });
    for (const wrong of ["yes", "true", `${CONFIRM_PREFIX}${PROD}`, CONFIRM_PREFIX, ""]) {
      expect(problems(goodEnv(), argv("--confirm-writes", wrong))).toContain(
        "--confirm-writes must be exactly",
      );
    }
    expect(problems(goodEnv(), argv("--confirm-writes"))).toContain(
      "--confirm-writes must be exactly",
    );
  });

  it.each([undefined, "", "development", "production", "Staging", "staging "])(
    "refuses APP_ENV=%j",
    (appEnv) => {
      expect(problems({ ...goodEnv(), APP_ENV: appEnv })).toContain("APP_ENV must be exactly");
    },
  );

  it("refuses a production Vercel deployment", () => {
    expect(problems({ ...goodEnv(), VERCEL_ENV: "production" })).toContain("VERCEL_ENV=production");
  });

  it("refuses when the URL is the declared production project, even if everything else says staging", () => {
    const env = { ...goodEnv(), NEXT_PUBLIC_SUPABASE_URL: `https://${PROD}.supabase.co` };
    const out = problems(env, ["--project-ref", PROD]);
    expect(out).toContain("PRODUCTION project");
    expect(out).toContain("not the declared staging project");
  });

  it("refuses when the production ref is not declared (cannot prove it is not production)", () => {
    expect(problems({ ...goodEnv(), PRODUCTION_SUPABASE_PROJECT_REF: undefined })).toContain(
      "PRODUCTION_SUPABASE_PROJECT_REF is not set",
    );
  });

  it("refuses identical staging/production refs, a missing or wrong --project-ref, and a mismatched declaration", () => {
    expect(problems({ ...goodEnv(), PRODUCTION_SUPABASE_PROJECT_REF: STAGING })).toContain(
      "identical",
    );
    expect(problems(goodEnv(), [])).toContain(`--project-ref ${STAGING}`);
    expect(problems(goodEnv(), ["--project-ref", PROD])).toContain(`--project-ref ${STAGING}`);
    expect(problems({ ...goodEnv(), STAGING_SUPABASE_PROJECT_REF: "someotherref12345" })).toContain(
      "not the declared staging project",
    );
  });

  it.each([
    "http://localhost:54321",
    "http://127.0.0.1:3100",
    "https://example.com",
    `http://${STAGING}.supabase.co`,
    `https://${STAGING}.supabase.co:8443`,
    `https://user:pw@${STAGING}.supabase.co`,
    "not a url",
  ])("refuses non-Supabase-cloud URL %s", (u) => {
    expect(problems({ ...goodEnv(), NEXT_PUBLIC_SUPABASE_URL: u })).toContain(
      "must be https://<project-ref>.supabase.co",
    );
  });

  it("cross-checks JWT-shaped keys against the URL and expected roles", () => {
    expect(
      problems({
        ...goodEnv(),
        SUPABASE_SERVICE_ROLE_KEY: jwt({ role: "service_role", ref: PROD }),
      }),
    ).toContain("different Supabase project");
    expect(
      problems({
        ...goodEnv(),
        NEXT_PUBLIC_SUPABASE_ANON_KEY: jwt({ role: "service_role", ref: STAGING }),
      }),
    ).toContain('"anon" role');
    expect(
      problems({ ...goodEnv(), SUPABASE_SERVICE_ROLE_KEY: jwt({ role: "anon", ref: STAGING }) }),
    ).toContain('"service_role" role');
  });

  it("accepts opaque (non-JWT) keys without inspecting them", () => {
    const env = {
      ...goodEnv(),
      SUPABASE_SERVICE_ROLE_KEY: "sb_secret_opaque_value_0000000000",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_opaque_000000000",
    };
    expect(evaluateSmokeGuard({ env, argv: argv() }).ok).toBe(true);
  });

  it("never echoes a key value in any refusal message", () => {
    const env: Record<string, string> = {
      ...goodEnv(),
      APP_ENV: "production",
      SUPABASE_SERVICE_ROLE_KEY: jwt({ role: "anon", ref: PROD }),
    };
    const out = problems(env);
    for (const secret of [env.SUPABASE_SERVICE_ROLE_KEY!, env.NEXT_PUBLIC_SUPABASE_ANON_KEY!])
      expect(out).not.toContain(secret);
  });

  it("parses refs, claims and flags defensively", () => {
    expect(projectRefFromUrl(`https://${STAGING}.supabase.co`)).toBe(STAGING);
    expect(projectRefFromUrl(undefined)).toBeNull();
    expect(unverifiedJwtClaims("not-a-jwt")).toBeNull();
    expect(unverifiedJwtClaims(`a.${Buffer.from("[1]").toString("base64url")}.c`)).toBeNull();
    expect(argValue(["--a", "1"], "a")).toBe("1");
    expect(argValue(["--a"], "a")).toBeUndefined();
  });

  it("builds recognisable run ids and test emails; only smoke emails pass the cleanup check", () => {
    const id = newRunId(new Date("2026-10-03T07:08:09Z"), "AbC-123xyz");
    expect(id).toBe("smoke-20261003070809-abc123");
    expect(smokeEmail(id, "a", "example.com")).toBe(
      "trademonk-smoke-smoke-20261003070809-abc123-a@example.com",
    );
    expect(isSmokeEmail(smokeEmail(id, "b", "example.com"))).toBe(true);
    for (const e of [
      "real.user@gmail.com",
      "",
      undefined,
      null,
      "trademonk-smoke-@",
      "x trademonk-smoke-a@b.c",
    ])
      expect(isSmokeEmail(e as string)).toBe(false);
  });
});

describe("staging smoke runner (static safety checks)", () => {
  const src = readFileSync(
    path.resolve(__dirname, "../scripts/staging-smoke-paper-trading.ts"),
    "utf8",
  );

  it("calls the guard before anything touches the network or the service-role client", () => {
    const guardAt = src.indexOf("evaluateSmokeGuard(");
    expect(guardAt).toBeGreaterThan(-1);
    expect(src.indexOf("createSupabaseAdminClient")).toBeGreaterThan(guardAt);
    expect(src.indexOf('import("../lib/supabase/admin")')).toBeGreaterThan(guardAt);
  });

  it("never deletes users or financial records and only disables users it created", () => {
    expect(src).not.toMatch(/deleteUser\s*\(/);
    expect(src).not.toMatch(/admin\s*\.from\([^)]*\)\s*\.delete\s*\(/);
    expect(src).toContain("ban_duration");
    expect(src).toContain("isSmokeEmail(");
  });

  it("contains no embedded credentials and never prints key variables", () => {
    expect(src).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    expect(src).not.toMatch(/sb_(secret|publishable)_[A-Za-z0-9]{8,}/);
    expect(src).not.toMatch(/console\.(log|error|warn)\([^)]*(SERVICE_ROLE|ANON_KEY|passwords)/);
  });

  it("uses clearly labelled test quotes, never live-money execution", () => {
    expect(src).toContain("isMock: true");
    expect(src).toContain("staging-smoke:");
    expect(src).toContain("NO REAL MONEY");
  });
});
