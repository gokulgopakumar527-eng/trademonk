import Link from "next/link";
import { Bell, Menu, Search } from "lucide-react";
import { Wordmark } from "@/components/layout/wordmark";
import { Disclaimer } from "@/components/layout/disclaimer";
import { SidebarNav } from "@/components/layout/sidebar-nav";
import { signOutAction } from "@/features/auth/actions";
import { Button } from "@/components/ui/button";

interface Props {
  children: React.ReactNode;
  displayName: string;
  isAdmin: boolean;
}

export function AppShell({ children, displayName, isAdmin }: Props) {
  const initial = displayName.trim().charAt(0).toUpperCase() || "?";
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[15rem_1fr]">
      {/* Desktop rail */}
      <aside className="hidden border-r border-line bg-panel lg:flex lg:flex-col">
        <div className="px-5 py-5">
          <Wordmark href="/dashboard" />
        </div>
        <SidebarNav isAdmin={isAdmin} />
      </aside>

      <div className="flex min-h-dvh min-w-0 flex-col">
        <header className="flex items-center gap-3 border-b border-line px-4 py-3 lg:px-8">
          {/* Mobile nav: native <details>, no JS needed */}
          <details className="group relative lg:hidden">
            <summary
              aria-label="Open navigation"
              className="flex size-9 cursor-pointer list-none items-center justify-center rounded-[4px] border border-line"
            >
              <Menu className="size-4" />
            </summary>
            <div className="absolute left-0 top-11 z-20 w-64 rounded-panel border border-line bg-panel py-2 shadow-xl">
              <SidebarNav isAdmin={isAdmin} />
            </div>
          </details>
          <div className="lg:hidden">
            <Wordmark href="/dashboard" />
          </div>

          <form role="search" className="ml-auto hidden max-w-md flex-1 sm:block" action="/markets">
            <label htmlFor="global-search" className="sr-only">
              Search assets
            </label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted" />
              <input
                id="global-search"
                name="q"
                maxLength={40}
                autoComplete="off"
                placeholder="Search assets, e.g. BTC or NIFTY"
                className="h-9 w-full rounded-[4px] border border-line bg-ink pl-9 pr-3 text-sm placeholder:text-muted/70"
              />
            </div>
          </form>

          <div className="ml-auto flex items-center gap-2 sm:ml-0">
            <Button variant="ghost" size="sm" aria-label="Notifications (none yet)" disabled>
              <Bell className="size-4" />
            </Button>
            <details className="relative">
              <summary
                aria-label="Account menu"
                className="flex size-9 cursor-pointer list-none items-center justify-center rounded-full bg-raised text-sm font-semibold"
              >
                {initial}
              </summary>
              <div className="absolute right-0 top-11 z-20 w-48 rounded-panel border border-line bg-panel py-1 text-sm shadow-xl">
                <p className="truncate px-3 py-2 text-muted">{displayName}</p>
                <Link href="/settings" className="block px-3 py-2 hover:bg-raised">
                  Settings
                </Link>
                <form action={signOutAction}>
                  <button
                    type="submit"
                    className="block w-full px-3 py-2 text-left hover:bg-raised"
                  >
                    Sign out
                  </button>
                </form>
              </div>
            </details>
          </div>
        </header>

        <main className="flex-1 px-4 py-8 lg:px-8">{children}</main>

        <footer className="border-t border-line px-4 py-4 lg:px-8">
          <Disclaimer />
        </footer>
      </div>
    </div>
  );
}
