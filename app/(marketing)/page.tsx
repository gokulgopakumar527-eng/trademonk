import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Wordmark } from "@/components/layout/wordmark";
import { Disclaimer } from "@/components/layout/disclaimer";
import { siteConfig } from "@/config/site";

const recordFields = [
  ["Asset and direction", "Chosen by you"],
  ["Target and invalidation", "Chosen by you, checked for consistency"],
  ["Recorded at", "Stamped by the server, never by the browser"],
  ["Fingerprint", "A hash of the record, so changes are detectable"],
  ["Corrections", "Added as new, dated entries beside the original"],
  ["Outcome", "Written by the server after the horizon ends"],
];

const features = [
  [
    "Market intelligence",
    "Quotes, charts and market structure in one place, each with its source and how fresh it is.",
  ],
  [
    "AI analysis",
    "Summaries that keep observed data and AI interpretation visibly apart, with scenarios and invalidation levels.",
  ],
  [
    "Prediction tracking",
    "Every prediction is timestamped and immutable, so track records can be audited rather than trusted.",
  ],
  ["Paper trading", "Test ideas with simulated trades. No real money is ever involved."],
  [
    "Alerts",
    "Price, indicator and volume conditions delivered in the app, by email or on Telegram.",
  ],
  ["Indian markets", "NIFTY 50, BANK NIFTY, FINNIFTY, SENSEX and major NSE and BSE equities."],
  ["Crypto", "BTC, ETH, SOL and other major assets, with more symbols added over time."],
];

const free = [
  "Market dashboard",
  "Limited watchlists",
  "Basic AI analysis",
  "Limited predictions",
  "Daily briefing",
];
const pro = [
  "Advanced AI analysis",
  "Unlimited watchlists",
  "Advanced alerts",
  "Prediction analytics",
  "Paper trading analytics",
  "Telegram alerts",
];

export default function LandingPage() {
  return (
    <div className="mx-auto min-h-dvh max-w-6xl px-6">
      <header className="flex items-center justify-between py-6">
        <Wordmark />
        <nav className="flex items-center gap-2" aria-label="Account">
          <Button asChild variant="ghost">
            <Link href="/login">Sign in</Link>
          </Button>
        </nav>
      </header>

      <main>
        <section className="grid gap-12 py-16 md:grid-cols-[1.1fr_1fr] md:py-24">
          <div>
            <h1 className="font-display text-6xl font-medium leading-none md:text-7xl">
              {siteConfig.name}
            </h1>
            <p className="mt-6 max-w-lg text-xl">{siteConfig.tagline}</p>
            <p className="mt-3 max-w-lg text-muted">{siteConfig.subtitle}</p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button asChild size="lg">
                <Link href="/markets">Explore Markets</Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <Link href="/signup">Try TradeMonk AI</Link>
              </Button>
            </div>
          </div>

          <aside
            aria-labelledby="record-heading"
            className="self-center rounded-panel border border-line bg-panel"
          >
            <div className="border-b border-line px-5 py-4">
              <h2 id="record-heading" className="font-medium">
                How a prediction record is kept
              </h2>
              <p className="mt-1 text-sm text-muted">
                The structure of every record. Not a real prediction.
              </p>
            </div>
            <dl className="divide-y divide-line">
              {recordFields.map(([term, detail]) => (
                <div key={term} className="grid grid-cols-[9rem_1fr] gap-4 px-5 py-3 text-sm">
                  <dt className="font-medium">{term}</dt>
                  <dd className="text-muted">{detail}</dd>
                </div>
              ))}
            </dl>
          </aside>
        </section>

        <section aria-labelledby="what" className="border-t border-line py-16">
          <h2 id="what" className="font-display text-3xl font-medium">
            Data, then analysis, then interpretation, then your decision
          </h2>
          <dl className="mt-10 grid gap-x-12 gap-y-8 md:grid-cols-2">
            {features.map(([title, body]) => (
              <div key={title}>
                <dt className="font-medium">{title}</dt>
                <dd className="mt-1 max-w-md text-muted">{body}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section
          id="pricing"
          aria-labelledby="pricing-heading"
          className="border-t border-line py-16"
        >
          <h2 id="pricing-heading" className="font-display text-3xl font-medium">
            Pricing
          </h2>
          <p className="mt-2 text-muted">
            Pro pricing will be published before paid plans launch. Nothing is charged today.
          </p>
          <div className="mt-8 grid gap-6 md:grid-cols-2">
            {[
              { name: "Free", items: free },
              { name: "Pro", items: pro },
            ].map((plan) => (
              <div key={plan.name} className="rounded-panel border border-line p-6">
                <h3 className="font-display text-2xl font-medium">{plan.name}</h3>
                <ul className="mt-4 space-y-2 text-sm">
                  {plan.items.map((i) => (
                    <li key={i}>{i}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      </main>

      <footer className="space-y-4 border-t border-line py-8">
        <Disclaimer />
        <nav aria-label="Legal" className="flex gap-5 text-sm text-muted">
          <Link href="/terms" className="hover:text-fg">
            Terms
          </Link>
          <Link href="/privacy" className="hover:text-fg">
            Privacy
          </Link>
          <Link href="/risk-disclosure" className="hover:text-fg">
            Risk disclosure
          </Link>
        </nav>
      </footer>
    </div>
  );
}
