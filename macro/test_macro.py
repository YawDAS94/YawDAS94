"""Offline tests for the macro pull.

These stub the HTTP layer with payloads shaped like real World Bank v2
responses, so the pagination, source-fallback, metadata join and ratio maths are
all exercised without touching the network.

    python -m unittest test_macro -v
"""

import csv
import os
import tempfile
import unittest
from unittest import mock

import fetch_macro
from derived import compute_derived, missing_inputs
from fetch_macro import (WorldBankClient, WorldBankError, _split_payload,
                         fetch_country_metadata, fetch_indicator, to_long_rows)

# --- fixtures -------------------------------------------------------------

COUNTRY_PAYLOAD = [
    {"page": 1, "pages": 1, "per_page": 50, "total": 4},
    [
        {"id": "USA", "iso2Code": "US", "name": "United States",
         "region": {"value": "North America"},
         "incomeLevel": {"value": "High income"},
         "lendingType": {"value": "Not classified"}},
        {"id": "GHA", "iso2Code": "GH", "name": "Ghana",
         "region": {"value": "Sub-Saharan Africa"},
         "incomeLevel": {"value": "Lower middle income"},
         "lendingType": {"value": "IDA"}},
        {"id": "BRA", "iso2Code": "BR", "name": "Brazil",
         "region": {"value": "Latin America & Caribbean"},
         "incomeLevel": {"value": "Upper middle income"},
         "lendingType": {"value": "IBRD"}},
        # Aggregates must be filtered out by default: they double-count members.
        {"id": "WLD", "iso2Code": "1W", "name": "World",
         "region": {"value": "Aggregates"},
         "incomeLevel": {"value": "Aggregates"},
         "lendingType": {"value": "Aggregates"}},
    ],
]

EMPTY_PAYLOAD = [{"page": 0, "pages": 0, "per_page": 0, "total": 0}, None]

ERROR_PAYLOAD = [{"message": [{"id": "120", "key": "Invalid value",
                               "value": "The provided parameter value is not valid"}]}]


def _obs(iso3, iso2, country, code, name, year, value, blank_iso3=False):
    return {
        "indicator": {"id": code, "value": name},
        "country": {"id": iso2, "value": country},
        "countryiso3code": "" if blank_iso3 else iso3,
        "date": str(year),
        "value": value,
        "unit": "", "obs_status": "", "decimal": 1,
    }


# Domestic credit provided by the financial sector (the shared denominator).
DOMS = "FS.AST.DOMS.GD.ZS"
CGOV = "FS.AST.CGOV.GD.ZS"
NLD = "GC.NLD.TOTL.GD.ZS"

INDICATOR_DATA = {
    DOMS: [
        _obs("USA", "US", "United States", DOMS, "Domestic credit provided by financial sector (% of GDP)", 2020, 250.0),
        _obs("USA", "US", "United States", DOMS, "Domestic credit provided by financial sector (% of GDP)", 2021, 200.0),
        _obs("GHA", "GH", "Ghana", DOMS, "Domestic credit provided by financial sector (% of GDP)", 2020, 40.0),
        _obs("WLD", "1W", "World", DOMS, "Domestic credit provided by financial sector (% of GDP)", 2020, 180.0),
        _obs("BRA", "BR", "Brazil", DOMS, "Domestic credit provided by financial sector (% of GDP)", 2020, 0.1),
    ],
    CGOV: [
        _obs("USA", "US", "United States", CGOV, "Net domestic credit to central government (% of GDP)", 2020, 50.0),
        _obs("USA", "US", "United States", CGOV, "Net domestic credit to central government (% of GDP)", 2021, None),
        _obs("GHA", "GH", "Ghana", CGOV, "Net domestic credit to central government (% of GDP)", 2020, 20.0),
        _obs("BRA", "BR", "Brazil", CGOV, "Net domestic credit to central government (% of GDP)", 2020, 5.0),
    ],
    NLD: [
        # Net lending (+) / net borrowing (-): USA runs a deficit, Ghana a surplus.
        _obs("USA", "US", "United States", NLD, "Net lending (+) / net borrowing (-) (% of GDP)", 2020, -12.5),
        _obs("GHA", "GH", "Ghana", NLD, "Net lending (+) / net borrowing (-) (% of GDP)", 2020, 2.0),
    ],
    # Served only by source 33, and with countryiso3code blank - both quirks real.
    "GFDD.OI.02": [
        _obs("USA", "US", "United States", "GFDD.OI.02", "Bank concentration (%)", 2020, 33.3, blank_iso3=True),
    ],
}


class FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


class FakeSession:
    """Serves World-Bank-shaped payloads and records the requests it saw."""

    def __init__(self):
        self.calls = []

    def get(self, url, params=None, timeout=None):
        params = params or {}
        self.calls.append((url, dict(params)))

        if url.endswith("/country"):
            return FakeResponse(COUNTRY_PAYLOAD)

        code = url.rsplit("/indicator/", 1)[-1]
        if code not in INDICATOR_DATA:
            return FakeResponse(EMPTY_PAYLOAD)

        # Observed live behaviour: GFDD codes are rejected outright when any
        # source is specified, and resolve against the API default.
        if code.startswith("GFDD.") and "source" in params:
            return FakeResponse(ERROR_PAYLOAD)

        rows = INDICATOR_DATA[code]
        # Serve DOMS two rows at a time to exercise the pagination loop.
        if code == DOMS:
            page = int(params.get("page", 1))
            size = 2
            pages = (len(rows) + size - 1) // size
            chunk = rows[(page - 1) * size: page * size]
            return FakeResponse([{"page": page, "pages": pages,
                                  "per_page": size, "total": len(rows)}, chunk])
        return FakeResponse([{"page": 1, "pages": 1, "per_page": 1000,
                              "total": len(rows)}, rows])


def build_client():
    return WorldBankClient(retries=1, backoff=0, session=FakeSession())


# --- tests ----------------------------------------------------------------

class TestPayloadParsing(unittest.TestCase):
    def test_error_payload_raises_with_detail(self):
        with self.assertRaises(WorldBankError) as ctx:
            _split_payload(ERROR_PAYLOAD)
        self.assertIn("not valid", str(ctx.exception))

    def test_empty_payload_returns_no_rows(self):
        meta, rows = _split_payload(EMPTY_PAYLOAD)
        self.assertIsNone(rows)
        self.assertEqual(meta["total"], 0)

    def test_malformed_payload_raises(self):
        for bad in ({}, [], "nope"):
            with self.assertRaises(WorldBankError):
                _split_payload(bad)


class TestFetching(unittest.TestCase):
    def test_pagination_collects_every_page(self):
        client = build_client()
        rows = client.paged_rows(f"country/all/indicator/{DOMS}", {"date": "2020:2021"})
        self.assertEqual(len(rows), len(INDICATOR_DATA[DOMS]))
        pages_seen = {c[1]["page"] for c in client.session.calls}
        self.assertEqual(pages_seen, {1, 2, 3})

    def test_rejected_source_does_not_abort_the_fallback(self):
        """A source that rejects the code must not stop later sources trying.

        Regression: treating "Invalid value" as fatal killed both GFDD
        indicators, which only resolve against the API default source.
        """
        client = build_client()
        rows = fetch_indicator(client, "GFDD.OI.02", "all", "2020:2020")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["value"], 33.3)

    def test_gfdd_declares_no_source(self):
        # Declaring source=33 is what broke these codes in the first place.
        from indicators import BY_CODE
        for code in ("GFDD.OI.02", "GFDD.SI.06"):
            self.assertIsNone(BY_CODE[code]["source"], code)

    def test_unknown_indicator_returns_empty_not_error(self):
        client = build_client()
        self.assertEqual(fetch_indicator(client, "NO.SUCH.CODE", "all", "2020:2020"), [])

    def test_retry_then_succeed(self):
        session = FakeSession()
        calls = {"n": 0}
        real_get = session.get

        def flaky(url, params=None, timeout=None):
            calls["n"] += 1
            if calls["n"] == 1:
                raise fetch_macro.requests.ConnectionError("boom")
            return real_get(url, params=params, timeout=timeout)

        session.get = flaky
        client = WorldBankClient(retries=3, backoff=0, session=session)
        self.assertEqual(len(fetch_country_metadata(client)), 4)
        self.assertEqual(calls["n"], 2)

    def test_gives_up_after_retries(self):
        session = FakeSession()
        session.get = mock.Mock(side_effect=fetch_macro.requests.ConnectionError("down"))
        client = WorldBankClient(retries=3, backoff=0, session=session)
        with self.assertRaises(WorldBankError):
            fetch_country_metadata(client)
        self.assertEqual(session.get.call_count, 3)


class TestLongRows(unittest.TestCase):
    def setUp(self):
        self.client = build_client()
        self.meta = fetch_country_metadata(self.client)
        self.iso2 = {m["iso2"]: m["iso3"] for m in self.meta.values() if m["iso2"]}

    def _long(self, code, **kwargs):
        rows = fetch_indicator(self.client, code, "all", "2020:2021")
        opts = {"include_aggregates": False, "keep_nulls": False}
        opts.update(kwargs)
        return to_long_rows(rows, code, self.meta, self.iso2, **opts)

    def test_metadata_is_joined(self):
        ghana = [r for r in self._long(DOMS) if r["iso3"] == "GHA"][0]
        self.assertEqual(ghana["region"], "Sub-Saharan Africa")
        self.assertEqual(ghana["income_group"], "Lower middle income")
        self.assertEqual(ghana["short_name"], "Domestic credit by financial sector / GDP")

    def test_short_names_match_the_api_names(self):
        """Guard against labels drifting from what the API actually returns.

        GFDD.OI.02 and GFDD.SI.06 shipped mislabelled: their codes suggest
        concentration and credit/deposit ratios, but the API serves bank
        deposits to GDP and a liquidity ratio.
        """
        from indicators import BY_CODE
        self.assertEqual(BY_CODE["GFDD.OI.02"]["short_name"], "Bank deposits / GDP")
        self.assertEqual(BY_CODE["GFDD.SI.06"]["short_name"],
                         "Liquid assets / deposits & ST funding")
        self.assertEqual(ghana["year"], 2020)
        self.assertIsInstance(ghana["year"], int)

    def test_aggregates_excluded_by_default(self):
        self.assertNotIn("WLD", {r["iso3"] for r in self._long(DOMS)})
        self.assertIn("WLD", {r["iso3"] for r in self._long(DOMS, include_aggregates=True)})

    def test_nulls_dropped_by_default(self):
        self.assertTrue(all(r["value"] is not None for r in self._long(CGOV)))
        self.assertTrue(any(r["value"] is None for r in self._long(CGOV, keep_nulls=True)))

    def test_blank_iso3_recovered_from_iso2(self):
        row = self._long("GFDD.OI.02")[0]
        self.assertEqual(row["iso3"], "USA")
        self.assertEqual(row["country"], "United States")


class TestDerived(unittest.TestCase):
    def setUp(self):
        client = build_client()
        meta = fetch_country_metadata(client)
        iso2 = {m["iso2"]: m["iso3"] for m in meta.values() if m["iso2"]}
        self.rows = []
        for code in (DOMS, CGOV, NLD):
            api_rows = fetch_indicator(client, code, "all", "2020:2021")
            self.rows.extend(to_long_rows(api_rows, code, meta, iso2, False, False))
        self.derived = compute_derived(self.rows)

    def _value(self, iso3, code, year):
        hits = [r for r in self.derived
                if r["iso3"] == iso3 and r["indicator_code"] == code and r["year"] == year]
        return hits[0]["value"] if hits else None

    def test_bank_sovereign_saturation(self):
        # USA 2020: 50.0 / 250.0 = 20% of the banking system lent to the sovereign.
        self.assertAlmostEqual(self._value("USA", "CALC.BANK.SOV.SAT", 2020), 20.0)
        # Ghana 2020: 20.0 / 40.0 = 50%.
        self.assertAlmostEqual(self._value("GHA", "CALC.BANK.SOV.SAT", 2020), 50.0)

    def test_deficit_sign_convention(self):
        # USA net lending -12.5 is a DEFICIT, so new deficit is positive: 12.5/250 = 5%.
        self.assertAlmostEqual(self._value("USA", "CALC.NEWDEF.BANK.SHARE", 2020), 5.0)
        # Ghana net lending +2.0 is a SURPLUS, so the metric goes negative.
        self.assertAlmostEqual(self._value("GHA", "CALC.NEWDEF.BANK.SHARE", 2020), -5.0)

    def test_tiny_denominator_suppressed(self):
        # Brazil's 0.1 denominator would yield a 5000% ratio; it must be dropped.
        self.assertIsNone(self._value("BRA", "CALC.BANK.SOV.SAT", 2020))

    def test_missing_input_year_produces_no_row(self):
        # USA 2021 has DOMS but a null CGOV, so saturation cannot be computed.
        self.assertIsNone(self._value("USA", "CALC.BANK.SOV.SAT", 2021))

    def test_aggregates_never_leak_into_derived(self):
        self.assertNotIn("WLD", {r["iso3"] for r in self.derived})

    def test_derived_rows_match_long_schema(self):
        for row in self.derived:
            self.assertEqual(sorted(row), sorted(fetch_macro.LONG_COLUMNS))

    def test_missing_inputs_reported(self):
        self.assertEqual(missing_inputs(self.rows), [])
        without_nld = [r for r in self.rows if r["indicator_code"] != NLD]
        self.assertEqual(missing_inputs(without_nld), [NLD])


class TestEndToEnd(unittest.TestCase):
    def test_main_writes_long_and_wide_csvs(self):
        tmp = tempfile.mkdtemp()
        long_path = os.path.join(tmp, "macro_long.csv")
        wide_path = os.path.join(tmp, "macro_wide.csv")

        with mock.patch.object(fetch_macro, "WorldBankClient",
                               lambda **kw: build_client()):
            code = fetch_macro.main([
                "--indicators", f"{DOMS},{CGOV},{NLD}",
                "--start", "2020", "--end", "2021",
                "--out", long_path, "--wide-out", wide_path,
            ])
        self.assertEqual(code, 0)

        with open(long_path, newline="", encoding="utf-8") as handle:
            rows = list(csv.DictReader(handle))
        self.assertEqual(list(rows[0]), fetch_macro.LONG_COLUMNS)

        codes = {r["indicator_code"] for r in rows}
        self.assertIn("CALC.BANK.SOV.SAT", codes)
        self.assertIn("CALC.NEWDEF.BANK.SHARE", codes)
        self.assertNotIn("World", {r["country"] for r in rows})

        usa = [r for r in rows if r["iso3"] == "USA"
               and r["indicator_code"] == "CALC.NEWDEF.BANK.SHARE"][0]
        self.assertAlmostEqual(float(usa["value"]), 5.0)

        with open(wide_path, newline="", encoding="utf-8") as handle:
            wide = list(csv.DictReader(handle))
        self.assertIn("2020", wide[0])
        self.assertIn("2021", wide[0])

    def test_no_derived_flag_skips_calculations(self):
        tmp = tempfile.mkdtemp()
        out = os.path.join(tmp, "raw.csv")
        with mock.patch.object(fetch_macro, "WorldBankClient",
                               lambda **kw: build_client()):
            fetch_macro.main(["--indicators", DOMS, "--start", "2020", "--end", "2021",
                              "--out", out, "--no-derived"])
        with open(out, newline="", encoding="utf-8") as handle:
            codes = {r["indicator_code"] for r in csv.DictReader(handle)}
        self.assertEqual(codes, {DOMS})

    def test_latest_only_keeps_newest_observation(self):
        tmp = tempfile.mkdtemp()
        out = os.path.join(tmp, "latest.csv")
        with mock.patch.object(fetch_macro, "WorldBankClient",
                               lambda **kw: build_client()):
            fetch_macro.main(["--indicators", DOMS, "--start", "2020", "--end", "2021",
                              "--out", out, "--no-derived", "--latest-only"])
        with open(out, newline="", encoding="utf-8") as handle:
            usa = [r for r in csv.DictReader(handle) if r["iso3"] == "USA"]
        self.assertEqual(len(usa), 1)
        self.assertEqual(usa[0]["year"], "2021")

    def test_bad_year_range_rejected(self):
        self.assertEqual(fetch_macro.main(["--start", "2020", "--end", "2010"]), 2)


if __name__ == "__main__":
    unittest.main()


class TestInvalidIndicator(unittest.TestCase):
    """A rejected indicator code must fail fast with an actionable message."""

    def setUp(self):
        self.session = FakeSession()
        self.session.get = mock.Mock(return_value=FakeResponse(ERROR_PAYLOAD))
        self.client = WorldBankClient(retries=1, backoff=0, session=self.session)

    def test_reports_the_offending_code_after_exhausting_sources(self):
        with self.assertRaises(WorldBankError) as ctx:
            fetch_indicator(self.client, "FI.RES.MDOT.MO", "all", "2000:2025")
        message = str(ctx.exception)
        self.assertIn("FI.RES.MDOT.MO", message)
        self.assertIn("data.worldbank.org/indicator", message)
        # Every candidate source is tried before the code is called bad.
        self.assertGreater(self.session.get.call_count, 1)

    def test_duplicate_api_messages_collapse(self):
        payload = [{"message": [
            {"id": "120", "key": "Invalid value", "value": "not valid"},
            {"id": "120", "key": "Invalid value", "value": "not valid"},
        ]}]
        with self.assertRaises(WorldBankError) as ctx:
            _split_payload(payload)
        self.assertEqual(str(ctx.exception).count("not valid"), 1)
        self.assertTrue(ctx.exception.invalid_parameter)

    def test_transient_error_is_not_flagged_invalid(self):
        payload = [{"message": [{"id": "500", "key": "Server", "value": "busy"}]}]
        with self.assertRaises(WorldBankError) as ctx:
            _split_payload(payload)
        self.assertFalse(ctx.exception.invalid_parameter)


class TestUnreachableApi(unittest.TestCase):
    def test_network_failure_exits_cleanly(self):
        """A dead network should give a readable message, not a traceback."""
        session = FakeSession()
        session.get = mock.Mock(
            side_effect=fetch_macro.requests.ConnectionError("tunnel failed"))
        client = WorldBankClient(retries=1, backoff=0, session=session)
        with mock.patch.object(fetch_macro, "WorldBankClient", lambda **kw: client):
            self.assertEqual(fetch_macro.main(["--out", "/dev/null"]), 3)
