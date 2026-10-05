import type { Market } from "@/types/domain";
import type { AssetKind } from "@/types/market";

export interface SeedAsset {
  market: Market;
  symbol: string;
  name: string;
  kind: AssetKind;
  currency: string;
}

/** Crypto quoted in USDT (a stablecoin proxy for USD, not INR). Currency is always shown with prices. */
const crypto = (symbol: string, name: string): SeedAsset => ({
  market: "CRYPTO",
  symbol,
  name,
  kind: "CRYPTO",
  currency: "USDT",
});

export const SEED_ASSETS: readonly SeedAsset[] = [
  crypto("BTC", "Bitcoin"),
  crypto("ETH", "Ethereum"),
  crypto("SOL", "Solana"),
  crypto("BNB", "BNB"),
  crypto("XRP", "XRP"),
  crypto("ADA", "Cardano"),
  crypto("DOGE", "Dogecoin"),
  crypto("AVAX", "Avalanche"),
  crypto("LINK", "Chainlink"),
  crypto("DOT", "Polkadot"),
  { market: "NSE", symbol: "NIFTY 50", name: "Nifty 50", kind: "INDEX", currency: "INR" },
  { market: "NSE", symbol: "BANK NIFTY", name: "Nifty Bank", kind: "INDEX", currency: "INR" },
  { market: "NSE", symbol: "FINNIFTY", name: "Nifty Financial Services", kind: "INDEX", currency: "INR" },
  { market: "BSE", symbol: "SENSEX", name: "S&P BSE Sensex", kind: "INDEX", currency: "INR" },
  { market: "NSE", symbol: "RELIANCE", name: "Reliance Industries", kind: "EQUITY", currency: "INR" },
  { market: "NSE", symbol: "TCS", name: "Tata Consultancy Services", kind: "EQUITY", currency: "INR" },
  { market: "NSE", symbol: "HDFCBANK", name: "HDFC Bank", kind: "EQUITY", currency: "INR" },
  { market: "NSE", symbol: "INFY", name: "Infosys", kind: "EQUITY", currency: "INR" },
  { market: "NSE", symbol: "ICICIBANK", name: "ICICI Bank", kind: "EQUITY", currency: "INR" },
];

/** URL slug for an asset: "BANK NIFTY" -> "bank-nifty". */
export const assetSlug = (symbol: string) => symbol.trim().toLowerCase().replace(/\s+/g, "-");
