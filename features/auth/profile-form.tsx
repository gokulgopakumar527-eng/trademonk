"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { updateProfileAction, type ProfileFormState } from "@/services/profiles/actions";
import { MARKETS, type Profile } from "@/types/domain";

const MARKET_LABELS = { CRYPTO: "Crypto", NSE: "NSE", BSE: "BSE" } as const;

export function ProfileForm({ profile }: { profile: Profile }) {
  const [state, action, pending] = useActionState<ProfileFormState, FormData>(
    updateProfileAction,
    {},
  );
  return (
    <form action={action} className="max-w-md space-y-5" noValidate>
      <Field
        label="Name"
        name="name"
        defaultValue={profile.name ?? ""}
        error={state.fieldErrors?.name}
        required
      />
      <Field
        label="Timezone"
        name="timezone"
        defaultValue={profile.timezone}
        error={state.fieldErrors?.timezone}
        required
      />
      <Field
        label="Preferred currency"
        name="preferred_currency"
        defaultValue={profile.preferred_currency}
        maxLength={3}
        error={state.fieldErrors?.preferred_currency}
        required
      />
      <fieldset>
        <legend className="mb-2 text-sm font-medium">Preferred markets</legend>
        <div className="flex gap-5">
          {MARKETS.map((m) => (
            <label key={m} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="preferred_markets"
                value={m}
                defaultChecked={profile.preferred_markets.includes(m)}
                className="size-4 accent-[#e3a23b]"
              />
              {MARKET_LABELS[m]}
            </label>
          ))}
        </div>
      </fieldset>
      {state.error ? (
        <p role="alert" className="text-sm text-loss">
          {state.error}
        </p>
      ) : null}
      {state.message ? (
        <p role="status" className="text-sm text-gain">
          {state.message}
        </p>
      ) : null}
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save changes"}
      </Button>
    </form>
  );
}
