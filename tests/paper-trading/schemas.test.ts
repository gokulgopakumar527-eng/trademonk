import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parsePaperTradeResultRow,
  parsePaperTradeRow,
  type PaperTradeResultRow,
  type PaperTradeRow,
} from "@/services/paper-trading/schemas";
import { PAPER_TRADE_SIDES, PAPER_TRADE_STATUSES } from "@/services/paper-trading/types";

const MIGRATIONS = path.resolve(__dirname, "../../supabase/migrations");
const sql = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(path.join(MIGRATIONS, f), "utf8"))
  .join("\n");
const enumValues = (name: string): string[] => {
  const m = sql.match(new RegExp(`create type public\\.${name} as enum \\(([^)]*)\\)`));
  return (m?.[1] ?? "").split(",").map((s) => s.trim().replace(/'/g, "")).filter(Boolean);
};

const U1 = "aaaaaaaa-0000-4000-8000-000000000001";
const U2 = "bbbbbbbb-0000-4000-8000-000000000002";
const U3 = "cccccccc-0000-4000-8000-000000000003";
const row = (over: Partial<PaperTradeRow> = {}): PaperTradeRow => ({
  id: U1, user_id: U2, asset_id: U3, side: "LONG", entry_price: 100, quantity: 2,
  stop_loss: null, take_profit: null, fees: 0, strategy_tag: null, status: "OPEN",
  opened_at: "2026-01-01T00:00:00Z", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  ...over,
});
const resultRow = (over: Partial<PaperTradeResultRow> = {}): PaperTradeResultRow => ({
  id: U1, paper_trade_id: U2, user_id: U3, exit_price: 110, fees: 0.5, pnl: 19.5, closed_at: "2026-01-02T00:00:00Z",
  ...over,
});

describe("paper-trading domain types stay in step with the database", () => {
  it("trade sides match the paper_trade_side enum", () => expect([...PAPER_TRADE_SIDES]).toEqual(enumValues("paper_trade_side")));
  it("trade statuses match the paper_trade_status enum", () => expect([...PAPER_TRADE_STATUSES]).toEqual(enumValues("paper_trade_status")));
});

describe("paper trade row validation", () => {
  it("maps a database row to the domain type", () => {
    const t = parsePaperTradeRow(row({ stop_loss: 90, take_profit: 120, strategy_tag: "swing", fees: 0.2 }));
    expect(t).toMatchObject({ userId: U2, assetId: U3, side: "LONG", entryPrice: 100, quantity: 2, stopLoss: 90, takeProfit: 120, fees: 0.2, strategyTag: "swing", status: "OPEN" });
  });
  it("accepts numeric columns returned as strings", () => {
    const t = parsePaperTradeRow(row({ entry_price: "101.25000000", quantity: "0.5", fees: "0" }));
    expect([t.entryPrice, t.quantity, t.fees]).toEqual([101.25, 0.5, 0]);
  });
  it.each(PAPER_TRADE_SIDES)("accepts side %s", (side) => expect(parsePaperTradeRow(row({ side })).side).toBe(side));
  it.each([
    ["unknown side", { side: "HOLD" }],
    ["unknown status", { status: "PENDING" }],
    ["zero entry price", { entry_price: 0 }],
    ["negative entry price", { entry_price: -5 }],
    ["zero quantity", { quantity: 0 }],
    ["negative fees", { fees: -1 }],
    ["non-positive stop loss", { stop_loss: 0 }],
    ["non-positive take profit", { take_profit: -2 }],
    ["NaN entry price", { entry_price: NaN }],
    ["non-numeric string price", { entry_price: "abc" }],
    ["empty string price", { entry_price: "" }],
    ["Infinity quantity", { quantity: Infinity }],
    ["malformed user id", { user_id: "not-a-uuid" }],
    ["missing opened_at", { opened_at: undefined }],
  ] as [string, Partial<PaperTradeRow>][])("rejects %s", (_n, over) => {
    expect(() => parsePaperTradeRow(row(over))).toThrow();
  });
  it("rejects a non-object", () => {
    expect(() => parsePaperTradeRow(null)).toThrow();
    expect(() => parsePaperTradeRow("x")).toThrow();
  });
});

describe("paper trade result row validation", () => {
  it("maps a result row, allowing a negative P&L", () => {
    const r = parsePaperTradeResultRow(resultRow({ pnl: "-12.5" }));
    expect(r).toMatchObject({ paperTradeId: U2, userId: U3, exitPrice: 110, fees: 0.5, pnl: -12.5 });
  });
  it.each([
    ["zero exit price", { exit_price: 0 }],
    ["negative fees", { fees: -0.01 }],
    ["NaN pnl", { pnl: NaN }],
    ["missing trade id", { paper_trade_id: undefined }],
  ] as [string, Partial<PaperTradeResultRow>][])("rejects %s", (_n, over) => {
    expect(() => parsePaperTradeResultRow(resultRow(over))).toThrow();
  });
});
