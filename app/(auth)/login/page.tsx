import type { Metadata } from "next";
import Link from "next/link";
import { MagicLinkForm, SignInForm } from "@/features/auth/auth-forms";
import { sanitizeNextPath } from "@/lib/safe-redirect";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  const safeNext = next ? sanitizeNextPath(next) : undefined;
  return (
    <>
      <h1 className="font-display text-3xl font-medium">Sign in</h1>
      {error === "link" ? (
        <p role="alert" className="mt-4 text-sm text-loss">
          That sign-in link is invalid or has expired. Request a new one below.
        </p>
      ) : null}
      <div className="mt-8">
        <SignInForm next={safeNext} />
      </div>
      <div className="my-8 border-t border-line" />
      <h2 className="mb-4 font-medium">Prefer a link?</h2>
      <MagicLinkForm next={safeNext} />
      <p className="mt-8 text-sm text-muted">
        New here?{" "}
        <Link href="/signup" className="text-saffron underline underline-offset-2">
          Create an account
        </Link>
      </p>
    </>
  );
}
