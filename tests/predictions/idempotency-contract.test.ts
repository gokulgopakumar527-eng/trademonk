import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import { PredictionRejectedError, type PredictionRejectionReason } from "@/services/predictions/errors";
import {
  createPredictionInputSchema,
  evaluationRunInputSchema,
  PREDICTION_IDEMPOTENCY_KEY_PATTERN,
  predictionIdempotencyKeySchema,
  predictionIdSchema,
  type CreatePredictionInput,
} from "@/services/predictions/schemas";

// Phase 5D-A2: the application-level contract for prediction-create idempotency. This file covers
// ONLY the input schema and the error type. Lookup, replay and conflict detection are A3.

const ASSET_ID = "11111111-1111-4111-8111-111111111111";
const input = (idempotencyKey: unknown) => ({ assetId: ASSET_ID, timeframe: "1h", idempotencyKey });
const accepts = (key: unknown) => createPredictionInputSchema.safeParse(input(key)).success;

describe("createPredictionInputSchema: idempotencyKey is required", () => {
  it("accepts a well-formed request and returns the key exactly as given", () => {
    const r = createPredictionInputSchema.safeParse(input("tm-12345678901234"));
    expect(r.success).toBe(true);
    if (r.success) {
      const typed: CreatePredictionInput = r.data;
      expect(typed).toEqual({ assetId: ASSET_ID, timeframe: "1h", idempotencyKey: "tm-12345678901234" });
    }
  });

  it.each(["tm-12345678901234", "prediction_20261006_abc", "abcDEF1234567890"])("accepts the documented example %s", (k) => {
    expect(accepts(k)).toBe(true);
  });

  it("accepts exactly 16 characters (lower bound)", () => expect(accepts("a".repeat(16))).toBe(true));
  it("accepts exactly 128 characters (upper bound)", () => expect(accepts("a".repeat(128))).toBe(true));
  it("accepts letters, numbers, dot, underscore and hyphen", () => {
    expect(accepts("ABCxyz0189._-ABCxyz0189._-")).toBe(true);
    expect(accepts("................")).toBe(true);
    expect(accepts("________________")).toBe(true);
    expect(accepts("----------------")).toBe(true);
    expect(accepts("0123456789012345")).toBe(true);
  });

  it("rejects a missing key", () => {
    expect(createPredictionInputSchema.safeParse({ assetId: ASSET_ID, timeframe: "1h" }).success).toBe(false);
  });
  it("rejects an undefined key", () => expect(accepts(undefined)).toBe(false));
  it("rejects a null key", () => expect(accepts(null)).toBe(false));
  it("rejects an empty key", () => expect(accepts("")).toBe(false));
  it("rejects 15 characters (too short)", () => expect(accepts("a".repeat(15))).toBe(false));
  it("rejects 129 characters (too long)", () => expect(accepts("a".repeat(129))).toBe(false));

  it.each([
    ["a space inside", "has a space in it 1234"],
    ["only spaces", " ".repeat(20)],
    ["a leading space", " abcdefghijklmnop"],
    ["a trailing space", "abcdefghijklmnop "],
    ["a tab", "abcdefgh\tijklmnopqr"],
    ["a newline", "abcdefgh\nijklmnopqr"],
    ["a trailing newline", "abcdefghijklmnop\n"],
    ["a carriage return", "abcdefghijklmnop\r"],
    ["a forward slash", "abcdefgh/ijklmnopqr"],
    ["a backslash", "abcdefgh\\ijklmnopqr"],
    ["a colon", "abcdefgh:ijklmnopqr"],
    ["a semicolon", "abcdefgh;ijklmnopqr"],
    ["a single quote", "abcdefgh'ijklmnopqr"],
    ["a double quote", 'abcdefgh"ijklmnopqr'],
    ["an at sign", "abcdefgh@ijklmnopqr"],
    ["a plus sign", "abcdefgh+ijklmnopqr"],
    ["an equals sign", "abcdefgh=ijklmnopqr"],
    ["a percent sign", "abcdefgh%ijklmnopqr"],
    ["an asterisk", "abcdefgh*ijklmnopqr"],
    ["a non-ASCII letter", "abcdefgh\u00e9ijklmnopqr"],
    ["an emoji", "abcdefgh\u{1F600}ijklmnopqr"],
    ["a zero-width space", "abcdefgh\u200Bijklmnopqr"],
    ["a null byte", "abcdefgh\u0000ijklmnopqr"],
  ])("rejects %s", (_name, key) => {
    expect(accepts(key)).toBe(false);
  });

  it.each([
    ["a number", 1234567890123456],
    ["a boolean", true],
    ["an array", ["abcdefghijklmnop"]],
    ["an object", { key: "abcdefghijklmnop" }],
  ])("rejects %s instead of a string", (_name, key) => {
    expect(accepts(key)).toBe(false);
  });

  it("never trims or normalises: a key that would be valid after trimming is rejected, not repaired", () => {
    const padded = "  tm-12345678901234  ";
    const r = createPredictionInputSchema.safeParse(input(padded));
    expect(r.success).toBe(false);
    expect(predictionIdempotencyKeySchema.safeParse(padded).success).toBe(false);
  });
  it("never changes case", () => {
    const r = predictionIdempotencyKeySchema.safeParse("AbCdEfGhIjKlMnOpQr");
    expect(r.success && r.data).toBe("AbCdEfGhIjKlMnOpQr");
  });

  it("stays strict: unknown fields are still validation errors", () => {
    expect(createPredictionInputSchema.safeParse({ ...input("tm-12345678901234"), userId: "x" }).success).toBe(false);
    expect(createPredictionInputSchema.safeParse({ ...input("tm-12345678901234"), entryPrice: 1 }).success).toBe(false);
    expect(createPredictionInputSchema.safeParse({ ...input("tm-12345678901234"), idempotency_key: "tm-12345678901234" }).success).toBe(false);
  });
  it("still validates the other fields", () => {
    expect(createPredictionInputSchema.safeParse({ assetId: "seed:btc", timeframe: "1h", idempotencyKey: "tm-12345678901234" }).success).toBe(false);
    expect(createPredictionInputSchema.safeParse({ assetId: ASSET_ID, timeframe: "1w", idempotencyKey: "tm-12345678901234" }).success).toBe(false);
  });

  it("uses the same format the database CHECK enforces (16-128 characters of A-Za-z0-9._-)", () => {
    expect(PREDICTION_IDEMPOTENCY_KEY_PATTERN.source).toBe("^[A-Za-z0-9._-]+$");
    expect(PREDICTION_IDEMPOTENCY_KEY_PATTERN.flags).toBe("");
  });
  it("reports a safe, non-leaking message for a bad or missing key", () => {
    const bad = createPredictionInputSchema.safeParse(input("short"));
    const missing = createPredictionInputSchema.safeParse({ assetId: ASSET_ID, timeframe: "1h" });
    expect(!bad.success && bad.error.issues[0]?.message).toBe("Invalid request key");
    expect(!missing.success && missing.error.issues[0]?.message).toBe("A request key is required");
  });
});

describe("keyless schemas stay keyless", () => {
  it("the evaluation-run schema does not take an idempotency key", () => {
    expect(evaluationRunInputSchema.safeParse({}).success).toBe(true);
    expect(evaluationRunInputSchema.safeParse({ limit: 10 }).success).toBe(true);
    expect(evaluationRunInputSchema.safeParse({ limit: 10, idempotencyKey: "tm-12345678901234" }).success).toBe(false);
  });
  it("the prediction id schema is unchanged", () => {
    expect(predictionIdSchema.safeParse(ASSET_ID).success).toBe(true);
    expect(predictionIdSchema.safeParse("tm-12345678901234").success).toBe(false);
  });
});

describe("IDEMPOTENCY_KEY_REUSED error contract", () => {
  const MESSAGE = "This request key was already used for a different prediction.";
  const make = () => new PredictionRejectedError("IDEMPOTENCY_KEY_REUSED", MESSAGE);

  it("is a declared prediction rejection reason", () => {
    const reason: PredictionRejectionReason = "IDEMPOTENCY_KEY_REUSED";
    expect(reason).toBe("IDEMPOTENCY_KEY_REUSED");
  });
  it("is a PredictionRejectedError and an AppError carrying that reason", () => {
    const e = make();
    expect(e).toBeInstanceOf(PredictionRejectedError);
    expect(e).toBeInstanceOf(AppError);
    expect(e).toBeInstanceOf(Error);
    expect(e.reason).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(e.name).toBe("PredictionRejectedError");
    expect(e.message).toBe(MESSAGE);
  });
  it("maps to the VALIDATION app error code, like the paper-trading equivalent", () => {
    expect(make().code).toBe("VALIDATION");
  });
  it("keeps every existing rejection reason on its existing code", () => {
    const expected: Record<Exclude<PredictionRejectionReason, "IDEMPOTENCY_KEY_REUSED">, string> = {
      ASSET_NOT_FOUND: "NOT_FOUND",
      QUOTE_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
      QUOTE_STALE: "PROVIDER_UNAVAILABLE",
      QUOTE_NOT_LIVE: "PROVIDER_UNAVAILABLE",
      MARKET_CLOSED: "PROVIDER_UNAVAILABLE",
      MOCK_DATA_NOT_ALLOWED: "PROVIDER_UNAVAILABLE",
      CANDLES_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
      CANDLES_STALE: "PROVIDER_UNAVAILABLE",
      INSUFFICIENT_DATA: "VALIDATION",
      DATA_INCONSISTENT: "PROVIDER_UNAVAILABLE",
      NO_DIRECTIONAL_SIGNAL: "VALIDATION",
      INVALID_LEVELS: "VALIDATION",
    };
    for (const [reason, code] of Object.entries(expected)) {
      expect(new PredictionRejectedError(reason as PredictionRejectionReason, "x").code).toBe(code);
    }
  });
});
