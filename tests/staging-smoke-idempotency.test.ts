import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatCheckLine,
  formatTally,
  isLegacySignatureGone,
  leaksRawDatabaseText,
  smokeIdempotencyKey,
  tally,
} from "../scripts/lib/staging-smoke-idempotency";
import { PaperTradeRejectedError } from "@/services/paper-trading/errors";
import { createPaperTradingService } from "@/services/paper-trading/paper-trading-service";
import { IDEMPOTENCY_KEY_PATTERN, idempotencyKeySchema } from "@/services/paper-trading/schemas";
import {
  ALICE,
  BTC,
  BTC_ID,
  KEY,
  fakeStore,
  freshView,
  makeDeps,
  quote,
} from "./paper-trading/open-helpers";
import type { Asset } from "@/services/market-data/types";

const SCRIPT = readFileSync(
  path.join(__dirname, "..", "scripts", "staging-smoke-paper-trading.ts"),
  "utf8",
);

describe("smokeIdempotencyKey", () => {
  it("always satisfies the application schema and the database format (16-128 chars of A-Za-z0-9._-)", () => {
    for (const label of ["c2", "i5r3", "", "with spaces & symbols!!", "x".repeat(80)]) {
      const key = smokeIdempotencyKey(label);
      expect(key.length).toBeGreaterThanOrEqual(16);
      expect(key.length).toBeLessThanOrEqual(128);
      expect(IDEMPOTENCY_KEY_PATTERN.test(key)).toBe(true);
      expect(idempotencyKeySchema.safeParse(key).success).toBe(true);
      expect(key.startsWith("smoke-")).toBe(true);
    }
  });

  it("is unique per call (a new trade intent never collides with an old key)", () => {
    const keys = new Set(Array.from({ length: 200 }, () => smokeIdempotencyKey("i4")));
    expect(keys.size).toBe(200);
  });

  it("keeps a supplied random part verbatim (deterministic when asked)", () => {
    expect(smokeIdempotencyKey("a b", "0123456789abcdef")).toBe("smoke-ab-0123456789abcdef");
  });
});

describe("check tally and report format", () => {
  it("counts only checks that actually produced an outcome; an un-run check is never a pass", () => {
    expect(tally([])).toEqual({ passed: 0, failed: 0, blocked: 0 });
    expect(
      tally([
        { outcome: "PASS" },
        { outcome: "PASS" },
        { outcome: "FAIL" },
        { outcome: "BLOCKED" },
      ]),
    ).toEqual({ passed: 2, failed: 1, blocked: 1 });
  });

  it("prints the required Passed/Failed/Blocked footer", () => {
    expect(formatTally({ passed: 20, failed: 1, blocked: 2 })).toBe(
      "Passed: 20\nFailed: 1\nBlocked: 2",
    );
  });

  it("prefixes every line with [PASS] / [FAIL] / [BLOCKED]", () => {
    expect(formatCheckLine({ id: "I2", name: "same-key replay", outcome: "PASS" })).toBe(
      "[PASS] I2  same-key replay",
    );
    expect(formatCheckLine({ id: "I5", name: "x", outcome: "FAIL", detail: "why" })).toBe(
      "[FAIL] I5  x\n         why",
    );
    expect(
      formatCheckLine({ id: "I0", name: "y", outcome: "BLOCKED" }).startsWith("[BLOCKED] I0"),
    ).toBe(true);
  });
});

describe("leaksRawDatabaseText", () => {
  it.each([
    "PAPER_IDEMPOTENCY_KEY_REUSED: this key was already used for a different trade",
    'duplicate key value violates unique constraint "paper_trades_user_idempotency_key_uidx"',
    "PGRST202 Could not find the function public.open_paper_trade",
    "new row for relation paper_trades violates check constraint",
    "SQLSTATE 23505",
    "postgres error",
    "column idempotency_key does not exist",
  ])("flags database internals: %s", (m) => {
    expect(leaksRawDatabaseText(m)).toBe(true);
  });

  it.each([
    "Not enough paper cash for this trade (including simulated fees). No trade was opened.",
    "That quantity is not valid for this asset. No trade was opened.",
  ])("does not flag ordinary user-facing text: %s", (m) => {
    expect(leaksRawDatabaseText(m)).toBe(false);
  });

  it("the REAL application conflict message is free of database internals", async () => {
    const { deps } = makeDeps();
    const service = createPaperTradingService(deps);
    const input = { assetId: BTC_ID, side: "BUY", quantity: "0.01", idempotencyKey: KEY };
    await service.openTrade(ALICE, input);
    const error = await service.openTrade(ALICE, { ...input, quantity: "0.02" }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(PaperTradeRejectedError);
    const rejected = error as PaperTradeRejectedError;
    expect(rejected.reason).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(rejected.code).toBe("VALIDATION");
    expect(leaksRawDatabaseText(rejected.message)).toBe(false);
  });
});

describe("every conflict kind the smoke test probes maps to the safe application error", () => {
  const ETH: Asset = {
    id: "dddddddd-0000-4000-8000-0000000000e1",
    market: "CRYPTO",
    symbol: "ETH",
    currency: "USDT",
    kind: "CRYPTO",
    name: "Ethereum",
  };
  const base = { assetId: BTC_ID, side: "BUY", quantity: "0.01", idempotencyKey: KEY };

  it.each([
    ["different asset", { assetId: ETH.id }],
    ["different side", { side: "LONG" }],
    ["different quantity", { quantity: "0.02" }],
  ])("%s", async (_label, over) => {
    const fs = fakeStore([BTC, ETH]);
    const { deps } = makeDeps({
      store: fs.store,
      marketData: {
        getQuote: async (asset) =>
          freshView(quote({ symbol: asset.symbol, price: asset.symbol === "ETH" ? 3000 : 60000 })),
      },
    });
    const snapshotAccounts = (): string =>
      JSON.stringify([...fs.state.accounts], (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    const service = createPaperTradingService(deps);
    await service.openTrade(ALICE, base);
    const before = snapshotAccounts();
    const error = await service.openTrade(ALICE, { ...base, ...over }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(PaperTradeRejectedError);
    expect((error as PaperTradeRejectedError).reason).toBe("IDEMPOTENCY_KEY_REUSED");
    expect((error as PaperTradeRejectedError).code).toBe("VALIDATION");
    expect(leaksRawDatabaseText((error as PaperTradeRejectedError).message)).toBe(false);
    expect(fs.state.trades).toHaveLength(1);
    expect(snapshotAccounts()).toBe(before);
  });
});

describe("isLegacySignatureGone (migration 9 removed the key-less open_paper_trade)", () => {
  it("accepts PostgREST's unknown-function error", () => {
    expect(isLegacySignatureGone({ code: "PGRST202", message: "x" })).toBe(true);
    expect(
      isLegacySignatureGone({
        message:
          "Could not find the function public.open_paper_trade(p_user_id) in the schema cache",
      }),
    ).toBe(true);
  });

  it("rejects success and errors raised from inside a surviving function body", () => {
    expect(isLegacySignatureGone(null)).toBe(false);
    expect(isLegacySignatureGone(undefined)).toBe(false);
    expect(
      isLegacySignatureGone({ message: "PAPER_INVALID_INPUT: side SELL is not supported" }),
    ).toBe(false);
    expect(isLegacySignatureGone({ code: "42501", message: "permission denied" })).toBe(false);
  });
});

describe("staging smoke script: static safety properties", () => {
  const at = (needle: string): number => {
    const i = SCRIPT.indexOf(needle);
    expect(i, `missing: ${needle}`).toBeGreaterThanOrEqual(0);
    return i;
  };

  it("keeps the guard first: no client is created before evaluateSmokeGuard", () => {
    expect(at("evaluateSmokeGuard(")).toBeLessThan(at("createSupabaseAdminClient()"));
    expect(at("evaluateSmokeGuard(")).toBeLessThan(at("createClient(url, anonKey"));
  });

  it("runs every write/lifecycle check only AFTER the dry-run early return", () => {
    const dryRunReturn = at('if (mode === "dry-run")');
    expect(dryRunReturn).toBeLessThan(at("createPaperTradingService({"));
    expect(dryRunReturn).toBeLessThan(at("allowMockData: true"));
    expect(dryRunReturn).toBeLessThan(at("admin.auth.admin.createUser"));
  });

  it("probes the 16-argument RPC with a key, and only the dedicated P4 probe omits it", () => {
    expect(SCRIPT).toContain('p_idempotency_key: smokeIdempotencyKey("probe")'); // P3
    expect(SCRIPT).toContain("p_idempotency_key: ctx.privKey"); // C8 (a fresh key, so a hole would create a trade)
    const p4 = SCRIPT.slice(at('"P4"'), at('if (mode === "dry-run")'));
    expect(p4).not.toContain("p_idempotency_key");
    expect(p4).toContain("isLegacySignatureGone");
  });

  it("never builds an idempotency key by hand and never re-uses C2's key for a second open", () => {
    expect(SCRIPT).not.toMatch(/idempotencyKey:\s*`/);
    expect(SCRIPT).not.toMatch(/idempotencyKey:\s*(?:crypto\.)?randomUUID/);
    const c14 = SCRIPT.slice(at('"C14"'), at('"C15"'));
    expect(c14).toMatch(
      /\.\.\.need\(ctx\.openParams[^)]*\)[\s\S]{0,80}idempotencyKey:\s*smokeIdempotencyKey\(/,
    );
  });

  it("defines every lifecycle check exactly once", () => {
    const ids = [...SCRIPT.matchAll(/check\(\s*"([A-Z]\d+[a-z]?)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of [
      "G0",
      "P1",
      "P2",
      "P3",
      "P4",
      "I0",
      "I1",
      "I2",
      "I3a",
      "I3b",
      "I3c",
      "I4",
      "I5",
      "I6",
      "I7",
      "I8a",
      "I8b",
      "I8c",
      "I9",
      "X1",
    ]) {
      expect(ids, `missing check ${id}`).toContain(id);
    }
  });

  it("reports through the shared formatter and never prints environment values", () => {
    expect(SCRIPT).toContain("formatTally(");
    expect(SCRIPT).toContain("formatCheckLine(");
    expect(SCRIPT).not.toMatch(/console\.\w+\([^)]*process\.env/);
    expect(SCRIPT).not.toMatch(/console\.\w+\([^)]*(SERVICE_ROLE|passwords?\b|anonKey)/);
  });

  it("hard-codes no project ref, key or JWT", () => {
    expect(SCRIPT).not.toContain("uvxbxxmttjbalhksngir");
    expect(SCRIPT).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/);
    expect(SCRIPT).not.toMatch(/sb_secret_|sb_publishable_/);
  });
});
