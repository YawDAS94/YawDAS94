/**
 * Pluggable listing providers.
 *
 * Why this abstraction exists: there is no free, legal, general-purpose Zillow
 * feed. Every real option has a different catch (paid, partner-gated, or
 * unofficial), so the app treats "where listings come from" as swappable and
 * ships working offline data as the default. Each adapter maps its vendor's
 * payload onto the same normalized listing shape used by lib/listings.js:
 *
 *   { price, beds, baths, sqft, type, address, area, zip, source }
 *
 * Provider selection is by env var; nothing here is required to run the app.
 */

import { fetchRentcastListings, fetchRentcastMarket } from './rentcast.js';
import { fetchZillowRapidApi } from './zillowRapidApi.js';

export const PROVIDERS = {
  local: {
    id: 'local',
    label: 'Bundled NY listings (offline)',
    needsKey: false,
    note: '4,800 real New York for-sale listings included in this repo. Always available.',
  },
  rentcast: {
    id: 'rentcast',
    label: 'RentCast API',
    needsKey: 'RENTCAST_API_KEY',
    note: 'Nationwide for-sale listings + market stats. Free tier ~50 requests/month.',
    fetch: fetchRentcastListings,
    market: fetchRentcastMarket,
  },
  zillow_rapidapi: {
    id: 'zillow_rapidapi',
    label: 'Zillow via RapidAPI (unofficial)',
    needsKey: 'RAPIDAPI_KEY',
    note: 'Third-party scraper of Zillow. Not affiliated with Zillow; check its terms before relying on it.',
    fetch: fetchZillowRapidApi,
  },
};

/** Which providers are actually usable right now, given the env. */
export function providerStatus(env = process.env) {
  return Object.values(PROVIDERS).map((p) => ({
    id: p.id,
    label: p.label,
    note: p.note,
    keyVar: p.needsKey || null,
    available: !p.needsKey || Boolean(env[p.needsKey]),
  }));
}

export async function fetchFromProvider(id, query, env = process.env) {
  const provider = PROVIDERS[id];
  if (!provider) throw new Error(`Unknown provider: ${id}`);
  if (!provider.fetch) throw new Error(`Provider ${id} has no remote fetch`);
  if (provider.needsKey && !env[provider.needsKey]) {
    throw new Error(`${provider.label} needs ${provider.needsKey} in the environment`);
  }
  return provider.fetch(query, env);
}
