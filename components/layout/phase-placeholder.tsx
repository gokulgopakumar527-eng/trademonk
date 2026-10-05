import { PageHeader } from "@/components/layout/page-header";
import { DataStatus } from "@/components/layout/data-status";
import { siteConfig } from "@/config/site";

interface Props {
  title: string;
  description: string;
  arrivesIn: string;
  paper?: boolean;
}

/** Honest empty state for routes whose features land in later phases. */
export function PhasePlaceholder({ title, description, arrivesIn, paper }: Props) {
  return (
    <>
      <PageHeader title={title} description={description} />
      {paper ? (
        <p className="mb-6 inline-block rounded-[4px] border border-saffron/50 px-3 py-1 text-xs font-semibold text-saffron">
          {siteConfig.paperTradingLabel}
        </p>
      ) : null}
      <section className="max-w-2xl rounded-panel border border-dashed border-line p-6">
        <h2 className="font-medium">Not built yet</h2>
        <p className="mt-1 text-sm text-muted">
          This section is scheduled for {arrivesIn}. The route, navigation and access control are in
          place.
        </p>
        <div className="mt-4">
          <DataStatus />
        </div>
      </section>
    </>
  );
}
