# Macro indicator pull

Pulls World Bank macro indicators into a **tidy long CSV** — one row per
country / indicator / year — plus two calculated ratios. That shape is what
Google Sheets pivot tables want: no reshaping needed after import.

## Run it

```bash
pip install -r requirements.txt

# All countries, 2000-2025, every indicator, with the calculated metrics
python fetch_macro.py --out macro_long.csv

# A shortlist, with a wide year-as-columns file for eyeballing
python fetch_macro.py --countries "USA;GHA;BRA;NGA;KEN" \
  --start 2010 --end 2025 --out macro_long.csv --wide-out macro_wide.csv
```

No API key needed — the World Bank v2 API is open.

## Output columns

| column | notes |
|---|---|
| `iso3`, `iso2`, `country` | ISO codes and name |
| `region`, `income_group`, `lending_type` | joined from the World Bank country register — these are the good pivot row/filter fields |
| `indicator_code` | e.g. `FS.AST.DOMS.GD.ZS`, or `CALC.*` for a calculated metric |
| `indicator_name` | the World Bank's own label, straight from the API |
| `short_name`, `theme` | our shorter labels, for readable pivot headers |
| `year` | integer |
| `value` | numeric |

Regional and income aggregates ("World", "Euro area") are **excluded by
default** — they double-count real countries and skew any average you pivot on.
Add `--include-aggregates` if you want them.

## Indicators pulled

**Financial depth**
- `FS.AST.PRVT.GD.ZS` — domestic credit to the private sector (% of GDP)
- `FS.AST.DOMS.GD.ZS` — domestic credit provided by the financial sector (% of GDP)
- `FS.AST.CGOV.GD.ZS` — net domestic credit to central government (% of GDP)

**Fiscal balance**
- `GC.NLD.TOTL.GD.ZS` — net lending (+) / net borrowing (−) (% of GDP)

**Financial structure and stability**
- `GFDD.OI.02` — bank concentration
- `GFDD.SI.06` — bank credit to bank deposits

**Savings, external balance and buffers**
- `NY.GDS.TOTL.ZS` — gross domestic savings (% of GDP)
- `BN.CAB.XOKA.GD.ZS` — current account balance (% of GDP)
- `FI.RES.TOTL.MO` — total reserves in months of imports

**External debt**
- `DT.DOD.DECT.GN.ZS` — external debt stocks (% of GNI)
- `DT.TDS.DECT.EX.ZS` — total debt service (% of exports)

Edit `indicators.py` to add more — just append the code, a short name and a theme.

## Actual coverage (run of 2000-2025)

Coverage is very uneven, and one gap shapes the whole analysis:

| indicator | countries | years returned |
|---|---|---|
| `BN.CAB.XOKA.GD.ZS` | 197 | 2000-2025 |
| `NY.GDS.TOTL.ZS` | 187 | 2000-2025 |
| `FS.AST.PRVT.GD.ZS` | 186 | 2000-2025 |
| `FS.AST.CGOV.GD.ZS` | 186 | 2000-2025 |
| `GFDD.OI.02` | 184 | 2000-**2021** |
| `GFDD.SI.06` | 177 | 2000-**2021** |
| `GC.NLD.TOTL.GD.ZS` | 154 | 2000-**2024** |
| `DT.DOD.DECT.GN.ZS` | 121 | 2000-2024 |
| `DT.TDS.DECT.EX.ZS` | 120 | 2000-2024 |
| **`FS.AST.DOMS.GD.ZS`** | **69** | 2000-2025 |

**`FS.AST.DOMS.GD.ZS` is the binding constraint.** It is the denominator of
*both* calculated metrics but is reported for only 69 countries — roughly a
third of the coverage of everything else. So:

- `CALC.BANK.SOV.SAT` → ~69 countries
- `CALC.NEWDEF.BANK.SHARE` → fewer still, where `GC.NLD.TOTL.GD.ZS` also exists

Neither metric can be computed outside that set, however complete the other
indicators look. Filter to those countries before comparing regions, or the
comparison silently rests on whichever countries happen to report domestic
credit.

The `GFDD.*` series stop at **2021** and the debt and fiscal series at
**2024**. In a pivot with `year` on columns, the right-hand columns therefore
cover a shrinking, non-random subset of countries — a cross-indicator average
by year will drift for that reason alone, not because the underlying economics
moved.

## Calculated metrics

Both inputs are % of GDP, so the GDP denominators cancel and the result is a
share of the banking system. Reported ×100, i.e. as a percent.

**`CALC.BANK.SOV.SAT` — Bank sovereign saturation**

```
net credit to central government (% GDP)          FS.AST.CGOV.GD.ZS
------------------------------------------  =  -------------------------  x 100
domestic credit by financial sector (% GDP)       FS.AST.DOMS.GD.ZS
```

How much of the banking system's credit is already absorbed by the sovereign.

**`CALC.NEWDEF.BANK.SHARE` — New deficit as % of banking system**

```
annual net borrowing (% GDP)                     -GC.NLD.TOTL.GD.ZS
------------------------------------------  =  -------------------------  x 100
domestic credit by financial sector (% GDP)       FS.AST.DOMS.GD.ZS
```

How big this year's new borrowing is relative to the whole banking system.

**Sign convention — read this one.** `GC.NLD.TOTL.GD.ZS` is *net lending (+) /
net borrowing (−)*, so a deficit arrives from the API as a **negative** number.
The script negates it, so in the output:

- **positive** = the government is running a deficit and borrowing
- **negative** = the government is running a surplus

If you'd rather keep the World Bank's raw sign, set `"negate_numerator": False`
on that metric in `derived.py`.

A metric is only emitted when both inputs exist for the same country-year, and
the denominator is at least `0.5` — dividing by a near-zero credit stock gives a
number that is arithmetically true and analytically meaningless.

## Getting it into Google Sheets

1. Sheets → **File → Import → Upload** → `macro_long.csv`
2. Import location: **Insert new sheet**. Separator: **Comma**. Leave
   "Convert text to numbers" **on** so `year` and `value` come in numeric.
3. Select the data → **Insert → Pivot table**.

A starting layout:

- **Rows** → `country` (add `region` above it to group)
- **Columns** → `year`
- **Values** → `value`, summarised by **AVERAGE** (not SUM — these are ratios,
  and summing a percentage across years is meaningless)
- **Filters** → `indicator_code`, set to one indicator at a time

Swap `country` for `region` or `income_group` on rows to compare groups.

Re-running the script overwrites the CSV; re-import to the same sheet and the
pivot refreshes.

## Tests

The World Bank API is stubbed with realistically-shaped fixtures, so the suite
runs with no network:

```bash
python -m unittest test_macro -v
```

23 tests cover pagination, the source fallback, the metadata join, aggregate
filtering, and the ratio maths including the deficit sign convention.

## Notes on the API

- `DT.*` codes are served by International Debt Statistics (source 6), so
  `indicators.py` records that source. The `GFDD.*` codes are the opposite
  case: passing `source=33` makes the API **reject** them outright, and they
  resolve only against the default source — so they declare no source at all.
  Either way the fetcher retries across the other sources when one refuses,
  and only calls a code bad once every source has turned it down.
- Some sources return a blank `countryiso3code`; the script recovers the ISO3
  from the ISO2 code via the country register.
- Coverage is uneven. `GC.NLD.TOTL.GD.ZS` in particular is missing for many
  countries and years, which limits where `CALC.NEWDEF.BANK.SHARE` can be
  computed. The run prints per-indicator row counts and year spans so you can
  see what actually came back.
