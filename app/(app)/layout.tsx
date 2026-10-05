import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/app-shell";
import { getMyProfile } from "@/services/profiles/profile-service";

// Always render per-request: content depends on the signed-in user.
export const dynamic = "force-dynamic";

export default async function AuthenticatedLayout({ children }: { children: React.ReactNode }) {
  const me = await getMyProfile();
  if (!me) redirect("/login");
  return (
    <AppShell
      displayName={me.profile.name ?? me.email ?? "Account"}
      isAdmin={me.profile.role === "admin"}
    >
      {children}
    </AppShell>
  );
}
