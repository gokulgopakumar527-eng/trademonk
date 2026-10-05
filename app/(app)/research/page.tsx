import type { Metadata } from "next";
import { PhasePlaceholder } from "@/components/layout/phase-placeholder";

export const metadata: Metadata = { title: "AI Research" };

export default function Page() {
  return (
    <PhasePlaceholder
      title="AI Research"
      description="Ask questions and read AI-assisted analysis, clearly separated from observed data."
      arrivesIn="Phase 6"
    />
  );
}
