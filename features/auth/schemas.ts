import { z } from "zod";

const email = z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address"));

export const signInSchema = z.object({
  email,
  password: z.string().min(1, "Enter your password"),
});

export const signUpSchema = z.object({
  name: z.string().trim().min(1, "Enter your name").max(80),
  email,
  password: z
    .string()
    .min(10, "Use at least 10 characters")
    .max(128, "Use at most 128 characters")
    .refine(
      (p) => /[a-zA-Z]/.test(p) && /\d/.test(p),
      "Include at least one letter and one number",
    ),
});

export const magicLinkSchema = z.object({ email });

export type AuthFormState = {
  error?: string;
  message?: string;
  fieldErrors?: Record<string, string>;
};
