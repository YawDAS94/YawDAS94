"""Indicator catalogue for the macro pull.

Each entry maps a World Bank indicator code to a short, pivot-friendly label
and the API `source` id that serves it.

Source ids:
  2  = World Development Indicators (the default the API assumes)
  6  = International Debt Statistics
  33 = Global Financial Development

`source` is a hint, not a hard requirement: the fetcher retries without it (and
across the other known sources) when a request comes back empty, so a wrong
guess here costs one extra HTTP call rather than a missing indicator.
"""

INDICATORS = [
    {
        "code": "FS.AST.PRVT.GD.ZS",
        "short_name": "Private credit / GDP",
        "theme": "Financial depth",
        "source": 2,
    },
    {
        "code": "FS.AST.DOMS.GD.ZS",
        "short_name": "Domestic credit by financial sector / GDP",
        "theme": "Financial depth",
        "source": 2,
    },
    {
        "code": "FS.AST.CGOV.GD.ZS",
        "short_name": "Claims on central government / GDP",
        "theme": "Financial depth",
        "source": 2,
    },
    {
        "code": "GC.NLD.TOTL.GD.ZS",
        "short_name": "Net lending / net borrowing / GDP",
        "theme": "Fiscal balance",
        "source": 2,
    },
    {
        "code": "GFDD.OI.02",
        # The API returns "Bank deposits to GDP (%)" for this code - a depth
        # measure, not the bank-concentration series the code suggests.
        "short_name": "Bank deposits / GDP",
        "theme": "Financial depth",
        # Passing source=33 makes the API reject this code; the default works.
        "source": None,
    },
    {
        "code": "GFDD.SI.06",
        # The API returns "Liquid assets to deposits and short term funding (%)".
        "short_name": "Liquid assets / deposits & ST funding",
        "theme": "Financial stability",
        # Passing source=33 makes the API reject this code; the default works.
        "source": None,
    },
    {
        "code": "NY.GDS.TOTL.ZS",
        "short_name": "Gross domestic savings / GDP",
        "theme": "Savings & investment",
        "source": 2,
    },
    {
        "code": "BN.CAB.XOKA.GD.ZS",
        "short_name": "Current account balance / GDP",
        "theme": "External balance",
        "source": 2,
    },
    {
        "code": "FI.RES.TOTL.MO",
        "short_name": "Reserves in months of imports",
        "theme": "External buffers",
        "source": 2,
    },
    {
        "code": "DT.DOD.DECT.GN.ZS",
        "short_name": "External debt stocks / GNI",
        "theme": "External debt",
        "source": 6,
    },
    {
        "code": "DT.TDS.DECT.EX.ZS",
        "short_name": "Total debt service / exports",
        "theme": "External debt",
        "source": 6,
    },
]

# Sources tried, in order, when an indicator's declared source returns nothing.
FALLBACK_SOURCES = [2, 6, 33, 11, 15]

BY_CODE = {i["code"]: i for i in INDICATORS}
DEFAULT_CODES = [i["code"] for i in INDICATORS]
