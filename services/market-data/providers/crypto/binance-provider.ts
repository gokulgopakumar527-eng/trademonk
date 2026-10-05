import type { Market } from "@/types/domain";
import type {
  AssetRef,
  AssetSearchHit,
  CandleSeries,
  HistoricalRequest,
  MarketStatus,
  ProviderCapabilities,
  Quote,
  Result,
} from "@/types/market";
import { TIMEFRAMES } from "@/types/market";
import { logger } from "@/lib/logger";
import { NO_CAPABILITIES, type MarketDataProvider } from "../../provider";
import { fail, ok, unsupported } from "../../result";
import { binanceErrorSchema, klinesSchema, ticker24hrSchema } from "./binance-schemas";
import {
  BINANCE_INTERVAL,
  BINANCE_SOURCE,
  normaliseKlines,
  normaliseQuote,
  toBinanceSymbol,
} from "./binance-normalise";

export interface BinanceProviderOptions {
  /**
   * Public market-data host. Default is Binance's documented market-data-only host, which
   * serves only public endpoints. api.binance.com can return HTTP 451 from restricted regions.
   */
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Retries for retryable failures (5xx/timeout). 429/418 are never retried in-request. */
  maxRetries?: number;
}

export const DEFAULT_BINANCE_BASE_URL = "https://data-api.binance.vision";
const MAX_LIMIT = 1000;

export class BinanceCryptoProvider implements MarketDataProvider {
  readonly id = BINANCE_SOURCE;
  readonly displayName = "Binance (public market data)";
  readonly capabilities: ProviderCapabilities = {
    markets: ["CRYPTO"],
    supports: { ...NO_CAPABILITIES, quote: true, historical: true, marketStatus: true },
    timeframes: TIMEFRAMES,
    maxCandlesPerRequest: MAX_LIMIT,
  };

  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly maxRetries: number;

  constructor(opts: BinanceProviderOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BINANCE_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 8_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => new Date());
    this.maxRetries = opts.maxRetries ?? 1;
  }

  async getQuote(asset: AssetRef): Promise<Result<Quote>> {
    const guard = this.guard(asset, "quote");
    if (!guard.ok) return guard;
    const raw = await this.get("/api/v3/ticker/24hr", { symbol: guard.data });
    if (!raw.ok) return raw;
    const parsed = ticker24hrSchema.safeParse(raw.data);
    if (!parsed.success) return this.invalid("ticker payload failed validation", parsed.error.message);
    try {
      return ok(normaliseQuote(parsed.data, asset, this.now()));
    } catch (e) {
      return this.invalid("ticker payload failed sanity checks", e);
    }
  }

  async getHistoricalData(req: HistoricalRequest): Promise<Result<CandleSeries>> {
    const guard = this.guard(req.asset, "historical");
    if (!guard.ok) return guard;
    const limit = Math.min(Math.max(Math.trunc(req.limit ?? 500), 1), MAX_LIMIT);
    const params: Record<string, string> = {
      symbol: guard.data,
      interval: BINANCE_INTERVAL[req.timeframe],
      limit: String(limit),
    };
    if (req.endTime) {
      const end = Date.parse(req.endTime);
      if (Number.isNaN(end)) {
        return fail(this.id, "INVALID_RESPONSE", "endTime is not a valid date", { retryable: false });
      }
      params.endTime = String(end - 1); // strictly before endTime
    }
    const raw = await this.get("/api/v3/klines", params);
    if (!raw.ok) return raw;
    const parsed = klinesSchema.safeParse(raw.data);
    if (!parsed.success) return this.invalid("klines payload failed validation", parsed.error.message);
    if (parsed.data.length === 0) {
      return fail(this.id, "NOT_FOUND", `no candles returned for ${req.asset.symbol}`, { retryable: false });
    }
    try {
      return ok(normaliseKlines(parsed.data, req.asset, req.timeframe, this.now()));
    } catch (e) {
      return this.invalid("klines payload failed sanity checks", e);
    }
  }

  /** Crypto trades continuously. This is a rule, not a feed: `basis` says so. */
  async getMarketStatus(market: Market): Promise<Result<MarketStatus>> {
    if (market !== "CRYPTO") return unsupported(this.id, "marketStatus");
    const now = this.now().toISOString();
    return ok({
      source: `${this.id}:rule`,
      asOf: now,
      fetchedAt: now,
      isMock: false,
      market,
      state: "ALWAYS_OPEN",
      basis: "RULE",
      nextChangeAt: null,
      note: "Crypto markets trade 24/7; venue maintenance is not reflected.",
    });
  }

  /** Search is served from TradeMonk's own assets table, not the vendor. */
  async searchAssets(): Promise<Result<AssetSearchHit[]>> {
    return unsupported(this.id, "search");
  }

  // ── internals ──
  private guard(asset: AssetRef, capability: "quote" | "historical"): Result<string> {
    if (asset.market !== "CRYPTO") return unsupported(this.id, capability);
    const symbol = toBinanceSymbol(asset);
    if (!symbol) return fail(this.id, "NOT_FOUND", `unsupported symbol "${asset.symbol}"`, { retryable: false });
    return ok(symbol);
  }

  private invalid<T>(message: string, detail: unknown): Result<T> {
    logger.warn("market_data.invalid_response", {
      provider: this.id,
      message,
      detail: detail instanceof Error ? detail.message : String(detail),
    });
    return fail(this.id, "INVALID_RESPONSE", message, { retryable: false });
  }

  private async get(path: string, params: Record<string, string>): Promise<Result<unknown>> {
    const url = `${this.baseUrl}${path}?${new URLSearchParams(params).toString()}`;
    let last: Result<unknown> = fail(this.id, "UPSTREAM_ERROR", "request not attempted");
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      last = await this.once(url);
      if (last.ok || !last.error.retryable || last.error.code === "RATE_LIMITED") return last;
    }
    return last;
  }

  private async once(url: string): Promise<Result<unknown>> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        signal: ctrl.signal,
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (res.ok) {
        try {
          return ok(await res.json());
        } catch {
          return fail(this.id, "INVALID_RESPONSE", "response was not valid JSON", { retryable: false });
        }
      }
      return await this.mapHttpError(res);
    } catch (e) {
      const aborted = e instanceof Error && e.name === "AbortError";
      logger.warn("market_data.request_failed", { provider: this.id, aborted });
      return fail(this.id, aborted ? "TIMEOUT" : "UPSTREAM_ERROR", aborted ? "request timed out" : "network error");
    } finally {
      clearTimeout(timer);
    }
  }

  private async mapHttpError(res: Response): Promise<Result<never>> {
    const status = res.status;
    if (status === 451) {
      return fail(this.id, "GEO_RESTRICTED", "provider refused this server's region (HTTP 451)", { retryable: false });
    }
    if (status === 429 || status === 418) {
      const ra = Number(res.headers.get("retry-after"));
      return fail(this.id, "RATE_LIMITED", `rate limited (HTTP ${status})`, {
        retryable: true,
        ...(Number.isFinite(ra) && ra > 0 ? { retryAfterMs: ra * 1000 } : {}),
      });
    }
    if (status === 401) return fail(this.id, "AUTH", "unauthorised (HTTP 401)", { retryable: false });
    if (status === 403) {
      // Binance uses 403 for WAF blocks (region- or rate-related). Not retried in-request.
      return fail(this.id, "UPSTREAM_ERROR", "blocked by provider firewall (HTTP 403)", { retryable: false });
    }
    if (status === 400) {
      const body = binanceErrorSchema.safeParse(await res.json().catch(() => null));
      if (body.success && body.data.code === -1121) {
        return fail(this.id, "NOT_FOUND", "symbol not found at provider", { retryable: false });
      }
      return fail(this.id, "INVALID_RESPONSE", "provider rejected the request (HTTP 400)", { retryable: false });
    }
    return fail(this.id, "UPSTREAM_ERROR", `upstream error (HTTP ${status})`, { retryable: status >= 500 });
  }
}
