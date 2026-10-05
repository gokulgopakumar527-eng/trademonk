import { createBrowserClient } from "@supabase/ssr";
import { getClientEnv } from "@/lib/env";

/** Browser client: anon key only, RLS always applies. */
export function createSupabaseBrowserClient() {
  const env = getClientEnv();
  return createBrowserClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}
