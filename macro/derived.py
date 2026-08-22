"""Derived metrics computed from the raw World Bank pulls.

Each metric is a ratio of two indicators observed for the same country and year.
Both inputs are expressed as % of GDP, so the GDP denominators cancel and the
result is a pure share of the banking system - reported here x100, i.e. as a
percentage of domestic credit provided by the financial sector.

Derived rows are appended to the same tidy long table as the raw indicators, so
in a pivot table they behave like any other indicator.
"""

from typing import Dict, List, Optional

# Values below this are treated as no-signal: dividing by a near-zero credit
# stock produces a ratio that is arithmetically true and analytically useless.
MIN_DENOMINATOR = 0.5

DERIVED_METRICS = [
    {
        "code": "CALC.BANK.SOV.SAT",
        "short_name": "Bank sovereign saturation",
        "theme": "Derived - sovereign exposure",
        "indicator_name": (
            "Bank sovereign saturation: claims on central government "
            "as % of domestic credit provided by the financial sector"
        ),
        "numerator": "FS.AST.CGOV.GD.ZS",
        "denominator": "FS.AST.DOMS.GD.ZS",
        "negate_numerator": False,
        "scale": 100.0,
    },
    {
        "code": "CALC.NEWDEF.BANK.SHARE",
        "short_name": "New deficit as % of banking system",
        "theme": "Derived - sovereign exposure",
        "indicator_name": (
            "New deficit as % of banking system: annual net borrowing "
            "as % of domestic credit provided by the financial sector"
        ),
        # GC.NLD.TOTL.GD.ZS is net lending (+) / net borrowing (-), so a deficit
        # arrives negative. Negating it makes "new deficit" read positive when
        # the government is borrowing, and negative when it runs a surplus.
        "numerator": "GC.NLD.TOTL.GD.ZS",
        "denominator": "FS.AST.DOMS.GD.ZS",
        "negate_numerator": True,
        "scale": 100.0,
    },
]

DERIVED_BY_CODE = {m["code"]: m for m in DERIVED_METRICS}
REQUIRED_INPUTS = sorted({
    code
    for metric in DERIVED_METRICS
    for code in (metric["numerator"], metric["denominator"])
})


def _series_key(row: dict) -> tuple:
    return (row["iso3"], row["year"])


def compute_derived(long_rows: List[dict],
                    metrics: Optional[List[dict]] = None) -> List[dict]:
    """Return derived long rows built from `long_rows`.

    A metric is emitted for a country-year only when both inputs are present and
    the denominator is meaningfully non-zero.
    """
    metrics = DERIVED_METRICS if metrics is None else metrics

    values: Dict[tuple, Dict[str, float]] = {}
    context: Dict[tuple, dict] = {}
    for row in long_rows:
        if row.get("value") is None or row.get("year") is None:
            continue
        key = _series_key(row)
        values.setdefault(key, {})[row["indicator_code"]] = row["value"]
        # Metadata is identical across a country's rows; first one wins.
        context.setdefault(key, row)

    out: List[dict] = []
    for metric in metrics:
        for key, observed in values.items():
            numerator = observed.get(metric["numerator"])
            denominator = observed.get(metric["denominator"])
            if numerator is None or denominator is None:
                continue
            if abs(denominator) < MIN_DENOMINATOR:
                continue
            if metric.get("negate_numerator"):
                numerator = -numerator

            base = context[key]
            out.append({
                "iso3": base["iso3"],
                "country": base["country"],
                "iso2": base["iso2"],
                "region": base["region"],
                "income_group": base["income_group"],
                "lending_type": base["lending_type"],
                "indicator_code": metric["code"],
                "indicator_name": metric["indicator_name"],
                "short_name": metric["short_name"],
                "theme": metric["theme"],
                "year": base["year"],
                "value": round(numerator / denominator * metric.get("scale", 1.0), 6),
            })

    out.sort(key=lambda r: (r["country"], r["indicator_code"], r["year"]))
    return out


def missing_inputs(long_rows: List[dict]) -> List[str]:
    """Input indicator codes that the pull did not return any values for."""
    present = {r["indicator_code"] for r in long_rows if r.get("value") is not None}
    return [code for code in REQUIRED_INPUTS if code not in present]
