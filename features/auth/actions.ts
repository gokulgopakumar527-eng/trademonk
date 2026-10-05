"use server";

import { redirect } from "next/navigation";
import type { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getClientEnv } from "@/lib/env";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { sanitizeNextPath } from "@/lib/safe-redirect";
import { logger } from "@/lib/logger";
import { writeAuditLog } from "@/services/audit/audit-service";
import { magicLinkSchema, signInSchema, signUpSchema, type AuthFormState } from "./schemas";

const TOO_MANY = "Too many attempts. Wait a few minutes and try again.";

function fieldErrorsFrom(error: z.ZodError): AuthFormState {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    fieldErrors[key] ??= issue.message;
  }
  return { fieldErrors };
}

const callbackUrl = (next?: string) => {
  const url = new URL("/auth/callback", getClientEnv().NEXT_PUBLIC_APP_URL);
  if (next) url.searchParams.set("next", sanitizeNextPath(next));
  return url.toString();
};

export async function signInWithPasswordAction(
  _: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const parsed = signInSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return fieldErrorsFrom(parsed.error);
  if (!(await checkRateLimit(RATE_LIMITS.signIn))) return { error: TOO_MANY };

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error || !data.user) {
    logger.warn("auth.sign_in_failed", { reason: error?.code });
    // Same message for wrong password and unknown email: no account enumeration.
    return { error: "Email or password is incorrect." };
  }
  await writeAuditLog({ actorId: data.user.id, action: "auth.sign_in" });
  redirect(sanitizeNextPath(String(formData.get("next") ?? "")));
}

export async function signUpAction(_: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const parsed = signUpSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return fieldErrorsFrom(parsed.error);
  if (!(await checkRateLimit(RATE_LIMITS.signUp))) return { error: TOO_MANY };

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: { data: { name: parsed.data.name }, emailRedirectTo: callbackUrl() },
  });
  if (error) {
    logger.warn("auth.sign_up_failed", { reason: error.code });
    return { error: "We couldn't create that account. Check your details and try again." };
  }
  if (data.user) await writeAuditLog({ actorId: data.user.id, action: "auth.sign_up" });
  // With email confirmation on, no session exists yet.
  if (!data.session) return { message: "Check your inbox to confirm your email, then sign in." };
  redirect("/dashboard");
}

export async function sendMagicLinkAction(
  _: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const parsed = magicLinkSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return fieldErrorsFrom(parsed.error);
  if (!(await checkRateLimit(RATE_LIMITS.magicLink))) return { error: TOO_MANY };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: parsed.data.email,
    options: { emailRedirectTo: callbackUrl(String(formData.get("next") ?? "")) },
  });
  if (error) {
    logger.warn("auth.magic_link_failed", { reason: error.code });
    return { error: "We couldn't send a sign-in link. Try again in a few minutes." };
  }
  return { message: "If that email can sign in, a link is on its way." };
}

export async function signOutAction(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect("/login");
}
