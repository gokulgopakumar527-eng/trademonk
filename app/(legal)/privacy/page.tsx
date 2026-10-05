import type { Metadata } from "next";
import { LegalDoc } from "@/components/layout/legal-doc";

export const metadata: Metadata = { title: "Privacy policy" };

export default function PrivacyPage() {
  return (
    <LegalDoc title="Privacy policy">
      <h2>What we collect</h2>
      <p>
        Account details (name, email), your preferences, and the watchlists, predictions, alerts and
        paper trades you create.
      </p>
      <h2>How we use it</h2>
      <p>
        To run the service, secure accounts and send the notifications you request. [TO CONFIRM WITH
        COUNSEL: legal bases, retention, processors, cross-border transfers, and rights under
        applicable Indian data-protection law.]
      </p>
      <h2>Prediction records</h2>
      <p>
        Predictions are kept as permanent, timestamped records so that performance can be audited.
        [TO CONFIRM WITH COUNSEL: how this interacts with account-deletion requests.]
      </p>
    </LegalDoc>
  );
}
