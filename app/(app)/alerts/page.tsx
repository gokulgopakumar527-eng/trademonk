import type { Metadata } from "next";
import { PhasePlaceholder } from "@/components/layout/phase-placeholder";

export const metadata: Metadata = { title: "Alerts" };

export default function Page() {
  return (
    <PhasePlaceholder
      title="Alerts"
      description="Get notified when your conditions are met."
      arrivesIn="Phase 7"
    />
  );
}
