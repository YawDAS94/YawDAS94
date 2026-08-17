/**
 * UI controller. All math lives on the server (lib/affordability.js) so the
 * numbers on screen are the same ones the unit tests cover.
 */

const $ = (id) => document.getElementById(id);
const money = (n) =>
  n === null || n === undefined || !Number.isFinite(n)
    ? '—'
    : n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const money2 = (n) =>
  !Number.isFinite(n) ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const pct = (n) => (Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : '—');

const state = {
  incomes: [
    { label: 'Me', annual: 110000 },
    { label: 'Spouse', annual: 95000 },
  ],
  takeHome: null,
  plan: null,
};

async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/* ----------------------------- input plumbing ----------------------------- */

function numOf(id) {
  const el = $(id);
  const n = Number(el.value);
  return Number.isFinite(n) ? n : 0;
}

function collectInput() {
  return {
    targetPrice: numOf('targetPrice'),
    years: numOf('years'),
    downPaymentPct: numOf('downPaymentPct'),
    appreciationPct: numOf('appreciationPct'),
    futureRatePct: numOf('futureRatePct'),
    termYears: numOf('termYears'),
    propertyTaxPct: numOf('propertyTaxPct'),
    hoaMonthly: numOf('hoaMonthly'),
    closingCostPct: numOf('closingCostPct'),
    incomes: state.incomes,
    raisePct: numOf('raisePct'),
    monthlyDebts: numOf('monthlyDebts'),
    currentSavings: numOf('currentSavings'),
    savingsReturnPct: numOf('savingsReturnPct'),
    monthlyExpenses: numOf('monthlyExpenses'),
    currentRent: numOf('currentRent'),
    monthlyTakeHome: state.takeHome ? state.takeHome.monthlyNet : null,
  };
}

function renderIncomeRows() {
  const box = $('incomeRows');
  box.innerHTML = '';
  state.incomes.forEach((inc, idx) => {
    const row = document.createElement('div');
    row.className = 'income-row';

    const name = document.createElement('input');
    name.type = 'text';
    name.value = inc.label;
    name.placeholder = 'Name';
    name.addEventListener('input', () => {
      state.incomes[idx].label = name.value;
    });

    const amount = document.createElement('input');
    amount.type = 'number';
    amount.step = '1000';
    amount.min = '0';
    amount.value = inc.annual;
    amount.title = 'Gross annual income';
    amount.addEventListener('input', () => {
      state.incomes[idx].annual = Number(amount.value) || 0;
      scheduleRecompute();
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = 'Remove earner';
    remove.addEventListener('click', () => {
      state.incomes.splice(idx, 1);
      renderIncomeRows();
      scheduleRecompute();
    });

    row.append(name, amount, remove);
    box.append(row);
  });
}

/* -------------------------------- computing ------------------------------- */

let timer = null;
function scheduleRecompute() {
  clearTimeout(timer);
  timer = setTimeout(recompute, 180);
}

async function recompute() {
  try {
    state.takeHome = await api('/api/takehome', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        incomes: state.incomes,
        filingStatus: $('filingStatus').value,
        stateTaxPct: numOf('stateTaxPct'),
        pretaxRetirementAnnual: numOf('pretaxRetirementAnnual'),
      }),
    });
    renderTakeHome();

    state.plan = await api('/api/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(collectInput()),
    });
    renderPlan(state.plan);
  } catch (err) {
    $('verdict').className = 'verdict out-of-reach';
    $('verdict').innerHTML = `<h2>Could not compute</h2><p>${err.message}</p>`;
  }
}

function renderTakeHome() {
  const t = state.takeHome;
  $('takeHomeBox').innerHTML =
    `<strong>${money(t.gross)}</strong> gross · <strong>${money(t.monthlyNet)}/mo</strong> estimated take-home` +
    `<br /><span class="hint">Effective tax rate ${pct(t.effectiveRate)} (federal + FICA + state)</span>`;
}

/* -------------------------------- rendering ------------------------------- */

function renderPlan(plan) {
  const v = $('verdict');
  v.className = `verdict ${plan.verdict.level}`;
  v.innerHTML = `<h2>${plan.verdict.headline}</h2><p>${plan.verdict.detail}</p>`;

  $('statMonthly').textContent = money(plan.monthlySavingsNeeded);
  $('statMonthlySub').textContent =
    plan.surplus === null
      ? `for ${plan.years} years`
      : `for ${plan.years} years · surplus is ${money(plan.surplus)}/mo`;

  $('statCash').textContent = money(plan.cash.total);
  $('statCashSub').textContent = `${money(plan.cash.downPayment)} down + costs + reserves`;

  $('statPrice').textContent = money(plan.projectedPrice);
  $('statPriceSub').textContent = `${money(plan.targetPrice)} today · +${money(plan.priceGrowth)} growth`;

  $('statPayment').textContent = money(plan.cost.total);
  $('statPaymentSub').textContent =
    plan.rentDelta === null
      ? `${pct(plan.frontEndActual)} of income`
      : `${money(Math.abs(plan.rentDelta))}/mo ${plan.rentDelta >= 0 ? 'more' : 'less'} than rent now`;

  renderTable($('cashTable'), [
    ['Down payment', plan.cash.downPayment],
    ['Closing costs', plan.cash.closingCosts],
    ['Reserves held back', plan.cash.reserves],
    ['Total cash needed', plan.cash.total, true],
  ]);

  renderTable($('costTable'), [
    ['Principal & interest', plan.cost.principalInterest],
    ['Property tax', plan.cost.propertyTax],
    ['Insurance', plan.cost.insurance],
    ['HOA', plan.cost.hoa],
    ['PMI', plan.cost.pmi],
    ['Total monthly', plan.cost.total, true],
  ]);

  renderChecks(plan);
  renderChart(plan);
}

function renderTable(table, rows) {
  table.innerHTML = rows
    .filter(([, value], i) => value > 0 || i === rows.length - 1)
    .map(
      ([label, value, isTotal]) =>
        `<tr class="${isTotal ? 'total' : ''}"><td>${label}</td><td>${money2(value)}</td></tr>`
    )
    .join('');
}

function renderChecks(plan) {
  const checks = [];

  const dtiOk = plan.backEndActual <= 0.36;
  checks.push({
    level: dtiOk ? 'ok' : plan.backEndActual <= 0.43 ? 'warn' : 'bad',
    text: `Debt-to-income at purchase is <strong>${pct(plan.backEndActual)}</strong>. Conventional loans want 36% or under; some programs stretch to 43%.`,
  });

  checks.push({
    level: plan.frontEndActual <= 0.28 ? 'ok' : 'warn',
    text: `Housing costs <strong>${pct(plan.frontEndActual)}</strong> of gross income. The classic guideline is 28%.`,
  });

  if (plan.surplus !== null) {
    const gap = plan.monthlySavingsNeeded - plan.surplus;
    checks.push({
      level: gap <= 0 ? 'ok' : 'bad',
      text:
        gap <= 0
          ? `Saving <strong>${money(plan.monthlySavingsNeeded)}/mo</strong> fits inside your <strong>${money(plan.surplus)}</strong> surplus, leaving ${money(-gap)} of slack.`
          : `You need <strong>${money(gap)}/mo</strong> more than your current surplus of ${money(plan.surplus)}.`,
    });
  }

  checks.push({
    level: plan.priceGap <= 0 ? 'ok' : 'bad',
    text:
      plan.priceGap <= 0
        ? `A lender should support up to <strong>${money(plan.maxAffordableAtPurchase)}</strong> by then — comfortably above this house.`
        : `A lender would support about <strong>${money(plan.maxAffordableAtPurchase)}</strong>, which is <strong>${money(plan.priceGap)}</strong> short of this house.`,
  });

  if (plan.cost.pmi > 0) {
    checks.push({
      level: 'warn',
      text: `Under 20% down, so PMI adds <strong>${money(plan.cost.pmi)}/mo</strong> until you reach 20% equity.`,
    });
  }

  checks.push({
    level: 'warn',
    text: `Assumes the home appreciates ${$('appreciationPct').value}%/yr and rates are ${$('futureRatePct').value}% when you buy. Both are guesses — try worse ones.`,
  });

  $('checks').innerHTML = checks
    .map((c) => `<li class="${c.level}"><span class="mark">${c.level === 'ok' ? '✓' : c.level === 'warn' ? '!' : '✕'}</span><span>${c.text}</span></li>`)
    .join('');
}

/* ---------------------------------- chart --------------------------------- */

function renderChart(plan) {
  const W = 720;
  const H = 260;
  const pad = { l: 62, r: 16, t: 16, b: 28 };
  const pts = plan.schedule;
  if (!pts.length) return;

  const maxY = Math.max(plan.cash.total, ...pts.map((p) => p.balance)) * 1.08 || 1;
  const maxX = pts.at(-1).month || 1;
  const x = (m) => pad.l + (m / maxX) * (W - pad.l - pad.r);
  const y = (v) => H - pad.b - (v / maxY) * (H - pad.t - pad.b);

  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.month).toFixed(1)},${y(p.balance).toFixed(1)}`).join(' ');
  const area = `${line} L${x(maxX).toFixed(1)},${y(0).toFixed(1)} L${x(0).toFixed(1)},${y(0).toFixed(1)} Z`;

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * maxY);
  const grid = yTicks
    .map(
      (v) =>
        `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="currentColor" stroke-opacity="0.12" />` +
        `<text x="${pad.l - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="currentColor" opacity="0.6">${abbrev(v)}</text>`
    )
    .join('');

  const xTicks = [];
  for (let yr = 0; yr <= plan.years; yr++) {
    const m = yr * 12;
    if (m > maxX) break;
    xTicks.push(
      `<text x="${x(m).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.6">${yr}y</text>`
    );
  }

  const targetY = y(plan.cash.total).toFixed(1);

  $('chart').innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Savings balance over time versus cash needed at closing">
      <defs>
        <linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.35" />
          <stop offset="100%" stop-color="var(--accent)" stop-opacity="0.02" />
        </linearGradient>
      </defs>
      ${grid}
      <path d="${area}" fill="url(#fill)" />
      <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2.5" />
      <line x1="${pad.l}" x2="${W - pad.r}" y1="${targetY}" y2="${targetY}"
            stroke="var(--accent-2)" stroke-width="1.5" stroke-dasharray="6 5" />
      <text x="${W - pad.r}" y="${Number(targetY) - 7}" text-anchor="end" font-size="11.5" fill="var(--accent-2)">
        cash needed ${abbrev(plan.cash.total)}
      </text>
      ${xTicks.join('')}
    </svg>`;
}

function abbrev(v) {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${Math.round(v / 1_000)}k`;
  return `$${Math.round(v)}`;
}

/* ------------------------------ listings / areas --------------------------- */

async function loadAreas() {
  try {
    const { areas } = await api('/api/areas');
    $('areaList').innerHTML = areas
      .map((a) => `<option value="${escapeHtml(a.area)}">${money(a.medianPrice)} median · ${a.count} listings</option>`)
      .join('');
  } catch {
    /* areas are a convenience; the app still works without them */
  }
}

async function showAreaProfile() {
  const area = $('area').value.trim();
  if (!area) return;
  const params = new URLSearchParams({ area, minBeds: String(numOf('minBeds')) });
  try {
    const p = await api(`/api/area-profile?${params}`);
    $('areaProfileBox').innerHTML =
      `<strong>${escapeHtml(p.area)}</strong> — ${p.count} listings with ${p.minBeds}+ beds<br />` +
      `Median <strong>${money(p.medianPrice)}</strong> · typical range ${money(p.p25Price)}–${money(p.p75Price)}` +
      (p.medianPricePerSqft ? `<br />${money(p.medianPricePerSqft)}/sqft` : '');
    return p;
  } catch (err) {
    $('areaProfileBox').innerHTML = `<span class="error">${err.message}</span>`;
    return null;
  }
}

async function browseListings() {
  const params = new URLSearchParams({
    area: $('area').value.trim(),
    minBeds: String(numOf('minBeds')),
    limit: '40',
    sort: 'price-asc',
  });
  try {
    const { results, total } = await api(`/api/listings?${params}`);
    if (!results.length) {
      $('listingsBox').innerHTML = '<p class="hint">No listings matched.</p>';
      return;
    }
    $('listingsBox').innerHTML =
      `<p class="hint">${total} matches — click one to make it the target.</p>` +
      results
        .map(
          (l) => `
      <div class="listing" data-price="${l.price}" data-hoa="0">
        <div>
          <div class="addr">${escapeHtml(l.address || 'Address unavailable')}</div>
          <div class="meta">${l.beds ?? '?'} bd · ${l.baths ?? '?'} ba${l.sqft ? ` · ${Math.round(l.sqft).toLocaleString()} sqft` : ''} · ${escapeHtml(l.type)}</div>
        </div>
        <div class="price">${money(l.price)}</div>
      </div>`
        )
        .join('');

    $('listingsBox')
      .querySelectorAll('.listing')
      .forEach((el) =>
        el.addEventListener('click', () => {
          $('targetPrice').value = el.dataset.price;
          scheduleRecompute();
        })
      );
  } catch (err) {
    $('listingsBox').innerHTML = `<span class="error">${err.message}</span>`;
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ------------------------------ income import ------------------------------ */

async function handleIncomeFile(file) {
  const text = await file.text();
  try {
    const { streams, warnings } = await api('/api/income/import', { method: 'POST', body: text });
    const box = $('importResult');
    if (!streams.length) {
      box.innerHTML = `<span class="error">${(warnings || []).join(' ')}</span>`;
      return;
    }
    box.innerHTML =
      `<p class="hint">Found ${streams.length} recurring deposit stream(s):</p>` +
      streams
        .map(
          (s, i) => `
      <div class="stream">
        <span>${escapeHtml(s.label)}<br /><span class="hint">${money(s.typicalAmount)} ${s.frequency} → ${money(s.annual)}/yr · ${s.confidence} confidence</span></span>
        <button type="button" class="ghost" data-i="${i}">Use</button>
      </div>`
        )
        .join('');

    box.querySelectorAll('button[data-i]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const s = streams[Number(btn.dataset.i)];
        state.incomes.push({ label: s.label.slice(0, 24), annual: Math.round(s.annual) });
        renderIncomeRows();
        scheduleRecompute();
      })
    );
  } catch (err) {
    $('importResult').innerHTML = `<span class="error">${err.message}</span>`;
  }
}

/* -------------------------------- scenarios -------------------------------- */

async function loadScenarios() {
  try {
    const { scenarios } = await api('/api/scenarios');
    $('scenarioList').innerHTML = scenarios
      .map(
        (s) => `<div class="scenario">
          <span>${escapeHtml(s.name)}<br /><span class="meta">${money(s.input.targetPrice)} · ${s.input.years}y</span></span>
          <span><button type="button" class="ghost" data-load="${s.id}">Load</button>
          <button type="button" class="ghost" data-del="${s.id}">Delete</button></span>
        </div>`
      )
      .join('');

    $('scenarioList')
      .querySelectorAll('button[data-load]')
      .forEach((b) =>
        b.addEventListener('click', () => {
          const s = scenarios.find((x) => x.id === b.dataset.load);
          if (s) applyInput(s.input);
        })
      );
    $('scenarioList')
      .querySelectorAll('button[data-del]')
      .forEach((b) =>
        b.addEventListener('click', async () => {
          await api(`/api/scenarios?id=${encodeURIComponent(b.dataset.del)}`, { method: 'DELETE' });
          loadScenarios();
        })
      );
  } catch {
    /* non-fatal */
  }
}

function applyInput(input) {
  for (const [key, value] of Object.entries(input)) {
    if (key === 'incomes' && Array.isArray(value)) {
      state.incomes = value;
      renderIncomeRows();
      continue;
    }
    const el = $(key);
    if (el && typeof value === 'number') el.value = value;
  }
  syncOutputs();
  scheduleRecompute();
}

/* ---------------------------------- wiring --------------------------------- */

function syncOutputs() {
  $('yearsOut').value = $('years').value;
  $('downOut').value = $('downPaymentPct').value;
}

function init() {
  renderIncomeRows();
  syncOutputs();

  document.querySelectorAll('.accordion-head').forEach((head) =>
    head.addEventListener('click', () => {
      const acc = head.parentElement;
      acc.dataset.open = acc.dataset.open === 'true' ? 'false' : 'true';
    })
  );

  const watched = [
    'targetPrice', 'years', 'downPaymentPct', 'appreciationPct', 'futureRatePct', 'termYears',
    'propertyTaxPct', 'hoaMonthly', 'closingCostPct', 'raisePct', 'monthlyDebts', 'currentSavings',
    'savingsReturnPct', 'monthlyExpenses', 'currentRent', 'filingStatus', 'stateTaxPct',
    'pretaxRetirementAnnual',
  ];
  watched.forEach((id) => $(id).addEventListener('input', () => { syncOutputs(); scheduleRecompute(); }));

  $('addIncome').addEventListener('click', () => {
    state.incomes.push({ label: 'Earner', annual: 50000 });
    renderIncomeRows();
    scheduleRecompute();
  });

  $('incomeFile').addEventListener('change', (e) => {
    if (e.target.files[0]) handleIncomeFile(e.target.files[0]);
  });

  $('browseListings').addEventListener('click', () => {
    showAreaProfile();
    browseListings();
  });

  $('useAreaMedian').addEventListener('click', async () => {
    const p = await showAreaProfile();
    if (p && p.medianPrice) {
      $('targetPrice').value = Math.round(p.medianPrice);
      scheduleRecompute();
    }
  });

  $('solveWhen').addEventListener('click', async () => {
    const box = $('whenResult');
    box.textContent = 'Working…';
    try {
      const data = await api('/api/when', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...collectInput(), monthlySavingsBudget: numOf('monthlySavingsBudget') }),
      });
      if (!data.reachable) {
        box.innerHTML = `<span class="error">${data.message}</span>`;
        return;
      }
      const yrs = Math.floor(data.years);
      const mos = Math.round((data.years - yrs) * 12);
      box.innerHTML =
        `Saving <strong>${money(numOf('monthlySavingsBudget'))}/mo</strong>, you reach it in ` +
        `<strong>${yrs}y ${mos}m</strong> — by then the house runs <strong>${money(data.plan.projectedPrice)}</strong> ` +
        `and you need <strong>${money(data.plan.cash.total)}</strong> in cash.`;
    } catch (err) {
      box.innerHTML = `<span class="error">${err.message}</span>`;
    }
  });

  $('saveScenario').addEventListener('click', async () => {
    await api('/api/scenarios', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: $('scenarioName').value || 'Untitled scenario', input: collectInput() }),
    });
    $('scenarioName').value = '';
    loadScenarios();
  });

  api('/api/providers')
    .then(({ providers }) => {
      const on = providers.filter((p) => p.available).map((p) => p.label);
      $('providerChip').textContent = `Data: ${on.join(' · ')}`;
      $('providerChip').title = providers
        .map((p) => `${p.label}: ${p.available ? 'ready' : `needs ${p.keyVar}`}`)
        .join('\n');
    })
    .catch(() => {});

  loadAreas();
  loadScenarios();
  recompute();
}

init();
