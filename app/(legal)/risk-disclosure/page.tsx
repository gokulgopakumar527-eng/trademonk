import type { Metadata } from "next";
import { LegalDoc } from "@/components/layout/legal-doc";

export const metadata: Metadata = { title: "Risk disclosure" };

export default function RiskDisclosurePage() {
  return (
    <LegalDoc title="Risk disclosure">
      <h2>You can lose money</h2>
      <p>
        Trading and investing in equities, derivatives and crypto assets involve substantial risk,
        including the loss of all capital. Past performance does not indicate future results.
      </p>
      <h2>Analysis is not a promise</h2>
      <p>
        Indicators, market-structure readings and AI-generated text describe possibilities.
        Confidence figures are not probabilities of profit. No outcome is assured.
      </p>
      <h2>Data limits</h2>
      <p>
        Market data can be delayed, incomplete or unavailable. Where data is unavailable, the
        service says so rather than showing a substitute.
      </p>
      <h2>Crypto and tax</h2>
      <p>
        [TO CONFIRM WITH COUNSEL: applicable Indian tax and compliance obligations for crypto
        assets.]
      </p>
    </LegalDoc>
  );
}
