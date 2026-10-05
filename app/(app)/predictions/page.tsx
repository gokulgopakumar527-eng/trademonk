import type { Metadata } from "next";
import { PhasePlaceholder } from "@/components/layout/phase-placeholder";

export const metadata: Metadata = { title: "Predictions" };

export default function Page() {
  return (
    <PhasePlaceholder
      title="Predictions"
      description="Timestamped, immutable prediction records and their outcomes."
      arrivesIn="Phase 5"
    />
  );
}
