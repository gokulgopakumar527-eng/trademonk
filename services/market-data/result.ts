import type { Capability, ProviderError, ProviderErrorCode, Result } from "@/types/market";

export const ok = <T>(data: T): Result<T> => ({ ok: true, data });

export function fail<T = never>(
  provider: string,
  code: ProviderErrorCode,
  message: string,
  extra: Partial<Pick<ProviderError, "retryable" | "retryAfterMs">> = {},
): Result<T> {
  const retryable =
    extra.retryable ?? (code === "RATE_LIMITED" || code === "TIMEOUT" || code === "UPSTREAM_ERROR");
  return {
    ok: false,
    error: { code, message, provider, retryable, ...(extra.retryAfterMs ? { retryAfterMs: extra.retryAfterMs } : {}) },
  };
}

export const unsupported = <T = never>(provider: string, capability: Capability): Result<T> =>
  fail<T>(provider, "UNSUPPORTED", `${provider} does not support ${capability}`, { retryable: false });

export const notConfigured = <T = never>(provider: string, what: string): Result<T> =>
  fail<T>(provider, "NOT_CONFIGURED", what, { retryable: false });

/** Copy shown to users when a Result is an error: never a placeholder number. */
export function userMessageFor(error: ProviderError): string {
  switch (error.code) {
    case "UNSUPPORTED":
    case "NOT_CONFIGURED":
    case "NOT_FOUND":
      return "Data unavailable";
    case "RATE_LIMITED":
      return "Data temporarily unavailable (provider rate limit)";
    case "GEO_RESTRICTED":
      return "Data unavailable (provider blocked this server region)";
    default:
      return "Data temporarily unavailable";
  }
}
