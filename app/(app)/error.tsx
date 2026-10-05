"use client";

import { Button } from "@/components/ui/button";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div role="alert" className="max-w-lg rounded-panel border border-loss/50 p-6">
      <h1 className="font-medium">This page could not be loaded</h1>
      <p className="mt-1 text-sm text-muted">
        Something failed while preparing it. No values are shown rather than guessed ones.
        {error.digest ? ` Reference: ${error.digest}.` : ""}
      </p>
      <Button onClick={reset} variant="outline" size="sm" className="mt-4">
        Try again
      </Button>
    </div>
  );
}
