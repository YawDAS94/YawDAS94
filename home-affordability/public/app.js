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

/** Mirrors lib/income.js -- kept in sync via /api/meta at startup. */
let PAY_FREQUENCIES = [{ id: 'annual', label: 'per year' }];
let ACCOUNT_TYPES = [{ id: 'savings', label: 'Savings', usableByDefault: true }];

const state = {
  // Each earner stores what you typed (amount + frequency); annual is derived.
  incomes: [
    { label: 'Me', amount: 110000, frequency: 'annual' },
    { label: 'Spouse', amount: 95000, frequency: 'annual' },
  ],
  assets: [
    { label: 'Checking', type: 'checking', amount: 10000, usable: true },
    { label: 'Savings', type: 'savings', amount: 30000, usable: true },
  ],
  takeHome: null,
  assetSummary: null,
  plan: null,
};

const PERIODS_PER_YEAR = {
  annual: 1,
  monthly: 12,
  semimonthly: 24,
  biweekly: 26,
  weekly: 52,
};

/** What the plan API wants: [{ label, annual }]. */
function annualIncomes() {
  return state.incomes.map((i) => ({
    label: i.label,
    annual: (Number(i.amount) || 0) * (PERIODS_PER_YEAR[i.frequency] ?? 1),
  }));
}

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
    incomes: annualIncomes(),
    raisePct: numOf('raisePct'),
    monthlyDebts: numOf('monthlyDebts'),
    // Only money you can actually spend on a house counts toward the plan.
    currentSavings: state.assetSummary ? state.assetSummary.usable : 0,
    savingsReturnPct: numOf('savingsReturnPct'),
    monthlyExpenses: numOf('monthlyExpenses'),
    currentRent: numOf('currentRent'),
    monthlyTakeHome: monthlyTakeHome(),
  };
}

/** A figure you enter yourself beats a figure we estimate from tax tables. */
function monthlyTakeHome() {
  if ($('useActualTakeHome').checked) return numOf('actualTakeHome');
  return state.takeHome ? state.takeHome.monthlyNet : null;
}

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  children.forEach((c) => node.append(c));
  return node;
}

function removeButton(title, onClick) {
  const b = el('button', { type: 'button', textContent: '×', title });
  b.addEventListener('click', onClick);
  return b;
}

function renderIncomeRows() {
  const box = $('incomeRows');
  box.innerHTML = '';

  state.incomes.forEach((inc, idx) => {
    const name = el('input', { type: 'text', value: inc.label, placeholder: 'Name' });
    name.addEventListener('input', () => {
      state.incomes[idx].label = name.value;
      persist();
    });

    const amount = el('input', {
      type: 'number',
      step: '500',
      min: '0',
      value: inc.amount,
      title: 'Gross pay before taxes',
    });

    const freq = el('select', { title: 'How often this is paid' });
    PAY_FREQUENCIES.forEach((f) =>
      freq.append(el('option', { value: f.id, textContent: f.label, selected: f.id === inc.frequency }))
    );

    // Shows the annualized figure whenever it differs from what was typed, so
    // converting "every 2 weeks" into a yearly number is visible, not implied.
    // Updated in place rather than by re-rendering, which would drop focus
    // out of the field mid-keystroke.
    const note = el('div', { className: 'row-note' });
    const syncNote = () => {
      const row = state.incomes[idx];
      const annual = (Number(row.amount) || 0) * (PERIODS_PER_YEAR[row.frequency] ?? 1);
      note.hidden = row.frequency === 'annual';
      note.textContent = `↳ ${money(annual)} per year`;
    };

    amount.addEventListener('input', () => {
      state.incomes[idx].amount = Number(amount.value) || 0;
      syncNote();
      scheduleRecompute();
    });
    freq.addEventListener('change', () => {
      state.incomes[idx].frequency = freq.value;
      syncNote();
      scheduleRecompute();
    });
    syncNote();

    box.append(
      el('div', { className: 'income-row' }, [
        name,
        amount,
        freq,
        removeButton('Remove earner', () => {
          state.incomes.splice(idx, 1);
          renderIncomeRows();
          scheduleRecompute();
        }),
      ]),
      note
    );
  });
}

function renderAssetRows() {
  const box = $('assetRows');
  box.innerHTML = '';

  state.assets.forEach((acct, idx) => {
    const name = el('input', { type: 'text', value: acct.label, placeholder: 'Account' });
    name.addEventListener('input', () => {
      state.assets[idx].label = name.value;
      persist();
    });

    const type = el('select', { title: 'Account type' });
    ACCOUNT_TYPES.forEach((t) =>
      type.append(el('option', { value: t.id, textContent: t.label, selected: t.id === acct.type }))
    );
    type.addEventListener('change', () => {
      state.assets[idx].type = type.value;
      // Switching type resets to that type's default answer, which the user can
      // then override -- otherwise a stale checkbox silently contradicts it.
      const def = ACCOUNT_TYPES.find((t) => t.id === type.value);
      state.assets[idx].usable = def ? def.usableByDefault : true;
      renderAssetRows();
      scheduleRecompute();
    });

    const amount = el('input', { type: 'number', step: '1000', min: '0', value: acct.amount });
    amount.addEventListener('input', () => {
      state.assets[idx].amount = Number(amount.value) || 0;
      scheduleRecompute();
    });

    const usable = el('input', { type: 'checkbox', checked: acct.usable, title: 'Available for the down payment' });
    usable.addEventListener('change', () => {
      state.assets[idx].usable = usable.checked;
      scheduleRecompute();
    });

    box.append(
      el('div', { className: 'asset-row' }, [
        name,
        type,
        amount,
        el('label', { className: 'usable-box', title: 'Available for the down payment' }, [usable]),
        removeButton('Remove account', () => {
          state.assets.splice(idx, 1);
          renderAssetRows();
          scheduleRecompute();
        }),
      ])
    );

    const meta = ACCOUNT_TYPES.find((t) => t.id === acct.type);
    if (meta && meta.note) box.append(el('div', { className: 'row-note', textContent: meta.note }));
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
    persist();

    state.assetSummary = await api('/api/assets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accounts: state.assets }),
    });
    renderAssetSummary();

    state.takeHome = await api('/api/takehome', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        incomes: annualIncomes(),
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
  const overridden = $('useActualTakeHome').checked;
  $('takeHomeBox').innerHTML =
    `<strong>${money(t.gross)}</strong> gross · <strong>${money(t.monthlyNet)}/mo</strong> estimated take-home` +
    `<br /><span class="hint">Effective tax rate ${pct(t.effectiveRate)} (federal + FICA + state)${
      overridden ? ' — overridden by your own figure below' : ''
    }</span>`;
}

function renderAssetSummary() {
  const s = state.assetSummary;
  $('assetSummary').innerHTML =
    `<strong>${money(s.usable)}</strong> available for a down payment` +
    (s.locked > 0
      ? `<br /><span class="hint">${money(s.locked)} more sits in accounts marked unavailable, so it is not counted.</span>`
      : '');
}

/* ------------------------------- persistence ------------------------------- */
// Typing a household balance sheet by hand once is fine. Twice is not, so the
// form restores itself. localStorage is same-origin and stays on this machine.

const STORAGE_KEY = 'home-savings-planner/v1';
const PERSISTED_FIELDS = [
  'targetPrice', 'years', 'downPaymentPct', 'appreciationPct', 'futureRatePct', 'termYears',
  'propertyTaxPct', 'hoaMonthly', 'closingCostPct', 'raisePct', 'monthlyDebts', 'savingsReturnPct',
  'monthlyExpenses', 'currentRent', 'filingStatus', 'stateTaxPct', 'pretaxRetirementAnnual',
  'area', 'minBeds', 'monthlySavingsBudget', 'actualTakeHome',
];

function persist() {
  try {
    const fields = {};
    PERSISTED_FIELDS.forEach((id) => {
      if ($(id)) fields[id] = $(id).value;
    });
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        incomes: state.incomes,
        assets: state.assets,
        fields,
        useActualTakeHome: $('useActualTakeHome').checked,
      })
    );
  } catch {
    /* private browsing or a full quota -- the app still works, it just forgets */
  }
}

function restore() {
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  } catch {
    return;
  }
  if (!saved) return;

  if (Array.isArray(saved.incomes) && saved.incomes.length) state.incomes = saved.incomes;
  if (Array.isArray(saved.assets)) state.assets = saved.assets;
  Object.entries(saved.fields || {}).forEach(([id, value]) => {
    if ($(id)) $(id).value = value;
  });
  $('useActualTakeHome').checked = Boolean(saved.useActualTakeHome);
  $('actualTakeHomeWrap').hidden = !saved.useActualTakeHome;
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

  if (plan.priceGap > 0) {
    checks.push({
      level: 'bad',
      text: `A lender would support about <strong>${money(plan.maxAffordableAtPurchase)}</strong>, which is <strong>${money(plan.priceGap)}</strong> short of this house.`,
    });
  } else if (plan.maxAffordableBinding === 'pmi-cliff') {
    // The ceiling is the 20%-down boundary, not income — so it lands exactly on
    // the target price and there is no real headroom above it.
    checks.push({
      level: 'warn',
      text:
        `Your ceiling is pinned at <strong>${money(plan.maxAffordableAtPurchase)}</strong> by the 20%-down boundary, not by income — ` +
        `there is still <strong>${money(plan.maxAffordableUnusedBudget)}/mo</strong> of payment budget unused. ` +
        `Going above this price drops you under 20% down and adds PMI, so more cash (not more salary) is what buys a bigger house.`,
    });
  } else {
    checks.push({
      level: 'ok',
      text: `A lender should support up to <strong>${money(plan.maxAffordableAtPurchase)}</strong> by then — <strong>${money(-plan.priceGap)}</strong> above this house.`,
    });
  }

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
        // Keep the detected per-period amount and frequency rather than folding
        // to a yearly number, so the row stays editable in the same terms.
        state.incomes.push({
          label: s.label.slice(0, 24),
          amount: Math.round(s.typicalAmount),
          frequency: s.frequency,
        });
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

async function loadMeta() {
  try {
    const meta = await api('/api/meta');
    PAY_FREQUENCIES = meta.payFrequencies;
    ACCOUNT_TYPES = meta.accountTypes;
    $('taxYear').textContent = meta.taxYear;
  } catch {
    /* fall back to the built-in minimal lists */
  }
}

async function init() {
  await loadMeta();
  restore();
  renderIncomeRows();
  renderAssetRows();
  syncOutputs();

  $('addAsset').addEventListener('click', () => {
    state.assets.push({ label: 'Account', type: 'savings', amount: 0, usable: true });
    renderAssetRows();
    scheduleRecompute();
  });

  $('useActualTakeHome').addEventListener('change', (e) => {
    $('actualTakeHomeWrap').hidden = !e.target.checked;
    scheduleRecompute();
  });
  $('actualTakeHome').addEventListener('input', scheduleRecompute);

  document.querySelectorAll('.accordion-head').forEach((head) =>
    head.addEventListener('click', () => {
      const acc = head.parentElement;
      acc.dataset.open = acc.dataset.open === 'true' ? 'false' : 'true';
    })
  );

  const watched = [
    'targetPrice', 'years', 'downPaymentPct', 'appreciationPct', 'futureRatePct', 'termYears',
    'propertyTaxPct', 'hoaMonthly', 'closingCostPct', 'raisePct', 'monthlyDebts',
    'savingsReturnPct', 'monthlyExpenses', 'currentRent', 'filingStatus', 'stateTaxPct',
    'pretaxRetirementAnnual', 'area', 'minBeds',
  ];
  watched.forEach((id) => $(id).addEventListener('input', () => { syncOutputs(); scheduleRecompute(); }));

  $('addIncome').addEventListener('click', () => {
    state.incomes.push({ label: 'Earner', amount: 50000, frequency: 'annual' });
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
