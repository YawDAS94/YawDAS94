# Home Savings Planner

Work out how much you and your partner need to save each month to buy a specific
house, in a specific area, by a specific year.

It answers two questions:

1. **"We want that house in 4 years — what does that cost us per month?"**
2. **"We can save $2,500/month — when can we actually buy?"** (the harder one,
   because the house appreciates while you save, so it's a race rather than a
   division)

```bash
cd home-affordability
npm start          # -> http://localhost:4173
npm test           # 47 unit tests, no install needed
```

No dependencies, no build step, no account. Node 18+ is the only requirement.
Your income never leaves your machine.

---

## About the data sources (read this first)

You asked for Zillow data and Credit Karma income. Here is the honest state of both.

### Zillow

**There is no open Zillow API.** Three specifics worth knowing:

| Option | Reality |
| --- | --- |
| Zillow's official API (Bridge Interactive) | Real, free — but gated to MLS members, brokerages and partners. You apply and get approved, or you don't get in. |
| Scraping zillow.com | Violates their Terms of Service, and they block it aggressively (captchas, IP bans). Not a foundation to build on. |
| **Zillow Research public CSVs** | **Genuinely free and genuinely Zillow.** The ZHVI (Zillow Home Value Index) publishes typical home values and their full monthly history per ZIP, city and metro. This is the right way to get Zillow's own appreciation numbers. |

The ZHVI is the piece worth wiring up, because appreciation rate is the
assumption that most changes your answer. Download the ZIP-level file from
<https://www.zillow.com/research/data/> and drop it in `data/`.

### Apartments.com

Not usable, and not the right tool anyway. It's CoStar-owned **rental**
inventory — apartments to lease, not homes for sale — so it can't price a house
you intend to buy, and it has no public API. Where rent matters here is the
other side of the equation: what you pay in rent today is what funds the down
payment. That's the `Current rent` input.

### Credit Karma

**Credit Karma has no public API**, and neither does Mint (retired in 2024). The
real programmatic path to household income is **Plaid** (Plaid Income / Assets),
which is what apps like Credit Karma use under the hood. It needs a Plaid client
ID and secret, and income verification is a paid product.

What works with zero setup is the export those apps already give you. Point the
app at a transaction CSV from your bank or payroll provider and it finds the
recurring deposits, infers the pay frequency from the gaps between them
(weekly / biweekly / semi-monthly / monthly), and annualizes each one. That is
the useful part of "linking an account" anyway.

### So what actually ships working

- **Bundled listings** — 4,801 real New York for-sale listings (`NY-House-Dataset.csv`,
  already in this repo), cleaned and grouped into searchable areas with median
  prices, quartile ranges and price-per-sqft. Works offline, no key.
- **RentCast** (`RENTCAST_API_KEY`) — nationwide for-sale listings and market
  stats, published API, ~50 requests/month free. The most practical legitimate
  Zillow substitute.
- **Zillow via RapidAPI** (`RAPIDAPI_KEY`) — a third-party scraper resold on
  RapidAPI. Not affiliated with Zillow. Included because people ask for it;
  check its terms before depending on it.

```bash
RENTCAST_API_KEY=xxx npm start     # nationwide listings light up
```

Providers are swappable behind one interface (`lib/providers/`), so adding
another is one file and one entry in the registry.

---

## Two data problems found in the bundled listings

Worth knowing about, since the fixes change the numbers:

- **1,577 of 4,801 rows (33%) share the exact square footage `2184.207862`.**
  That is the column mean, imputed by whoever built the dataset to patch missing
  values. Left in, it drags every price-per-sqft figure toward a number that
  describes no actual house. It's treated as missing.
- **The same borough appears under two names** — half of Brooklyn is filed as
  `Brooklyn` and half as `Kings County`, which split one market into two entries
  with two different medians. County names are folded into borough names.

---

## How the math works

All of it is in `lib/affordability.js` as pure functions, and all of it is
covered by `test/affordability.test.js` — so the numbers on screen are the ones
under test.

**Monthly payment** is the standard amortization formula, plus the pieces people
forget: property tax, insurance, HOA, and PMI when you put down less than 20%.

**Can you get the loan?** Two underwriting ratios, both checked:
- front-end: housing ÷ gross income ≤ 28%
- back-end (DTI): (housing + other debts) ÷ gross income ≤ 36%

**Cash to close** is not just the down payment — it's down payment + closing
costs (~3%) + reserves the lender wants to see (3 months of payments).

**Required monthly savings** inverts the future-value-of-an-annuity formula
against that cash target, accounting for what your existing savings earn.

**Everything is projected to the purchase date**, not today: the house
appreciates, your income gets raises, and the mortgage rate is whatever you
expect it to be *then*.

### The PMI cliff

One result surprised me enough to surface it in the UI. With a fixed down
payment, the maximum price you can afford often isn't set by your income — it's
pinned exactly at the 20%-down boundary. With $100k down and a $3,360/mo budget,
the payment on a $500k house is only $3,195. One dollar more of house crosses
80% LTV, switches on PMI, adds ~$200/mo, and blows the budget. So the answer is
$500,000 with $165/mo of budget left unused, and the thing that unlocks the next
price band is a slightly bigger down payment — not a raise. The solver detects
this and reports `binding: 'pmi-cliff'`.

---

## API

Every endpoint is JSON; the browser UI is just a client of it.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/plan` | The full savings plan for a target house and timeline |
| `POST /api/when` | Given a monthly savings budget, when can you buy? |
| `POST /api/max-price` | Highest price your income supports |
| `POST /api/takehome` | Estimated net pay from gross incomes |
| `POST /api/income/import` | Infer income streams from a transaction CSV |
| `GET /api/areas` | Every area with median price and quartiles |
| `GET /api/area-profile?area=Queens&minBeds=3` | Stats for the home shape you want |
| `GET /api/listings?area=…&minBeds=…` | Search listings (any provider) |
| `GET/POST/DELETE /api/scenarios` | Save and compare plans |

```bash
curl -X POST localhost:4173/api/plan -H 'Content-Type: application/json' -d '{
  "targetPrice": 650000, "years": 4, "futureRatePct": 6,
  "incomes": [{"annual": 110000}, {"annual": 95000}],
  "currentSavings": 40000, "monthlyTakeHome": 12000,
  "monthlyExpenses": 3500, "currentRent": 2600
}'
```

---

## Limits

- **Tax figures use 2025 federal brackets.** Check them against the current year
  before leaning on the take-home estimate, or enter an effective rate directly.
  It assumes the standard deduction and no credits.
- The bundled listings are **New York only, and a historical snapshot** — good
  for exercising the tool and for NY searches, not a live feed. Add a provider
  key for current nationwide data.
- Appreciation and future mortgage rates are guesses. They are the two inputs
  that move the answer most, so try pessimistic ones — that is what the sliders
  are for.
- Planning estimates, not mortgage, tax or investment advice. Confirm with a
  lender before making decisions.

## Layout

```
home-affordability/
├── server.js              # zero-dependency HTTP server + JSON API
├── lib/
│   ├── affordability.js   # all the math (pure, fully tested)
│   ├── listings.js        # listing search + per-area market stats
│   ├── income.js          # tax estimate + CSV income inference
│   ├── csv.js             # RFC 4180 parser
│   └── providers/         # local / RentCast / Zillow-RapidAPI adapters
├── public/                # UI (vanilla JS, no framework)
└── test/                  # 47 tests: node --test
```
