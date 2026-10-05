import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";

export const metadata: Metadata = { title: "Admin" };

const areas = [
  "Users",
  "Market providers",
  "System health",
  "AI usage",
  "API usage",
  "Predictions",
  "Alerts",
  "Subscriptions",
  "Errors",
  "Audit logs",
];

export default function AdminPage() {
  return (
    <>
      <PageHeader
        title="Admin"
        description="Administrator area. Access is limited to accounts with the admin role, enforced in middleware, the layout and the database."
      />
      <ul className="max-w-2xl divide-y divide-line rounded-panel border border-line">
        {areas.map((a) => (
          <li key={a} className="flex items-center justify-between px-4 py-3 text-sm">
            <span>{a}</span>
            <span className="text-muted">Not built yet</span>
          </li>
        ))}
      </ul>
    </>
  );
}
