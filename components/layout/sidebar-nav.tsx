"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { primaryNav } from "@/config/nav";
import { cn } from "@/lib/utils";

export function SidebarNav({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname();
  const items = [
    ...primaryNav,
    ...(isAdmin ? [{ label: "Admin", href: "/admin", icon: ShieldCheck }] : []),
  ];
  return (
    <nav aria-label="Primary" className="px-2 pb-4">
      <ul className="space-y-0.5">
        {items.map(({ label, href, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-3 rounded-[4px] border-l-2 px-3 py-2 text-sm",
                  active
                    ? "border-saffron bg-raised font-medium text-fg"
                    : "border-transparent text-muted hover:bg-raised/60 hover:text-fg",
                )}
              >
                <Icon className="size-4" aria-hidden />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
