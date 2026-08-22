#!/usr/bin/env python3
"""Pull World Bank macro indicators into a tidy CSV built for pivot tables.

The output is one row per country-indicator-year, which is the shape Google
Sheets pivot tables want: drop `year` on columns, `country`/`region` on rows,
`indicator` on the filter, and `value` in the values box.

    python fetch_macro.py --start 2000 --end 2025 --out macro_long.csv

Run `python fetch_macro.py --help` for the full option list.
"""

import argparse
import csv
import sys
import time
from typing import Dict, Iterable, List, Optional, Tuple

import requests

from derived import DERIVED_BY_CODE, REQUIRED_INPUTS, compute_derived, missing_inputs
from indicators import BY_CODE, DEFAULT_CODES, FALLBACK_SOURCES

API_ROOT = "https://api.worldbank.org/v2"
PER_PAGE = 1000

LONG_COLUMNS = [
    "iso3",
    "country",
    "iso2",
    "region",
    "income_group",
    "lending_type",
    "indicator_code",
    "indicator_name",
    "short_name",
    "theme",
    "year",
    "value",
]


class WorldBankError(RuntimeError):
    pass


class WorldBankClient:
    """Thin, retrying JSON client for the World Bank v2 API."""

    def __init__(self, retries: int = 4, backoff: float = 2.0, timeout: int = 60,
                 session: Optional[requests.Session] = None):
        self.retries = retries
        self.backoff = backoff
        self.timeout = timeout
        self.session = session or requests.Session()

    def get_json(self, path: str, params: Dict) -> list:
        """GET `path` and return the decoded JSON, retrying on transport errors."""
        params = dict(params, format="json")
        url = f"{API_ROOT}/{path.lstrip('/')}"
        delay = self.backoff
        last_error = None
        for attempt in range(self.retries):
            try:
                response = self.session.get(url, params=params, timeout=self.timeout)
                response.raise_for_status()
                return response.json()
            except (requests.RequestException, ValueError) as exc:
                last_error = exc
                if attempt < self.retries - 1:
                    time.sleep(delay)
                    delay *= 2
        raise WorldBankError(f"GET {url} failed after {self.retries} attempts: {last_error}")

    def paged_rows(self, path: str, params: Dict) -> List[dict]:
        """Walk every page of a list endpoint and return the concatenated rows.

        Returns [] when the API reports no data, which is a normal answer for an
        indicator that is not served by the requested source.
        """
        rows: List[dict] = []
        page = 1
        while True:
            payload = self.get_json(path, dict(params, per_page=PER_PAGE, page=page))
            meta, data = _split_payload(payload)
            if data is None:
                return rows
            rows.extend(data)
            pages = int(meta.get("pages") or 0)
            if page >= pages:
                return rows
            page += 1


def _split_payload(payload) -> Tuple[dict, Optional[list]]:
    """Normalise the API's several response shapes into (meta, rows-or-None)."""
    if not isinstance(payload, list) or not payload:
        raise WorldBankError(f"Unexpected API response: {payload!r:.200}")

    head = payload[0]
    # Error responses are a single-element list carrying a `message` array.
    if isinstance(head, dict) and "message" in head:
        messages = head.get("message") or []
        detail = "; ".join(
            f"{m.get('key', '')}: {m.get('value', '')}".strip(": ")
            for m in messages if isinstance(m, dict)
        )
        raise WorldBankError(detail or "API returned an unspecified error")

    if len(payload) < 2 or not payload[1]:
        return (head if isinstance(head, dict) else {}), None
    return head, payload[1]


def fetch_country_metadata(client: WorldBankClient) -> Dict[str, dict]:
    """Return ISO3 -> {name, iso2, region, income_group, lending_type, is_aggregate}."""
    rows = client.paged_rows("country", {})
    meta: Dict[str, dict] = {}
    for row in rows:
        iso3 = (row.get("id") or "").strip()
        if not iso3:
            continue
        region = ((row.get("region") or {}).get("value") or "").strip()
        meta[iso3] = {
            "iso3": iso3,
            "iso2": (row.get("iso2Code") or "").strip(),
            "country": (row.get("name") or "").strip(),
            "region": region,
            "income_group": ((row.get("incomeLevel") or {}).get("value") or "").strip(),
            "lending_type": ((row.get("lendingType") or {}).get("value") or "").strip(),
            # The API files regional/income aggregates ("World", "Euro area") under
            # the literal region "Aggregates". They double-count real countries, so
            # they are excluded unless the caller asks for them.
            "is_aggregate": region == "Aggregates",
        }
    if not meta:
        raise WorldBankError("Country metadata request returned no rows")
    return meta


def fetch_indicator(client: WorldBankClient, code: str, countries: str,
                    date_range: str) -> List[dict]:
    """Fetch one indicator, trying its declared source then the known fallbacks."""
    declared = (BY_CODE.get(code) or {}).get("source")
    # `None` first for indicators we have no hint for: the API's default source
    # answers the great majority of codes without any source parameter at all.
    candidates: List[Optional[int]] = [declared] if declared else [None]
    for source in FALLBACK_SOURCES:
        if source not in candidates:
            candidates.append(source)
    if None not in candidates:
        candidates.insert(1, None)

    last_error = None
    for source in candidates:
        params = {"date": date_range}
        if source is not None:
            params["source"] = source
        try:
            rows = client.paged_rows(f"country/{countries}/indicator/{code}", params)
        except WorldBankError as exc:
            last_error = exc
            continue
        if any(row.get("value") is not None for row in rows):
            return rows
    if last_error is not None:
        raise WorldBankError(f"{code}: {last_error}")
    return []


def to_long_rows(api_rows: Iterable[dict], code: str, country_meta: Dict[str, dict],
                 iso2_to_iso3: Dict[str, str], include_aggregates: bool,
                 keep_nulls: bool) -> List[dict]:
    """Flatten API rows into tidy long records joined to country metadata."""
    catalogue = BY_CODE.get(code, {})
    out: List[dict] = []
    for row in api_rows:
        value = row.get("value")
        if value is None and not keep_nulls:
            continue

        country_block = row.get("country") or {}
        iso2 = (country_block.get("id") or "").strip()
        # Some sources leave countryiso3code blank; recover it from the iso2 code.
        iso3 = (row.get("countryiso3code") or "").strip() or iso2_to_iso3.get(iso2, "")
        meta = country_meta.get(iso3, {})

        if meta.get("is_aggregate") and not include_aggregates:
            continue
        # An unmatched code is almost always an aggregate the metadata call did
        # not cover; drop it too rather than emit a row with no region.
        if not meta and not include_aggregates:
            continue

        indicator_block = row.get("indicator") or {}
        year = row.get("date")
        out.append({
            "iso3": iso3,
            "country": meta.get("country") or (country_block.get("value") or "").strip(),
            "iso2": meta.get("iso2") or iso2,
            "region": meta.get("region", ""),
            "income_group": meta.get("income_group", ""),
            "lending_type": meta.get("lending_type", ""),
            "indicator_code": code,
            "indicator_name": (indicator_block.get("value") or "").strip(),
            "short_name": catalogue.get("short_name", ""),
            "theme": catalogue.get("theme", ""),
            "year": int(year) if year and str(year).isdigit() else year,
            "value": value,
        })
    return out


def _year_key(row: dict) -> tuple:
    """Sortable year key that tolerates non-annual periods like '2020Q1'."""
    year = row.get("year")
    if isinstance(year, int):
        return (year, "")
    text = str(year or "")
    return (int(text[:4]), text[4:]) if text[:4].isdigit() else (0, text)


def latest_per_series(rows: List[dict]) -> List[dict]:
    """Keep only the most recent non-null observation per country-indicator."""
    best: Dict[tuple, dict] = {}
    for row in rows:
        if row.get("value") is None:
            continue
        key = (row["iso3"], row["indicator_code"])
        current = best.get(key)
        if current is None or _year_key(row) > _year_key(current):
            best[key] = row
    return sorted(best.values(), key=lambda r: (r["country"], r["indicator_code"]))


def write_long_csv(rows: List[dict], path: str) -> None:
    with open(path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=LONG_COLUMNS)
        writer.writeheader()
        writer.writerows(rows)


def write_wide_csv(rows: List[dict], path: str) -> None:
    """Write a country-indicator x year matrix for quick eyeballing."""
    years = sorted({r["year"] for r in rows if r["year"] is not None})
    header = ["iso3", "country", "region", "income_group",
              "indicator_code", "short_name"] + [str(y) for y in years]
    keyed: Dict[tuple, dict] = {}
    for row in rows:
        key = (row["iso3"], row["indicator_code"])
        entry = keyed.setdefault(key, {
            "iso3": row["iso3"],
            "country": row["country"],
            "region": row["region"],
            "income_group": row["income_group"],
            "indicator_code": row["indicator_code"],
            "short_name": row["short_name"],
        })
        if row["year"] is not None:
            entry[str(row["year"])] = row["value"]
    with open(path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=header, restval="")
        writer.writeheader()
        for key in sorted(keyed, key=lambda k: (keyed[k]["country"], k[1])):
            writer.writerow(keyed[key])


def parse_args(argv=None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Pull World Bank macro indicators into a pivot-ready CSV.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--indicators", default=",".join(DEFAULT_CODES),
                        help="Comma-separated World Bank indicator codes.")
    parser.add_argument("--countries", default="all",
                        help="'all' or semicolon-separated ISO3 codes, e.g. 'USA;GHA;BRA'.")
    parser.add_argument("--start", type=int, default=2000, help="First year, inclusive.")
    parser.add_argument("--end", type=int, default=2025, help="Last year, inclusive.")
    parser.add_argument("--out", default="macro_long.csv", help="Long-format CSV output path.")
    parser.add_argument("--wide-out", default=None,
                        help="Optional extra wide (year-as-column) CSV path.")
    parser.add_argument("--include-aggregates", action="store_true",
                        help="Keep 'World', 'Euro area' and other aggregate rows.")
    parser.add_argument("--keep-nulls", action="store_true",
                        help="Emit rows for years with no observation.")
    parser.add_argument("--no-derived", action="store_true",
                        help="Skip the calculated ratio metrics (bank sovereign "
                             "saturation, new deficit as %% of banking system).")
    parser.add_argument("--latest-only", action="store_true",
                        help="Keep only the newest observation per country-indicator.")
    parser.add_argument("--timeout", type=int, default=60, help="Per-request timeout, seconds.")
    parser.add_argument("--retries", type=int, default=4, help="Attempts per request.")
    return parser.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    if args.start > args.end:
        print(f"--start ({args.start}) is after --end ({args.end})", file=sys.stderr)
        return 2

    codes = [c.strip() for c in args.indicators.split(",") if c.strip()]
    if not codes:
        print("No indicator codes given", file=sys.stderr)
        return 2

    if not args.no_derived:
        # The ratio metrics are useless without their inputs, so add any the
        # caller left out rather than silently emitting nothing for them.
        added = [c for c in REQUIRED_INPUTS if c not in codes]
        if added:
            codes.extend(added)
            print(f"Added inputs needed by the calculated metrics: {', '.join(added)}",
                  file=sys.stderr)

    date_range = f"{args.start}:{args.end}"
    client = WorldBankClient(retries=args.retries, timeout=args.timeout)

    print("Fetching country metadata...", file=sys.stderr)
    try:
        country_meta = fetch_country_metadata(client)
    except WorldBankError as exc:
        # Nothing downstream works without the country register, so fail here
        # with something readable rather than a traceback.
        print(f"\nCould not reach the World Bank API: {exc}", file=sys.stderr)
        print("Check your network connection or proxy and try again.", file=sys.stderr)
        return 3
    iso2_to_iso3 = {m["iso2"]: m["iso3"] for m in country_meta.values() if m["iso2"]}
    print(f"  {len(country_meta)} countries and aggregates", file=sys.stderr)

    all_rows: List[dict] = []
    failed: List[str] = []
    for code in codes:
        label = (BY_CODE.get(code) or {}).get("short_name", code)
        print(f"Fetching {code} ({label})...", file=sys.stderr)
        try:
            api_rows = fetch_indicator(client, code, args.countries, date_range)
        except WorldBankError as exc:
            print(f"  FAILED: {exc}", file=sys.stderr)
            failed.append(code)
            continue
        rows = to_long_rows(api_rows, code, country_meta, iso2_to_iso3,
                            args.include_aggregates, args.keep_nulls)
        if not rows:
            print("  no observations returned", file=sys.stderr)
        else:
            span = f"{min(r['year'] for r in rows)}-{max(r['year'] for r in rows)}"
            countries = len({r['iso3'] for r in rows})
            print(f"  {len(rows)} rows | {countries} countries | {span}", file=sys.stderr)
        all_rows.extend(rows)

    if not args.no_derived:
        absent = missing_inputs(all_rows)
        if absent:
            print(f"\nCalculated metrics limited - no data for: {', '.join(absent)}",
                  file=sys.stderr)
        derived_rows = compute_derived(all_rows)
        for code in DERIVED_BY_CODE:
            count = sum(1 for r in derived_rows if r["indicator_code"] == code)
            print(f"Calculated {code}: {count} rows", file=sys.stderr)
        all_rows.extend(derived_rows)

    if args.latest_only:
        all_rows = latest_per_series(all_rows)
    else:
        all_rows.sort(key=lambda r: (r["country"], r["indicator_code"], _year_key(r)))

    if not all_rows:
        print("No data written - every indicator came back empty.", file=sys.stderr)
        return 1

    write_long_csv(all_rows, args.out)
    print(f"\nWrote {len(all_rows)} rows to {args.out}", file=sys.stderr)
    if args.wide_out:
        write_wide_csv(all_rows, args.wide_out)
        print(f"Wrote wide matrix to {args.wide_out}", file=sys.stderr)
    if failed:
        print(f"Indicators that failed: {', '.join(failed)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
