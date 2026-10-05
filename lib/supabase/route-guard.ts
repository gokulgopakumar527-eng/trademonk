/** Pure route classification, shared by middleware and tests. */
const PROTECTED_PREFIXES = [
  "/dashboard",
  "/markets",
  "/watchlists",
  "/predictions",
  "/paper-trading",
  "/research",
  "/alerts",
  "/news",
  "/settings",
  "/admin",
] as const;

const AUTH_PAGES = ["/login", "/signup"] as const;

const matches = (pathname: string, prefix: string) =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);

export function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((p) => matches(pathname, p));
}

export function isAdminPath(pathname: string): boolean {
  return matches(pathname, "/admin");
}

export function isAuthPage(pathname: string): boolean {
  return AUTH_PAGES.some((p) => matches(pathname, p));
}
