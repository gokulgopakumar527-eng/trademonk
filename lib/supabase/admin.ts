import "server-only";
import { createClient } from "@supabase/supabase-js";
import { getClientEnv } from "@/lib/env";
import { getServerEnv } from "@/lib/env.server";

/**
 * Service-role client. BYPASSES RLS. Use only in server code for jobs that a user
 * session must not perform (rate limiting, audit logs, evaluators, provider ingestion).
 * Never return its data to a user without checking authorization first.
 */
export function createSupabaseAdminClient() {
  return createClient(
    getClientEnv().NEXT_PUBLIC_SUPABASE_URL,
    getServerEnv().SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );
}
