/**
 * Only allow same-site relative paths after login, to prevent open redirects.
 * Rejects absolute URLs, protocol-relative URLs (//evil.com) and backslash tricks.
 */
export function sanitizeNextPath(
  input: string | null | undefined,
  fallback = "/dashboard",
): string {
  if (!input) return fallback;
  if (!input.startsWith("/")) return fallback;
  if (input.startsWith("//") || input.includes("\\")) return fallback;
  if (/[\u0000-\u001f]/.test(input)) return fallback;
  return input;
}
