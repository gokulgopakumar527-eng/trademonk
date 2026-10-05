import "server-only";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";

export interface AuditEntry {
  actorId?: string | null;
  action: string; // e.g. "auth.sign_in", "admin.role_change"
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}

/** Best-effort, append-only. A failure to audit is logged, never thrown into the user flow. */
export async function writeAuditLog(entry: AuditEntry): Promise<void> {
  const { error } = await createSupabaseAdminClient()
    .from("audit_logs")
    .insert({
      actor_id: entry.actorId ?? null,
      action: entry.action,
      entity_type: entry.entityType ?? null,
      entity_id: entry.entityId ?? null,
      metadata: entry.metadata ?? {},
    });
  if (error) logger.error("audit.write_failed", { action: entry.action, error });
}
