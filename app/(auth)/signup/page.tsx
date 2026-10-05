import type { Metadata } from "next";
import Link from "next/link";
import { SignUpForm } from "@/features/auth/auth-forms";

export const metadata: Metadata = { title: "Create account" };

export default function SignUpPage() {
  return (
    <>
      <h1 className="font-display text-3xl font-medium">Create your account</h1>
      <p className="mt-2 text-muted">Free to start. No trading, no real money.</p>
      <div className="mt-8">
        <SignUpForm />
      </div>
      <p className="mt-8 text-sm text-muted">
        Already have an account?{" "}
        <Link href="/login" className="text-saffron underline underline-offset-2">
          Sign in
        </Link>
      </p>
    </>
  );
}
