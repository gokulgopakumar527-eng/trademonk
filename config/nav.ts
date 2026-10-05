import {
  Bell,
  BookOpenCheck,
  Bot,
  LayoutDashboard,
  LineChart,
  ListChecks,
  Newspaper,
  NotebookPen,
  Settings,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
}

/** Primary navigation, in the order defined by the product spec. */
export const primaryNav: readonly NavItem[] = [
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { label: "Markets", href: "/markets", icon: LineChart },
  { label: "Watchlists", href: "/watchlists", icon: ListChecks },
  { label: "Predictions", href: "/predictions", icon: BookOpenCheck },
  { label: "Paper Trading", href: "/paper-trading", icon: NotebookPen },
  { label: "AI Research", href: "/research", icon: Bot },
  { label: "Alerts", href: "/alerts", icon: Bell },
  { label: "News", href: "/news", icon: Newspaper },
  { label: "Settings", href: "/settings", icon: Settings },
];
