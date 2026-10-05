import Link from "next/link";
import { siteConfig } from "@/config/site";

export function Wordmark({ href = "/" }: { href?: string }) {
  return (
    <Link href={href} className="font-display text-xl font-semibold tracking-tight text-fg">
      {siteConfig.name}
    </Link>
  );
}
