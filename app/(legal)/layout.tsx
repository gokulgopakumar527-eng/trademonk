import Link from "next/link";
import { Wordmark } from "@/components/layout/wordmark";

export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto min-h-dvh max-w-2xl px-6 py-10">
      <Wordmark />
      <nav aria-label="Legal" className="mt-6 flex gap-5 text-sm text-muted">
        <Link href="/terms" className="hover:text-fg">
          Terms
        </Link>
        <Link href="/privacy" className="hover:text-fg">
          Privacy
        </Link>
        <Link href="/risk-disclosure" className="hover:text-fg">
          Risk disclosure
        </Link>
      </nav>
      <main className="py-10">{children}</main>
    </div>
  );
}
