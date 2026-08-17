/**
 * Listing + market-statistics layer over the bundled NY-House-Dataset.csv.
 *
 * This is the offline data source: real for-sale listings with prices, beds,
 * baths, sqft and coordinates, grouped into searchable areas so you can ask
 * "what does a 3-bed actually cost in Forest Hills" without any API key.
 */

import { readFile } from 'node:fs/promises';
import { parseCsvObjects, toNumber } from './csv.js';

const NOISE_TYPES = new Set(['Pending', 'Contingent', 'For sale', 'Foreclosure']);

/** "New York, NY 10022" -> "10022" */
function extractZip(stateField) {
  const m = /\b(\d{5})\b/.exec(stateField || '');
  return m ? m[1] : null;
}

/**
 * The source geocoder labeled the same place two ways -- half of Brooklyn is
 * filed under "Brooklyn" and half under "Kings County" -- which would split one
 * market into two entries with two different medians. Fold the county names
 * into the borough names people actually search for.
 */
const AREA_ALIASES = new Map([
  ['new york county', 'Manhattan'],
  ['kings county', 'Brooklyn'],
  ['queens county', 'Queens'],
  ['bronx county', 'The Bronx'],
  ['richmond county', 'Staten Island'],
  ['east bronx', 'The Bronx'],
]);

export function canonicalArea(name) {
  const key = (name || '').trim().toLowerCase();
  return AREA_ALIASES.get(key) || (name || '').trim();
}

/**
 * Rows carry the area name in different columns depending on how the original
 * geocoder resolved the address, so fall back through them in specificity
 * order rather than trusting any single column.
 */
function areaOf(row) {
  const raw =
    pick(row.SUBLOCALITY) ||
    pick(row.LOCALITY) ||
    pick(row.ADMINISTRATIVE_AREA_LEVEL_2) ||
    'Unknown';
  return canonicalArea(raw);
}

function pick(v) {
  const s = (v || '').trim();
  if (!s || s === 'United States' || s === 'New York') return '';
  // Some rows put a bare ZIP in the locality column; that is not an area name,
  // so let the fallback chain continue to a real one.
  if (/^\d{5}$/.test(s)) return '';
  return s;
}

function normalizeType(type) {
  const t = (type || '').trim();
  if (NOISE_TYPES.has(t)) return 'Other';
  return t.replace(/ for sale$/i, '') || 'Other';
}

/**
 * 1,577 of the 4,801 source rows carry this exact square footage. It is the
 * column mean, imputed by whoever assembled the dataset to fill in missing
 * values -- not a measurement. Left in, it drags every price-per-sqft median
 * toward a fictional number, so it is treated as missing.
 */
const IMPUTED_SQFT = 2184.207862;

function realSqft(sqft) {
  if (!sqft || sqft <= 100) return null;
  if (Math.abs(sqft - IMPUTED_SQFT) < 0.001) return null;
  return sqft;
}

export function normalizeRow(row) {
  const price = toNumber(row.PRICE);
  const sqft = realSqft(toNumber(row.PROPERTYSQFT));
  if (!price || price < 10_000) return null; // drop placeholder/garbage prices
  return {
    price,
    beds: toNumber(row.BEDS),
    baths: toNumber(row.BATH),
    sqft,
    type: normalizeType(row.TYPE),
    address: (row.FORMATTED_ADDRESS || row.ADDRESS || '').trim(),
    area: areaOf(row),
    zip: extractZip(row.STATE),
    broker: (row.BROKERTITLE || '').replace(/^Brokered by\s*/i, '').trim(),
    lat: toNumber(row.LATITUDE),
    lng: toNumber(row.LONGITUDE),
    source: 'ny-dataset',
  };
}

let cache = null;

export async function loadLocalListings(csvPath) {
  if (cache) return cache;
  const text = await readFile(csvPath, 'utf8');
  cache = parseCsvObjects(text).map(normalizeRow).filter(Boolean);
  return cache;
}

export function searchListings(listings, query = {}) {
  const {
    area,
    zip,
    minPrice = 0,
    maxPrice = Infinity,
    minBeds = 0,
    minBaths = 0,
    type,
    limit = 50,
    sort = 'price-asc',
  } = query;

  const needle = (area || '').trim().toLowerCase();
  let out = listings.filter((l) => {
    if (needle && !l.area.toLowerCase().includes(needle) && !l.address.toLowerCase().includes(needle))
      return false;
    if (zip && l.zip !== String(zip)) return false;
    if (l.price < minPrice || l.price > maxPrice) return false;
    if (minBeds && (l.beds ?? 0) < minBeds) return false;
    if (minBaths && (l.baths ?? 0) < minBaths) return false;
    if (type && l.type.toLowerCase() !== String(type).toLowerCase()) return false;
    return true;
  });

  const sorters = {
    'price-asc': (a, b) => a.price - b.price,
    'price-desc': (a, b) => b.price - a.price,
    'sqft-desc': (a, b) => (b.sqft ?? 0) - (a.sqft ?? 0),
    'ppsf-asc': (a, b) => ppsf(a) - ppsf(b),
  };
  out = out.sort(sorters[sort] || sorters['price-asc']);
  return { total: out.length, results: out.slice(0, limit) };
}

function ppsf(l) {
  return l.sqft ? l.price / l.sqft : Infinity;
}

export function median(nums) {
  const s = nums.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function percentile(nums, p) {
  const s = nums.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!s.length) return null;
  const idx = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
  return s[idx];
}

/**
 * Per-area price statistics -- this is what turns "areas I'm looking at" into a
 * number you can plug into the savings plan. Areas with very few listings are
 * still reported but flagged, since a median over 3 listings is not a market.
 */
export function areaStats(listings, { minCount = 5 } = {}) {
  const groups = new Map();
  for (const l of listings) {
    if (!groups.has(l.area)) groups.set(l.area, []);
    groups.get(l.area).push(l);
  }

  const stats = [];
  for (const [area, items] of groups) {
    const prices = items.map((i) => i.price);
    const ppsfs = items.filter((i) => i.sqft).map((i) => i.price / i.sqft);
    stats.push({
      area,
      count: items.length,
      medianPrice: median(prices),
      p25Price: percentile(prices, 25),
      p75Price: percentile(prices, 75),
      medianPricePerSqft: median(ppsfs),
      medianBeds: median(items.map((i) => i.beds)),
      thin: items.length < minCount,
    });
  }
  return stats.sort((a, b) => b.count - a.count);
}

/** Stats for one area, filtered to the shape of home you actually want. */
export function areaProfile(listings, { area, minBeds = 0, type } = {}) {
  const needle = canonicalArea(area).toLowerCase();
  const items = listings.filter(
    (l) =>
      l.area.toLowerCase() === needle &&
      (!minBeds || (l.beds ?? 0) >= minBeds) &&
      (!type || l.type.toLowerCase() === String(type).toLowerCase())
  );
  if (!items.length) return null;
  const prices = items.map((i) => i.price);
  return {
    area: canonicalArea(area),
    count: items.length,
    minBeds,
    type: type || 'any',
    medianPrice: median(prices),
    p25Price: percentile(prices, 25),
    p75Price: percentile(prices, 75),
    medianPricePerSqft: median(items.filter((i) => i.sqft).map((i) => i.price / i.sqft)),
    sample: items.sort((a, b) => a.price - b.price).slice(0, 5),
  };
}
