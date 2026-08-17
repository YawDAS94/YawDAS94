/**
 * Zillow-via-RapidAPI adapter (unofficial).
 *
 * IMPORTANT: this is a third-party scraper resold on RapidAPI, not a Zillow
 * product and not endorsed by Zillow. Zillow's own API (Bridge Interactive) is
 * restricted to MLS/brokerage partners, and scraping zillow.com directly
 * violates their terms and gets IP-blocked. If you need Zillow data with a
 * clean license, apply for Bridge access; otherwise prefer RentCast.
 *
 * Enabled only when RAPIDAPI_KEY is set.
 */

const HOST = process.env.RAPIDAPI_ZILLOW_HOST || 'zillow-com1.p.rapidapi.com';

function mapListing(item) {
  return {
    price: item.price ?? null,
    beds: item.bedrooms ?? null,
    baths: item.bathrooms ?? null,
    sqft: item.livingArea ?? null,
    type: item.propertyType || item.homeType || 'Unknown',
    address: item.address || '',
    area: item.addressCity || 'Unknown',
    zip: item.addressZipcode ? String(item.addressZipcode) : null,
    lat: item.latitude ?? null,
    lng: item.longitude ?? null,
    zpid: item.zpid ?? null,
    source: 'zillow-rapidapi',
  };
}

export async function fetchZillowRapidApi(query, env) {
  const url = new URL(`https://${HOST}/propertyExtendedSearch`);
  url.searchParams.set('location', query.location || [query.city, query.state].filter(Boolean).join(', '));
  url.searchParams.set('status_type', 'ForSale');
  if (query.minPrice) url.searchParams.set('minPrice', String(query.minPrice));
  if (query.maxPrice) url.searchParams.set('maxPrice', String(query.maxPrice));
  if (query.minBeds) url.searchParams.set('bedsMin', String(query.minBeds));

  const res = await fetch(url, {
    headers: { 'X-RapidAPI-Key': env.RAPIDAPI_KEY, 'X-RapidAPI-Host': HOST },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Zillow/RapidAPI ${res.status}: ${body.slice(0, 200) || res.statusText}`);
  }
  const data = await res.json();
  return (data.props || []).map(mapListing).filter((l) => l.price);
}
