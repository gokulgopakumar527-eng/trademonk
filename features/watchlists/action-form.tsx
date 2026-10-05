"use client";

import { useActionState } from "react";
import type { WatchlistFormState } from "./state";

type Action = (prev: WatchlistFormState, formData: FormData) => Promise<WatchlistFormState>;

/** Wraps a server action so success/error text is shown next to the control that caused it. */
export function ActionForm({
  action,
  children,
  className,
}: {
  action: Action;
  children: React.ReactNode;
  className?: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className={className} aria-busy={pending}>
      <fieldset disabled={pending} className="contents">
        {children}
      </fieldset>
      {state.error ? (
        <p role="alert" className="mt-1 text-xs text-loss">
          {state.error}
        </p>
      ) : state.message ? (
        <p role="status" className="mt-1 text-xs text-gain">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
