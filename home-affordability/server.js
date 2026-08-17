/**
 * Zero-dependency HTTP server: static UI + JSON API.
 *
 * No npm install, no build step -- `node server.js` and open the browser.
 * Everything runs locally; income figures never leave the machine.
 */

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPlan, yearsUntilAffordable, maxAffordablePrice, housingCost } from './lib/affordability.js';
import { loadLocalListings, searchListings, areaStats, areaProfile } from './lib/listings.js';
import { estimateTakeHome, importIncomeCsv } from './lib/income.js';
import { providerStatus, fetchFromProvider, PROVIDERS } from './lib/providers/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
const DATA_DIR = join(__dirname, 'data');
const SCENARIOS_FILE = join(DATA_DIR, 'scenarios.json');
const PORT = Number(process.env.PORT) || 4173;

// The listing CSV lives at the repo root (it predates this app).
const LISTINGS_CSV = process.env.LISTINGS_CSV || join(__dirname, '..', 'NY-House-Dataset.csv');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readBody(req, limitBytes = 5_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJsonBody(req) {
  const text = await readBody(req);
  if (!text.trim()) return {};
  return JSON.parse(text);
}

async function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  // normalize() collapses ../ so a crafted path cannot escape PUBLIC_DIR.
  const filePath = join(PUBLIC_DIR, normalize(rel));
  if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  const data = await readFile(filePath);
  res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
  res.end(data);
}

async function loadScenarios() {
  if (!existsSync(SCENARIOS_FILE)) return [];
  try {
    return JSON.parse(await readFile(SCENARIOS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

async function saveScenarios(list) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(SCENARIOS_FILE, JSON.stringify(list, null, 2));
}

function num(v, fallback = undefined) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const routes = {
  'GET /api/health': async (_req, res) => sendJson(res, 200, { ok: true, port: PORT }),

  'GET /api/providers': async (_req, res) =>
    sendJson(res, 200, {
      providers: providerStatus(),
      note: 'Providers marked unavailable just need their API key exported. The bundled source always works.',
    }),

  'GET /api/areas': async (_req, res, url) => {
    const listings = await loadLocalListings(LISTINGS_CSV);
    const minCount = num(url.searchParams.get('minCount'), 5);
    const stats = areaStats(listings, { minCount }).filter((s) => !s.thin);
    sendJson(res, 200, { count: stats.length, areas: stats });
  },

  'GET /api/area-profile': async (_req, res, url) => {
    const listings = await loadLocalListings(LISTINGS_CSV);
    const profile = areaProfile(listings, {
      area: url.searchParams.get('area'),
      minBeds: num(url.searchParams.get('minBeds'), 0),
      type: url.searchParams.get('type') || undefined,
    });
    if (!profile) return sendJson(res, 404, { error: 'No listings match that area/filter' });
    sendJson(res, 200, profile);
  },

  'GET /api/listings': async (_req, res, url) => {
    const provider = url.searchParams.get('provider') || 'local';
    const query = {
      area: url.searchParams.get('area') || undefined,
      city: url.searchParams.get('city') || url.searchParams.get('area') || undefined,
      state: url.searchParams.get('state') || undefined,
      zip: url.searchParams.get('zip') || undefined,
      location: url.searchParams.get('location') || undefined,
      minPrice: num(url.searchParams.get('minPrice'), 0),
      maxPrice: num(url.searchParams.get('maxPrice'), Infinity),
      minBeds: num(url.searchParams.get('minBeds'), 0),
      minBaths: num(url.searchParams.get('minBaths'), 0),
      type: url.searchParams.get('type') || undefined,
      sort: url.searchParams.get('sort') || 'price-asc',
      limit: num(url.searchParams.get('limit'), 50),
    };

    if (provider === 'local') {
      const listings = await loadLocalListings(LISTINGS_CSV);
      return sendJson(res, 200, { provider, ...searchListings(listings, query) });
    }
    if (!PROVIDERS[provider]) return sendJson(res, 400, { error: `Unknown provider: ${provider}` });
    try {
      const results = await fetchFromProvider(provider, query);
      sendJson(res, 200, { provider, total: results.length, results });
    } catch (err) {
      // A missing key or a vendor outage should degrade, not crash the page.
      sendJson(res, 502, { error: String(err.message), provider });
    }
  },

  'POST /api/plan': async (req, res) => {
    const input = await readJsonBody(req);
    if (!num(input.targetPrice)) return sendJson(res, 400, { error: 'targetPrice is required' });
    if (num(input.years) === undefined) return sendJson(res, 400, { error: 'years is required' });
    sendJson(res, 200, buildPlan(input));
  },

  'POST /api/when': async (req, res) => {
    const input = await readJsonBody(req);
    if (!num(input.monthlySavingsBudget)) {
      return sendJson(res, 400, { error: 'monthlySavingsBudget is required' });
    }
    const found = yearsUntilAffordable(input, num(input.maxYears, 30));
    if (!found) {
      return sendJson(res, 200, {
        reachable: false,
        message:
          'At that savings rate the target stays out of reach within 30 years -- home prices grow faster than the contributions.',
      });
    }
    sendJson(res, 200, { reachable: true, ...found });
  },

  'POST /api/max-price': async (req, res) => {
    const input = await readJsonBody(req);
    sendJson(res, 200, maxAffordablePrice(input));
  },

  'POST /api/housing-cost': async (req, res) => {
    const input = await readJsonBody(req);
    sendJson(res, 200, housingCost(input));
  },

  'POST /api/takehome': async (req, res) => {
    const input = await readJsonBody(req);
    sendJson(res, 200, estimateTakeHome(input));
  },

  'POST /api/income/import': async (req, res) => {
    const text = await readBody(req);
    sendJson(res, 200, importIncomeCsv(text));
  },

  'GET /api/scenarios': async (_req, res) => sendJson(res, 200, { scenarios: await loadScenarios() }),

  'POST /api/scenarios': async (req, res) => {
    const body = await readJsonBody(req);
    const scenarios = await loadScenarios();
    const entry = {
      id: `s_${Date.now().toString(36)}`,
      name: body.name || 'Untitled scenario',
      savedAt: new Date().toISOString(),
      input: body.input || {},
    };
    scenarios.push(entry);
    await saveScenarios(scenarios);
    sendJson(res, 201, entry);
  },

  'DELETE /api/scenarios': async (_req, res, url) => {
    const id = url.searchParams.get('id');
    const scenarios = await loadScenarios();
    const next = scenarios.filter((s) => s.id !== id);
    await saveScenarios(next);
    sendJson(res, 200, { deleted: scenarios.length - next.length });
  },
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const key = `${req.method} ${url.pathname}`;
  try {
    const handler = routes[key];
    if (handler) return await handler(req, res, url);
    if (req.method === 'GET') return await serveStatic(res, url.pathname);
    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    sendJson(res, 500, { error: String(err.message) });
  }
});

server.listen(PORT, () => {
  console.log(`Home affordability planner -> http://localhost:${PORT}`);
  const available = providerStatus()
    .filter((p) => p.available)
    .map((p) => p.id)
    .join(', ');
  console.log(`Listing providers available: ${available}`);
});
