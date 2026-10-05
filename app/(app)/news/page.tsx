import type { Metadata } from "next";
import { PhasePlaceholder } from "@/components/layout/phase-placeholder";

export const metadata: Metadata = { title: "News" };

export default function Page() {
  return (
    <PhasePlaceholder
      title="News"
      description="Market news linked to the assets you follow."
      arrivesIn="Phase 2 onward"
    />
  );
}
