import type { AssetRef } from "@/types/market";

/** A persisted asset (has a DB id) plus display name. */
export interface Asset extends AssetRef {
  id: string;
  name: string;
}
