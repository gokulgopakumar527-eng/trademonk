import type { Metadata } from "next";
import Link from "next/link";
import { LegalDoc } from "@/components/layout/legal-doc";

export const metadata: Metadata = { title: "Legal" };

export default function LegalIndex() {
  return (
    <LegalDoc title="Legal">
      <ul className="list-disc space-y-2 pl-5">
        <li>
          <Link href="/terms" className="underline">
            Terms of use
          </Link>
        </li>
        <li>
          <Link href="/privacy" className="underline">
            Privacy policy
          </Link>
        </li>
        <li>
          <Link href="/risk-disclosure" className="underline">
            Risk disclosure
          </Link>
        </li>
      </ul>
    </LegalDoc>
  );
}
