/**
 * RentCast adapter (https://developers.rentcast.io).
 *
 * The most practical *legitimate* stand-in for Zillow listing data: real
 * nationwide for-sale inventory, published API, free tier. Requires
 * RENTCAST_API_KEY.
 *
 * Vendor response shapes drift over time; all the field-name coupling is
 * confined to mapListing() below so a change is a one-function fix.
 */

const BASE = 'https://api.rentcast.io/v1';

async function callRentcast(path, params, env) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    headers: { 'X-Api-Key': env.RENTCAST_API_KEY, Accept: 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`RentCast ${res.status}: ${body.slice(0, 200) || res.statusText}`);
  }
  return res.json();
}

function mapListing(item) {
  return {
    price: item.price ?? null,
    beds: item.bedrooms ?? null,
    baths: item.bathrooms ?? null,
    sqft: item.squareFootage ?? null,
    type: item.propertyType || 'Unknown',
    address: item.formattedAddress || [item.addressLine1, item.city, item.state].filter(Boolean).join(', '),
    area: item.city || item.county || 'Unknown',
    zip: item.zipCode ? String(item.zipCode) : null,
    lat: item.latitude ?? null,
    lng: item.longitude ?? null,
    daysOnMarket: item.daysOnMarket ?? null,
    listedDate: item.listedDate ?? null,
    source: 'rentcast',
  };
}

export async function fetchRentcastListings(query, env) {
  const data = await callRentcast(
    '/listings/sale',
    {
      city: query.city,
      state: query.state,
      zipCode: query.zip,
      bedrooms: query.minBeds || undefined,
      limit: Math.min(query.limit || 50, 500),
      status: 'Active',
    },
    env
  );
  const items = Array.isArray(data) ? data : data.listings || [];
  return items.map(mapListing).filter((l) => l.price);
}

/**
 * Market-level sale stats for a ZIP. Used to seed the appreciation assumption
 * and the "typical price in this area" figure with something observed rather
 * than guessed.
 */
export async function fetchRentcastMarket(query, env) {
  const data = await callRentcast('/markets', { zipCode: query.zip, dataType: 'Sale' }, env);
  const sale = data.saleData || data;
  return {
    zip: query.zip,
    medianPrice: sale.medianPrice ?? null,
    averagePrice: sale.averagePrice ?? null,
    medianPricePerSqft: sale.medianPricePerSquareFoot ?? null,
    totalListings: sale.totalListings ?? null,
    source: 'rentcast',
  };
}
