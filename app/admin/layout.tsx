import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/app-shell";
import { getMyProfile } from "@/services/profiles/profile-service";

export const dynamic = "force-dynamic";

/** Second line of defence: middleware already gates /admin; the role is re-checked here. */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const me = await getMyProfile();
  if (!me) redirect("/login?next=/admin");
  if (me.profile.role !== "admin") redirect("/dashboard");
  return (
    <AppShell displayName={me.profile.name ?? me.email ?? "Admin"} isAdmin>
      {children}
    </AppShell>
  );
}
