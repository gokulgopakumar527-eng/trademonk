import type { Metadata } from "next";
import { LegalDoc } from "@/components/layout/legal-doc";

export const metadata: Metadata = { title: "Terms of use" };

export default function TermsPage() {
  return (
    <LegalDoc title="Terms of use">
      <h2>Purpose of the service</h2>
      <p>
        TradeMonk AI provides market data, technical analysis and AI-assisted analysis for
        information and education. It does not provide personalised investment advice.
      </p>
      <h2>Your responsibility</h2>
      <p>
        Any decision to buy, sell or hold an asset is yours alone. Analysis shown in the service may
        be incomplete, delayed or wrong.
      </p>
      <h2>Paper trading and predictions</h2>
      <p>
        Paper trading uses simulated money. Predictions are records of views held at a point in time
        and are not offers or recommendations.
      </p>
      <h2>Registration status</h2>
      <p>
        [TO CONFIRM WITH COUNSEL: state the service&apos;s actual regulatory status. Do not describe
        it as registered with SEBI or any other regulator unless that registration exists.]
      </p>
    </LegalDoc>
  );
}
