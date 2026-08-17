import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCsv, parseCsvObjects, toNumber } from '../lib/csv.js';
import { loadLocalListings, searchListings, areaStats, areaProfile, normalizeRow, median } from '../lib/listings.js';
import { estimateTakeHome, federalIncomeTax, ficaTax, importIncomeCsv, annualize } from '../lib/income.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CSV = join(__dirname, '..', '..', 'NY-House-Dataset.csv');

const near = (a, b, tol, msg) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ~${b}, got ${a}`);

test('parseCsv keeps commas inside quoted fields together', () => {
  const rows = parseCsv('a,b\n"New York, NY 10022",5\n');
  assert.deepEqual(rows[1], ['New York, NY 10022', '5']);
});

test('parseCsv handles escaped quotes and CRLF', () => {
  const rows = parseCsv('a,b\r\n"He said ""hi""",2\r\n');
  assert.deepEqual(rows[1], ['He said "hi"', '2']);
});

test('parseCsvObjects keys rows by header', () => {
  const objs = parseCsvObjects('PRICE,BEDS\n315000,2\n');
  assert.equal(objs[0].PRICE, '315000');
  assert.equal(objs[0].BEDS, '2');
});

test('toNumber strips currency formatting', () => {
  assert.equal(toNumber('$1,250,000'), 1250000);
  assert.equal(toNumber('6.5%'), 6.5);
  assert.equal(toNumber(''), null);
  assert.equal(toNumber('not a number'), null);
});

test('normalizeRow extracts zip and cleans the property type', () => {
  const row = {
    PRICE: '315000',
    BEDS: '2',
    BATH: '2',
    PROPERTYSQFT: '1400',
    TYPE: 'Condo for sale',
    STATE: 'New York, NY 10022',
    SUBLOCALITY: 'Manhattan',
    FORMATTED_ADDRESS: '2 E 55th St, New York, NY 10022, USA',
    BROKERTITLE: 'Brokered by Douglas Elliman',
  };
  const l = normalizeRow(row);
  assert.equal(l.zip, '10022');
  assert.equal(l.type, 'Condo');
  assert.equal(l.area, 'Manhattan');
  assert.equal(l.broker, 'Douglas Elliman');
  assert.equal(l.price, 315000);
});

test('normalizeRow drops rows with junk prices', () => {
  assert.equal(normalizeRow({ PRICE: '0', STATE: '' }), null);
  assert.equal(normalizeRow({ PRICE: '', STATE: '' }), null);
});

test('median handles even and odd counts', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
});

test('the bundled dataset loads and parses into usable listings', async () => {
  const listings = await loadLocalListings(CSV);
  assert.ok(listings.length > 4_000, `expected thousands of listings, got ${listings.length}`);
  assert.ok(listings.every((l) => l.price > 0));
  const withZip = listings.filter((l) => l.zip).length;
  assert.ok(withZip / listings.length > 0.9, 'most rows should yield a zip code');
});

test('searchListings filters by price, beds and area', async () => {
  const listings = await loadLocalListings(CSV);
  const { results } = searchListings(listings, {
    minPrice: 400_000,
    maxPrice: 900_000,
    minBeds: 2,
    limit: 25,
  });
  assert.ok(results.length > 0);
  for (const r of results) {
    assert.ok(r.price >= 400_000 && r.price <= 900_000);
    assert.ok((r.beds ?? 0) >= 2);
  }
  // price-asc is the default ordering
  const prices = results.map((r) => r.price);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
});

test('searchListings honors the result limit and reports the true total', async () => {
  const listings = await loadLocalListings(CSV);
  const res = searchListings(listings, { limit: 10 });
  assert.equal(res.results.length, 10);
  assert.ok(res.total > 10, 'total should count every match, not just the page');
});

test('areaStats produces medians for real neighborhoods', async () => {
  const listings = await loadLocalListings(CSV);
  const stats = areaStats(listings).filter((s) => !s.thin);
  assert.ok(stats.length > 5, 'dataset should cover several areas');
  const top = stats[0];
  assert.ok(top.medianPrice > 0);
  assert.ok(top.p25Price <= top.medianPrice && top.medianPrice <= top.p75Price);
});

test('areaProfile narrows to the home shape you actually want', async () => {
  const listings = await loadLocalListings(CSV);
  const all = areaProfile(listings, { area: 'Manhattan' });
  const family = areaProfile(listings, { area: 'Manhattan', minBeds: 3 });
  assert.ok(all, 'Manhattan should be present in the dataset');
  assert.ok(family.count < all.count, 'the 3-bed filter must narrow the set');
  assert.ok(family.medianPrice >= all.medianPrice, '3-beds should not be cheaper than everything');
  assert.ok(family.sample.length > 0);
});

test('areaProfile returns null for an unknown area', async () => {
  const listings = await loadLocalListings(CSV);
  assert.equal(areaProfile(listings, { area: 'Atlantis' }), null);
});

test('federal income tax follows the bracket schedule', () => {
  assert.equal(federalIncomeTax(0, 'married'), 0);
  // First bracket only: 10% of 20,000
  near(federalIncomeTax(20_000, 'married'), 2_000, 1);
  // Straddles 10% and 12%: 23,850*.10 + (50,000-23,850)*.12
  near(federalIncomeTax(50_000, 'married'), 2_385 + 3_138, 1);
});

test('FICA respects the per-earner Social Security wage base', () => {
  // Two earners at $150k each stay under the base; one earner at $300k does not.
  const split = ficaTax([150_000, 150_000], 'married');
  const single = ficaTax([300_000], 'married');
  assert.ok(split > single, 'splitting income across earners owes more Social Security tax');
});

test('estimateTakeHome nets down a two-income household', () => {
  const r = estimateTakeHome({
    incomes: [{ annual: 110_000 }, { annual: 95_000 }],
    filingStatus: 'married',
    stateTaxPct: 5,
  });
  assert.equal(r.gross, 205_000);
  assert.ok(r.net < r.gross && r.net > r.gross * 0.5, 'net should be a plausible fraction of gross');
  assert.ok(r.effectiveRate > 0.15 && r.effectiveRate < 0.45);
  near(r.monthlyNet, r.net / 12, 0.01);
});

test('estimateTakeHome honors an explicit effective-rate override', () => {
  const r = estimateTakeHome({ incomes: [{ annual: 100_000 }], effectiveTaxRateOverride: 25 });
  assert.equal(r.net, 75_000);
  assert.equal(r.method, 'override');
});

test('pre-tax retirement contributions reduce the tax bill', () => {
  const base = { incomes: [{ annual: 150_000 }], filingStatus: 'single' };
  const without = estimateTakeHome(base);
  const with401k = estimateTakeHome({ ...base, pretaxRetirementAnnual: 23_000 });
  assert.ok(with401k.federal < without.federal, '401(k) contributions cut federal tax');
});

test('annualize converts pay frequency', () => {
  assert.equal(annualize(2_000, 'biweekly'), 52_000);
  assert.equal(annualize(5_000, 'monthly'), 60_000);
});

test('importIncomeCsv infers biweekly payroll from a bank export', () => {
  const csv = [
    'Date,Description,Amount',
    '2026-01-02,ACME CORP PAYROLL DIRECT DEP,3200.00',
    '2026-01-16,ACME CORP PAYROLL DIRECT DEP,3200.00',
    '2026-01-30,ACME CORP PAYROLL DIRECT DEP,3200.00',
    '2026-02-13,ACME CORP PAYROLL DIRECT DEP,3200.00',
    '2026-01-05,Coffee shop,-6.50',
    '2026-01-09,Refund,45.00',
  ].join('\n');

  const { streams } = importIncomeCsv(csv);
  const payroll = streams.find((s) => /acme/i.test(s.label));
  assert.ok(payroll, 'should detect the payroll stream');
  assert.equal(payroll.frequency, 'biweekly');
  assert.equal(payroll.confidence, 'high');
  near(payroll.annual, 3_200 * 26, 1);
  assert.ok(!streams.some((s) => /coffee/i.test(s.label)), 'debits are not income');
});

test('importIncomeCsv reports a warning when nothing recurring is found', () => {
  const { streams, warnings } = importIncomeCsv('Date,Description,Amount\n2026-01-02,One off,5000');
  assert.equal(streams.length, 0);
  assert.ok(warnings.length > 0);
});

test('importIncomeCsv tolerates alternate header names', () => {
  const csv = [
    'Transaction Date,Merchant,Credit',
    '2026-03-01,Globex Salary,5000',
    '2026-04-01,Globex Salary,5000',
    '2026-05-01,Globex Salary,5000',
  ].join('\n');
  const { streams } = importIncomeCsv(csv);
  assert.equal(streams.length, 1);
  assert.equal(streams[0].frequency, 'monthly');
  near(streams[0].annual, 60_000, 1);
});

test('canonicalArea folds county names into borough names', async () => {
  const { canonicalArea } = await import('../lib/listings.js');
  assert.equal(canonicalArea('Kings County'), 'Brooklyn');
  assert.equal(canonicalArea('New York County'), 'Manhattan');
  assert.equal(canonicalArea('Queens County'), 'Queens');
  assert.equal(canonicalArea('Hoboken'), 'Hoboken', 'unknown names pass through');
});

test('boroughs are not split across duplicate area names', async () => {
  const listings = await loadLocalListings(CSV);
  const names = new Set(areaStats(listings).map((s) => s.area));
  assert.ok(names.has('Brooklyn'));
  assert.ok(!names.has('Kings County'), 'county alias should be merged away');
  assert.ok(!names.has('Queens County'));
  assert.ok(![...names].some((n) => /^\d{5}$/.test(n)), 'a bare zip is not an area name');
});

test('the imputed placeholder square footage is treated as missing', async () => {
  const listings = await loadLocalListings(CSV);
  const imputed = listings.filter((l) => l.sqft && Math.abs(l.sqft - 2184.207862) < 0.001);
  assert.equal(imputed.length, 0, 'the column-mean placeholder must not be reported as real sqft');
  assert.ok(listings.some((l) => l.sqft), 'genuine square footages should survive');
});

test('summarizeAssets excludes retirement money from the down payment by default', async () => {
  const { summarizeAssets } = await import('../lib/income.js');
  const s = summarizeAssets([
    { type: 'checking', amount: 12_000 },
    { type: 'savings', amount: 48_000 },
    { type: 'retirement', amount: 180_000 },
    { type: 'roth', amount: 30_000 },
  ]);
  assert.equal(s.usable, 60_000, 'only spendable cash funds the purchase');
  assert.equal(s.locked, 210_000);
  assert.equal(s.total, 270_000, 'excluded money is still reported, not dropped');
});

test('summarizeAssets honors a per-account override', async () => {
  const { summarizeAssets } = await import('../lib/income.js');
  // Roth contributions genuinely are withdrawable, so the override must win.
  const s = summarizeAssets([
    { type: 'savings', amount: 20_000 },
    { type: 'roth', amount: 15_000, usable: true },
    { type: 'checking', amount: 5_000, usable: false },
  ]);
  assert.equal(s.usable, 35_000);
  assert.equal(s.locked, 5_000);
});

test('summarizeAssets ignores blank and negative rows', async () => {
  const { summarizeAssets } = await import('../lib/income.js');
  const s = summarizeAssets([{ type: 'savings', amount: 0 }, { type: 'checking', amount: -5 }, {}]);
  assert.equal(s.total, 0);
});

test('annualize covers every offered pay frequency', async () => {
  const { PAY_FREQUENCIES, annualize } = await import('../lib/income.js');
  for (const f of PAY_FREQUENCIES) {
    assert.ok(annualize(100, f.id) > 0, `${f.id} should convert`);
  }
  assert.equal(annualize(3_000, 'semimonthly'), 72_000);
  assert.equal(annualize(1_500, 'weekly'), 78_000);
});
