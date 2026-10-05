/**
 * Seeds the `assets` table (idempotent upsert on market+symbol).
 *
 * SAFETY: this writes with the service-role key. It refuses to run unless you pass the exact
 * Supabase project ref you intend to modify, and that ref must match NEXT_PUBLIC_SUPABASE_URL:
 *
 *   pnpm seed:assets --project-ref <ref>
 *
 * It first lists existing assets and stops if the table already holds rows that are not in the seed
 * list (a sign you may be pointing at the wrong project) unless --allow-extra is given.
 */
import { createClient } from "@supabase/supabase-js";
import { SEED_ASSETS } from "../config/assets";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");

  const ref = new URL(url).hostname.split(".")[0];
  const confirmed = arg("project-ref");
  if (!confirmed || confirmed !== ref) {
    throw new Error(
      `Refusing to run: pass --project-ref ${ref} to confirm you intend to modify project "${ref}".`,
    );
  }

  const db = createClient(url, key, { auth: { persistSession: false } });
  const { data: existing, error: listErr } = await db.from("assets").select("market, symbol");
  if (listErr) throw new Error(`Cannot read assets table (are migrations applied?): ${listErr.message}`);

  const seedKeys = new Set(SEED_ASSETS.map((a) => `${a.market}:${a.symbol}`));
  const extras = (existing ?? []).filter((r) => !seedKeys.has(`${r.market}:${r.symbol}`));
  if (extras.length > 0 && !process.argv.includes("--allow-extra")) {
    throw new Error(
      `assets already contains ${extras.length} row(s) outside the seed list. Verify the project, or pass --allow-extra.`,
    );
  }

  const rows = SEED_ASSETS.map((a) => ({
    market: a.market,
    symbol: a.symbol,
    name: a.name,
    asset_type: a.kind,
    currency: a.currency,
    is_active: true,
  }));
  const { error } = await db.from("assets").upsert(rows, { onConflict: "market,symbol" });
  if (error) throw new Error(`Seed failed: ${error.message}`);
  console.log(`Seeded ${rows.length} assets into project ${ref}.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
