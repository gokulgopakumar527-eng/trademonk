import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/layout/page-header";
import { ProfileForm } from "@/features/auth/profile-form";
import { getMyProfile } from "@/services/profiles/profile-service";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const me = await getMyProfile();
  if (!me) redirect("/login");
  return (
    <>
      <PageHeader title="Settings" description="Your profile and preferences." />
      <p className="mb-6 text-sm text-muted">
        Signed in as <span className="text-fg">{me.email}</span>
      </p>
      <ProfileForm profile={me.profile} />
    </>
  );
}
