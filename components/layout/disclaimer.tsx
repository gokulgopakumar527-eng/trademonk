import Link from "next/link";
import { siteConfig } from "@/config/site";

export function Disclaimer() {
  return (
    <p className="text-xs leading-relaxed text-muted">
      {siteConfig.disclaimer}{" "}
      <Link href="/risk-disclosure" className="underline underline-offset-2 hover:text-fg">
        Read the risk disclosure
      </Link>
      .
    </p>
  );
}
