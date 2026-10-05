/**
 * Safety guard for the paper-trading STAGING smoke test (Phase 5C-7B). Pure: no I/O, no clock, no
 * network. It decides whether the script may run and in which mode, and it never returns or echoes
 * a secret VALUE: messages name variables, fixed literals and the (public) project ref only.
 *
 * Modes
 *   dry-run : read-only preflight. Allowed as soon as the target is proven to be the declared staging project.
 *   write   : creates disposable test users and simulated paper trades. Needs the explicit
 *             `--confirm-writes WRITE-TO-STAGING:<ref>` flag on top of every dry-run requirement.
 *
 * Supabase projects do not describe their own environment, so "this is staging" is an operator
 * declaration that must be internally consistent: the URL, STAGING_SUPABASE_PROJECT_REF and
 * --project-ref must all agree, PRODUCTION_SUPABASE_PROJECT_REF must be declared and DIFFERENT, and
 * (when the keys are JWT-shaped) their embedded `ref` claim must match the URL.
 */

export const CONFIRM_PREFIX = "WRITE-TO-STAGING:";
const REF_PATTERN = /^[a-z0-9-]{8,40}$/;

export type SmokeMode = "dry-run" | "write";

export interface SmokeTarget {
  projectRef: string;
  mode: SmokeMode;
}

export type SmokeGuardResult =
  { ok: true; target: SmokeTarget } | { ok: false; problems: string[] };

/** `https://<ref>.supabase.co` -> `<ref>`; null for anything else (self-hosted, local, http, a path, creds). */
export function projectRefFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
  const m = /^([a-z0-9-]+)\.supabase\.co$/.exec(u.hostname);
  if (!m || !m[1] || !REF_PATTERN.test(m[1])) return null;
  return m[1];
}

/** Claims of a JWT-shaped key WITHOUT verifying it (we only cross-check identity). Null if not a JWT. */
export function unverifiedJwtClaims(token: string | undefined): Record<string, unknown> | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1]!, "base64url").toString("utf8");
    const claims: unknown = JSON.parse(json);
    return claims && typeof claims === "object" && !Array.isArray(claims)
      ? (claims as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function argValue(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

const REQUIRED_VARS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "STAGING_SUPABASE_PROJECT_REF",
  "PRODUCTION_SUPABASE_PROJECT_REF",
] as const;

export function evaluateSmokeGuard(input: {
  env: Readonly<Record<string, string | undefined>>;
  argv: readonly string[];
}): SmokeGuardResult {
  const { env, argv } = input;
  const problems: string[] = [];

  // Allow-list, written as a switch so only the exact literal passes (unset, "Staging", "production" all fall through).
  switch (env.APP_ENV) {
    case "staging":
      break;
    default:
      problems.push('APP_ENV must be exactly "staging" (it is unset or a different value).');
  }
  if (env.VERCEL_ENV === "production") {
    problems.push(
      "VERCEL_ENV=production: this script must never run against a production deployment.",
    );
  }
  for (const name of REQUIRED_VARS) {
    if (!env[name]) problems.push(`${name} is not set.`);
  }

  const urlRef = projectRefFromUrl(env.NEXT_PUBLIC_SUPABASE_URL);
  if (env.NEXT_PUBLIC_SUPABASE_URL && !urlRef) {
    problems.push(
      "NEXT_PUBLIC_SUPABASE_URL must be https://<project-ref>.supabase.co (self-hosted, local and malformed URLs are refused).",
    );
  }

  const declaredStaging = env.STAGING_SUPABASE_PROJECT_REF;
  const declaredProd = env.PRODUCTION_SUPABASE_PROJECT_REF;
  const flagRef = argValue(argv, "project-ref");

  if (declaredStaging && !REF_PATTERN.test(declaredStaging))
    problems.push("STAGING_SUPABASE_PROJECT_REF is not a valid project ref.");
  if (declaredProd && !REF_PATTERN.test(declaredProd))
    problems.push("PRODUCTION_SUPABASE_PROJECT_REF is not a valid project ref.");
  if (declaredStaging && declaredProd && declaredStaging === declaredProd) {
    problems.push(
      "STAGING_SUPABASE_PROJECT_REF and PRODUCTION_SUPABASE_PROJECT_REF are identical.",
    );
  }
  if (urlRef) {
    if (declaredStaging && urlRef !== declaredStaging) {
      problems.push(
        `NEXT_PUBLIC_SUPABASE_URL points at project "${urlRef}", which is not the declared staging project.`,
      );
    }
    if (declaredProd && urlRef === declaredProd) {
      problems.push(
        `NEXT_PUBLIC_SUPABASE_URL points at the declared PRODUCTION project "${urlRef}". Refusing.`,
      );
    }
    if (flagRef !== urlRef) {
      problems.push(`Pass --project-ref ${urlRef} to confirm the project you intend to test.`);
    }

    // Cross-check JWT-shaped keys: a production key paired with a staging URL (or vice versa) is refused.
    for (const [name, expectedRole] of [
      ["SUPABASE_SERVICE_ROLE_KEY", "service_role"],
      ["NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon"],
    ] as const) {
      const claims = unverifiedJwtClaims(env[name]);
      if (!claims) continue; // new-format keys are opaque; nothing to cross-check
      if (typeof claims.ref === "string" && claims.ref !== urlRef) {
        problems.push(
          `${name} belongs to a different Supabase project than NEXT_PUBLIC_SUPABASE_URL.`,
        );
      }
      if (typeof claims.role === "string" && claims.role !== expectedRole) {
        problems.push(
          `${name} does not carry the "${expectedRole}" role (wrong key in the wrong variable?).`,
        );
      }
    }
  }

  if (problems.length > 0) return { ok: false, problems };
  const projectRef = urlRef!;
  // Presence of the flag, not just a value: a bare or mistyped `--confirm-writes` is refused, never read as "no flag".
  if (argv.includes("--confirm-writes")) {
    if (argValue(argv, "confirm-writes") !== `${CONFIRM_PREFIX}${projectRef}`) {
      return {
        ok: false,
        problems: [`--confirm-writes must be exactly ${CONFIRM_PREFIX}${projectRef}`],
      };
    }
    return { ok: true, target: { projectRef, mode: "write" } };
  }
  return { ok: true, target: { projectRef, mode: "dry-run" } };
}

/** Run identity. Embedded in every test email and every artifact so test data is recognisable. */
export function newRunId(now: Date, random: string): string {
  const stamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `smoke-${stamp}-${random
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase()
    .slice(0, 6)
    .padEnd(6, "0")}`;
}

export const SMOKE_EMAIL_PREFIX = "trademonk-smoke-";

export function smokeEmail(runId: string, who: "a" | "b", domain: string): string {
  return `${SMOKE_EMAIL_PREFIX}${runId}-${who}@${domain}`;
}

/** Only accounts this tooling created may ever be touched by its cleanup. */
export function isSmokeEmail(email: string | undefined | null): boolean {
  return (
    typeof email === "string" &&
    email.startsWith(SMOKE_EMAIL_PREFIX) &&
    /^[^@\s]+@[^@\s]+$/.test(email)
  );
}
