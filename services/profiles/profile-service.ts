import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { AppError } from "@/lib/errors";
import type { Profile } from "@/types/domain";
import { profileUpdateSchema, type ProfileUpdate } from "./profile-schema";

/** Verified user (server round-trip to Auth) or null. */
export async function getCurrentUser() {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getUser();
  return data.user;
}

export async function requireUser() {
  const user = await getCurrentUser();
  if (!user) throw new AppError("UNAUTHENTICATED", "Sign in to continue");
  return user;
}

export async function getMyProfile(): Promise<{
  email: string | undefined;
  profile: Profile;
} | null> {
  const user = await getCurrentUser();
  if (!user) return null;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("profiles")
    .select("id, name, avatar_url, timezone, preferred_currency, preferred_markets, role")
    .eq("id", user.id)
    .single();
  if (error || !data) return null;
  return { email: user.email, profile: data as Profile };
}

/** Updates only the columns users may change; RLS + column grants enforce the same in the DB. */
export async function updateMyProfile(input: ProfileUpdate): Promise<void> {
  const user = await requireUser();
  const values = profileUpdateSchema.parse(input);
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("profiles").update(values).eq("id", user.id);
  if (error) throw new AppError("INTERNAL", "Could not save your profile", error);
}

export async function requireAdmin() {
  const me = await getMyProfile();
  if (!me) throw new AppError("UNAUTHENTICATED", "Sign in to continue");
  if (me.profile.role !== "admin") throw new AppError("FORBIDDEN", "Admin access required");
  return me;
}
