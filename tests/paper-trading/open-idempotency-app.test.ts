/**
 * Phase 5C-7C-B: application-layer idempotency for opening a paper trade.
 * Schema, service (replay + conflict), store boundary, and the UI intent rules. Local tests only:
 * the real database behaviour is proven by 5C-7C-A's SQL/concurrency tests.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generateIdempotencyKey, openIntentFingerprint, resolveOpenIntent } from "@/features/paper-trading/idempotency";
import { AppError } from "@/lib/errors";
import { PaperTradeRejectedError } from "@/services/paper-trading/errors";
import { createPaperTradingService } from "@/services/paper-trading/paper-trading-service";
import { openPaperTradeInputSchema, previewPaperTradeInputSchema } from "@/services/paper-trading/schemas";
import { ALICE, BOB, BTC_ID, KEY, freshView, makeDeps, nextKey, quote } from "./open-helpers";

const base = { assetId: BTC_ID, side: "BUY", quantity: "2" };
const ok = (idempotencyKey: unknown) => openPaperTradeInputSchema.safeParse({ ...base, idempotencyKey });
const root = path.resolve(import.meta.dirname, "../..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("open-trade input schema: idempotencyKey", () => {
  it.each([KEY, "a".repeat(16), "A".repeat(128), "tm-0123456789abcdef.ABC_def-9", generateIdempotencyKey()])("accepts %s", (k) => {
    expect(ok(k).success).toBe(true);
  });
  it.each([
    ["missing", undefined],
    ["null", null],
    ["number", 1234567890123456],
    ["object", { a: 1 }],
    ["array", ["a".repeat(16)]],
    ["empty", ""],
    ["too short (15)", "a".repeat(15)],
    ["too long (129)", "a".repeat(129)],
    ["space", "abcdefghijklmnop qrstuvwx"],
    ["slash", "abcdefghijklmnop/../x"],
    ["semicolon / SQL", "abcdefghijklmnop'; drop table paper_trades;--"],
    ["unicode", "abcdefghijklmnop\u00e9\u00e9\u00e9"],
    ["newline", "abcdefghijklmnop\n"],
    ["leading whitespace", " abcdefghijklmnop"],
  ])("rejects a %s key", (_n, k) => {
    expect(ok(k).success).toBe(false);
  });
  it("is strict: price, fee, balance, execution time, user id and any other extra field are rejected", () => {
    for (const extra of [{ price: 1 }, { entryPrice: 1 }, { fee: 0 }, { cashBalance: 1e9 }, { executedAt: "2026-01-01" }, { userId: ALICE }, { user_id: ALICE }, { x: 1 }]) {
      expect(openPaperTradeInputSchema.safeParse({ ...base, idempotencyKey: KEY, ...extra }).success).toBe(false);
    }
  });
  it("the read-only estimate takes no key (and still rejects one)", () => {
    expect(previewPaperTradeInputSchema.safeParse(base).success).toBe(true);
    expect(previewPaperTradeInputSchema.safeParse({ ...base, idempotencyKey: KEY }).success).toBe(false);
  });
});

describe("open-trade service: key reaches the store; the session stays the authority", () => {
  it("passes the validated key to the store, with identity from the session argument only", async () => {
    const c = makeDeps();
    await createPaperTradingService(c.deps).openTrade(ALICE, { ...base, idempotencyKey: KEY });
    expect(c.fs.calls).toHaveLength(1);
    expect(c.fs.calls[0]).toMatchObject({ userId: ALICE, idempotencyKey: KEY });
  });
  it("refuses a missing/malformed key before any quote or store I/O", async () => {
    for (const k of [undefined, "short", "bad key bad key bad key"]) {
      const c = makeDeps();
      const e = await createPaperTradingService(c.deps).openTrade(ALICE, { ...base, idempotencyKey: k }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe("VALIDATION");
      expect(c.quoteCalls).toHaveLength(0);
      expect(c.fs.calls).toHaveLength(0);
    }
  });
  it("a client user id, price or fee can never become authority (all refused, nothing stored)", async () => {
    for (const extra of [{ userId: BOB }, { price: 1 }, { fee: 0 }, { executionPrice: 1 }]) {
      const c = makeDeps();
      await expect(createPaperTradingService(c.deps).openTrade(ALICE, { ...base, idempotencyKey: KEY, ...extra })).rejects.toBeInstanceOf(AppError);
      expect(c.fs.calls).toHaveLength(0);
    }
  });
  it("the key is not an authority: the same key from another user is a different (user, key) and opens its own trade", async () => {
    const c = makeDeps();
    const svc = createPaperTradingService(c.deps);
    const a = await svc.openTrade(ALICE, { ...base, idempotencyKey: KEY });
    const b = await svc.openTrade(BOB, { ...base, idempotencyKey: KEY });
    expect(a.id).not.toBe(b.id);
    expect([a.replayed, b.replayed]).toEqual([false, false]);
  });
});

describe("open-trade service: replay and conflict", () => {
  it("first call is replayed:false; the same key again returns the SAME trade, replayed:true, with no second trade, debit or audit", async () => {
    const c = makeDeps();
    const svc = createPaperTradingService(c.deps);
    const first = await svc.openTrade(ALICE, { ...base, idempotencyKey: KEY });
    const cash = [...c.fs.state.accounts.values()][0]!.balance;
    const again = await svc.openTrade(ALICE, { ...base, idempotencyKey: KEY });
    expect(first.replayed).toBe(false);
    expect(again.replayed).toBe(true);
    expect(again.id).toBe(first.id);
    expect(c.fs.state.trades).toHaveLength(1);
    expect([...c.fs.state.accounts.values()][0]!.balance).toBe(cash);
    expect(c.auditCalls).toHaveLength(1);
    expect(again).toMatchObject({ entryPrice: first.entryPrice, fee: first.fee, cashDebited: first.cashDebited, cashBalanceAfter: first.cashBalanceAfter, openedAt: first.openedAt });
  });
  it("a replay returns the ORIGINAL receipt even though the market has moved since", async () => {
    const c = makeDeps();
    const first = await createPaperTradingService(c.deps).openTrade(ALICE, { ...base, idempotencyKey: KEY });
    const moved = makeDeps({ store: c.fs.store, quoteView: freshView(quote({ price: 250 })) });
    const again = await createPaperTradingService(moved.deps).openTrade(ALICE, { ...base, idempotencyKey: KEY });
    expect(again.replayed).toBe(true);
    expect(again.entryPrice).toBe(first.entryPrice);
    expect(c.fs.state.trades).toHaveLength(1);
  });
  it("a double submit (concurrent, same intent) opens exactly one trade", async () => {
    const c = makeDeps();
    const svc = createPaperTradingService(c.deps);
    const [x, y] = await Promise.all([svc.openTrade(ALICE, { ...base, idempotencyKey: KEY }), svc.openTrade(ALICE, { ...base, idempotencyKey: KEY })]);
    expect(c.fs.state.trades).toHaveLength(1);
    expect(x.id).toBe(y.id);
  });
  it("a new intent (new key) opens a second trade", async () => {
    const c = makeDeps();
    const svc = createPaperTradingService(c.deps);
    await svc.openTrade(ALICE, { ...base, idempotencyKey: KEY });
    await svc.openTrade(ALICE, { ...base, idempotencyKey: nextKey() });
    expect(c.fs.state.trades).toHaveLength(2);
  });
  it.each([
    ["quantity", { ...base, quantity: "3" }],
    ["side", { ...base, side: "LONG" }],
  ])("reusing a key with a different %s is a safe validation conflict and changes nothing", async (_n, other) => {
    const c = makeDeps();
    const svc = createPaperTradingService(c.deps);
    await svc.openTrade(ALICE, { ...base, idempotencyKey: KEY });
    const e = await svc.openTrade(ALICE, { ...other, idempotencyKey: KEY }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PaperTradeRejectedError);
    expect((e as PaperTradeRejectedError).reason).toBe("IDEMPOTENCY_KEY_REUSED");
    expect((e as PaperTradeRejectedError).code).toBe("VALIDATION");
    expect((e as Error).message).not.toMatch(/sql|postgres|paper_trades|PAPER_|rpc/i);
    expect(c.fs.state.trades).toHaveLength(1);
  });
  it("reusing a key with a different asset is the same safe conflict", async () => {
    const c = makeDeps();
    const svc = createPaperTradingService(c.deps);
    await svc.openTrade(ALICE, { ...base, idempotencyKey: KEY });
    const other = { assetId: "dddddddd-0000-4000-8000-000000000002", side: "BUY", quantity: "2", idempotencyKey: KEY };
    const e = await svc.openTrade(ALICE, other).catch((x: unknown) => x);
    // Either refused as a conflict by the store, or earlier by a gate for that asset: never a second trade.
    expect(e).toBeInstanceOf(PaperTradeRejectedError);
    expect(c.fs.state.trades).toHaveLength(1);
  });
  it("a store failure is sanitised: no database text reaches the caller", async () => {
    const c = makeDeps();
    c.fs.store.openTrade = async () => { throw new Error('PAPER_INVALID_INPUT: relation "paper_trades" permission denied'); };
    const e = await createPaperTradingService(c.deps).openTrade(ALICE, { ...base, idempotencyKey: KEY }).catch((x: unknown) => x);
    expect((e as AppError).code).toBe("INTERNAL");
    expect((e as Error).message).toBe("Could not open the paper trade. Nothing was changed.");
  });
});

describe("store boundary: the store is the only caller of open_paper_trade and writes no tables", () => {
  const walk = (d: string): string[] =>
    readdirSync(path.join(root, d)).flatMap((n) => {
      const rel = `${d}/${n}`;
      if (n === "node_modules" || n === ".next") return [];
      return statSync(path.join(root, rel)).isDirectory() ? walk(rel) : /\.(ts|tsx)$/.test(n) ? [rel] : [];
    });
  const app = ["app", "components", "features", "services", "lib"].flatMap(walk);
  it("only supabase-store.ts calls the open RPC (scripts and tests aside)", () => {
    expect(app.filter((f) => /rpc\(\s*["']open_paper_trade["']/.test(read(f)))).toEqual(["services/paper-trading/supabase-store.ts"]);
  });
  it("it uses the service-role admin client and adds no direct paper_trades write", () => {
    const src = strip(read("services/paper-trading/supabase-store.ts"));
    expect(src).toMatch(/createSupabaseAdminClient\(\)\.rpc\("open_paper_trade"/);
    expect(src).not.toMatch(/\.(insert|update|upsert|delete)\(/);
    expect(src).not.toMatch(/from\(\s*["']paper_trades["']\s*\)\s*\.(insert|update|upsert|delete)/);
  });
  it("no client code can reach the admin client or the service role", () => {
    for (const f of walk("components")) expect(read(f), f).not.toMatch(/supabase\/admin|SERVICE_ROLE|supabase-store/);
    expect(strip(read("features/paper-trading/idempotency.ts"))).not.toMatch(/import\s/);
  });
});

describe("UI intent: one trade intent = one stable key", () => {
  it("generated keys satisfy the database format, are opaque and do not repeat", () => {
    const keys = Array.from({ length: 200 }, generateIdempotencyKey);
    for (const k of keys) {
      expect(k.length).toBeGreaterThanOrEqual(16);
      expect(k.length).toBeLessThanOrEqual(128);
      expect(k).toMatch(/^[A-Za-z0-9._-]+$/);
      expect(ok(k).success).toBe(true);
    }
    expect(new Set(keys).size).toBe(keys.length);
  });
  it("the key carries no trade data", () => {
    const k = generateIdempotencyKey();
    for (const s of [BTC_ID, "BTC", "BUY", ALICE]) expect(k.includes(s)).toBe(false);
  });
  const fp = openIntentFingerprint({ assetId: BTC_ID, side: "BUY", quantity: "2" });
  it("duplicate submission and re-render reuse the same intent and key (generator is not called again)", () => {
    let n = 0;
    const gen = () => `generated-key-${++n}-0000000000`;
    const first = resolveOpenIntent(null, fp, gen);
    const second = resolveOpenIntent(first, fp, gen); // double click / re-render / retry
    const third = resolveOpenIntent(second, openIntentFingerprint({ assetId: BTC_ID, side: "BUY", quantity: " 2 " }), gen); // whitespace is not a new intent
    expect(second).toBe(first);
    expect(third.key).toBe(first.key);
    expect(n).toBe(1);
  });
  it("a changed asset, side or quantity is a NEW intent with a NEW key", () => {
    const first = resolveOpenIntent(null, fp);
    for (const next of [
      openIntentFingerprint({ assetId: BTC_ID, side: "BUY", quantity: "3" }),
      openIntentFingerprint({ assetId: BTC_ID, side: "LONG", quantity: "2" }),
      openIntentFingerprint({ assetId: "dddddddd-0000-4000-8000-000000000002", side: "BUY", quantity: "2" }),
    ]) {
      expect(resolveOpenIntent(first, next).key).not.toBe(first.key);
    }
  });
  it("after a finished trade (intent cleared) the same form values start a new intent", () => {
    const first = resolveOpenIntent(null, fp);
    expect(resolveOpenIntent(null, fp).key).not.toBe(first.key);
  });
});

describe("open panel wiring (static): the key lives in a ref and is cleared only when the intent ends", () => {
  const code = strip(read("components/paper-trading/open-trade-panel.tsx"));
  it("holds the intent in a ref (not regenerated on render) and resolves it through the shared rule", () => {
    expect(code).toMatch(/useRef<OpenIntent \| null>\(null\)/);
    expect(code).toMatch(/resolveOpenIntent\(intent\.current, openIntentFingerprint\(/);
    expect(code).not.toMatch(/generateIdempotencyKey/);
    expect(code).not.toMatch(/Math\.random|randomUUID/);
  });
  it("guards against a double submit while a request is in flight", () => {
    expect(code).toMatch(/if \(pending \|\| inFlight\.current \|\| !estimate\) return;/);
    expect(code).toMatch(/finally \{\s*inFlight\.current = false;/);
  });
  it("keeps the key on a network/server failure (so a retry replays) and clears it on success", () => {
    expect(code).toMatch(/setOpened\(res\.trade\);\s*setEstimate\(null\);\s*intent\.current = null;/);
    const catchBlock = code.slice(code.indexOf("} catch {"), code.indexOf("} finally {"));
    expect(catchBlock).not.toMatch(/intent\.current\s*=/);
    expect(catchBlock).toMatch(/will not open twice/);
  });
  it("shows a replay as the already-created trade, and never changes a balance itself", () => {
    expect(code).toMatch(/opened\.replayed/);
    expect(code).toMatch(/No second trade was made/);
    expect(code).not.toMatch(/cashBalance\w*\s*[-+]=|setCash|balance\s*-\s*/);
  });
});
