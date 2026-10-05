import "server-only";
import { PAPER_EXECUTION_LIMITS, PAPER_SIMULATION } from "@/config/paper-trading";
import { getServerEnv } from "@/lib/env.server";
import { writeAuditLog } from "@/services/audit/audit-service";
import { getMarketDataService } from "@/services/market-data";
import { createPaperTradingService, type PaperTradingService } from "./paper-trading-service";
import { SupabasePaperTradingStore } from "./supabase-store";

let instance: PaperTradingService | undefined;

/** Production wiring. Market data comes only from getMarketDataService(). */
export function getPaperTradingService(): PaperTradingService {
  instance ??= createPaperTradingService({
    marketData: getMarketDataService(),
    store: new SupabasePaperTradingStore(),
    audit: (e) => writeAuditLog(e),
    now: () => new Date(),
    config: PAPER_SIMULATION,
    limits: PAPER_EXECUTION_LIMITS,
    allowMockData: getServerEnv().APP_ENV === "development",
  });
  return instance;
}

export { PaperTradeRejectedError } from "./errors";
export type { PaperTradeRejectionReason } from "./errors";
export type { PaperTradingService, PaperSimulationAssumptions } from "./paper-trading-service";
export type {
  ClosedPaperTrade,
  ClosedTradeHistory,
  ClosedTradeRecord,
  OpenedPaperTrade,
  OpenTradeEstimate,
  OpenablePaperSide,
  PaperPortfolio,
  CurrencyPortfolio,
  PortfolioPosition,
  PaperTrade,
  PaperTradeResult,
  PaperTradeSide,
  PaperTradeStatus,
} from "./types";
