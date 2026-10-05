"use server";

import { revalidatePath } from "next/cache";
import { profileUpdateSchema } from "./profile-schema";
import { updateMyProfile } from "./profile-service";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";

export type ProfileFormState = {
  error?: string;
  message?: string;
  fieldErrors?: Record<string, string>;
};

export async function updateProfileAction(
  _: ProfileFormState,
  formData: FormData,
): Promise<ProfileFormState> {
  const parsed = profileUpdateSchema.safeParse({
    name: formData.get("name"),
    timezone: formData.get("timezone"),
    preferred_currency: String(formData.get("preferred_currency") ?? "").toUpperCase(),
    preferred_markets: formData.getAll("preferred_markets"),
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const i of parsed.error.issues) fieldErrors[String(i.path[0])] ??= i.message;
    return { fieldErrors };
  }
  try {
    await updateMyProfile(parsed.data);
  } catch (err) {
    if (err instanceof AppError && err.code === "UNAUTHENTICATED")
      return { error: "Your session has expired. Sign in again." };
    logger.error("profile.update_failed", { error: err });
    return { error: "We couldn't save your changes. Try again." };
  }
  revalidatePath("/settings");
  return { message: "Saved." };
}
