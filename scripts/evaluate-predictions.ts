/**
 * Manual / development runner for the prediction evaluator. NOT an HTTP endpoint.
 *
 *   pnpm evaluate:predictions --project-ref <ref>                 # one run over due predictions
 *   pnpm evaluate:predictions --project-ref <ref> --limit 5
 *   pnpm evaluate:predictions --project-ref <ref> --id <prediction-uuid>
 *
 * It applies exactly the same rules as the scheduled route: a prediction is only evaluated once its
 * horizon has passed, the price and candles come from the market-data service, and nothing can be
 * overridden from the command line (there is no --price or --time option).
 *
 * SAFETY (same pattern as seed-assets): it writes with the service-role key, so it refuses to run
 * unless --project-ref matches NEXT_PUBLIC_SUPABASE_URL, and it runs only when APP_ENV is explicitly
 * `development` or `staging` (an unset or unrecognised value is refused, as is production).
 * Run through the package script: it enables the `react-server` condition that `server-only` needs.
 */
import { assertManualScriptAllowed } from "../lib/env";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL must be set (see .env.example)");
  assertManualScriptAllowed(process.env.APP_ENV, "evaluate:predictions");
  const ref = new URL(url).hostname.split(".")[0];
  if (arg("project-ref") !== ref) {
    throw new Error(`Pass --project-ref ${ref} to confirm you intend to write to this Supabase project.`);
  }

  const { evaluatePredictionById, runPredictionEvaluation } = await import("../services/predictions/evaluator-runtime");
  const id = arg("id");
  if (id) {
    const outcome = await evaluatePredictionById(id);
    console.log(JSON.stringify(outcome, null, 2));
    return;
  }
  const limit = arg("limit");
  const summary = await runPredictionEvaluation(limit === undefined ? {} : { limit });
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
