/**
 * Household income: manual entry, CSV import, and a take-home estimate.
 *
 * On "pull it from Credit Karma": Credit Karma has no public API, and neither
 * does Mint (retired) or most consumer finance apps. The real programmatic path
 * to verified income is Plaid (Plaid Income / Assets), which needs a Plaid
 * client ID and secret and is documented in the README.
 *
 * What works with zero setup is the export those apps *do* give you: a CSV of
 * transactions or paystubs. importIncomeCsv() reads that, finds the recurring
 * payroll deposits, and infers an annualized figure -- which is the actual
 * useful part of "linking" an account anyway.
 */

import { parseCsvObjects, toNumber } from './csv.js';

// 2025 federal parameters. Labeled by year on purpose: check them against the
// current year's IRS figures, or override with an explicit effective rate.
export const TAX_YEAR = 2025;

const BRACKETS = {
  single: [
    [11_925, 0.1],
    [48_475, 0.12],
    [103_350, 0.22],
    [197_300, 0.24],
    [250_525, 0.32],
    [626_350, 0.35],
    [Infinity, 0.37],
  ],
  married: [
    [23_850, 0.1],
    [96_950, 0.12],
    [206_700, 0.22],
    [394_600, 0.24],
    [501_050, 0.32],
    [751_600, 0.35],
    [Infinity, 0.37],
  ],
};

const STANDARD_DEDUCTION = { single: 15_000, married: 30_000 };
const SS_WAGE_BASE = 176_100;
const SS_RATE = 0.062;
const MEDICARE_RATE = 0.0145;
const ADDL_MEDICARE_RATE = 0.009;
const ADDL_MEDICARE_THRESHOLD = { single: 200_000, married: 250_000 };

export function federalIncomeTax(taxableIncome, filingStatus = 'married') {
  const brackets = BRACKETS[filingStatus] || BRACKETS.married;
  let tax = 0;
  let lower = 0;
  for (const [ceiling, rate] of brackets) {
    if (taxableIncome <= lower) break;
    const slice = Math.min(taxableIncome, ceiling) - lower;
    tax += slice * rate;
    lower = ceiling;
  }
  return tax;
}

/**
 * FICA is per-earner, not per-household: the Social Security wage base applies
 * to each person's own wages. Passing individual salaries matters for
 * high earners -- treating $400k as one earner overstates the tax.
 */
export function ficaTax(salaries, filingStatus = 'married') {
  let tax = 0;
  for (const salary of salaries) {
    tax += Math.min(salary, SS_WAGE_BASE) * SS_RATE;
    tax += salary * MEDICARE_RATE;
  }
  const total = salaries.reduce((a, b) => a + b, 0);
  const threshold = ADDL_MEDICARE_THRESHOLD[filingStatus] ?? 250_000;
  if (total > threshold) tax += (total - threshold) * ADDL_MEDICARE_RATE;
  return tax;
}

/**
 * Estimated monthly take-home. Deliberately simple: standard deduction, no
 * credits, flat state rate, pre-tax retirement contributions removed first.
 * It is a planning estimate, not a tax return.
 */
export function estimateTakeHome({
  incomes = [],
  filingStatus = 'married',
  stateTaxPct = 0,
  pretaxRetirementAnnual = 0,
  otherPretaxAnnual = 0,
  effectiveTaxRateOverride = null,
}) {
  const salaries = incomes.map((i) => Number(i.annual) || 0);
  const gross = salaries.reduce((a, b) => a + b, 0);

  if (effectiveTaxRateOverride !== null) {
    const net = gross * (1 - effectiveTaxRateOverride / 100);
    return {
      gross,
      net,
      monthlyNet: net / 12,
      effectiveRate: effectiveTaxRateOverride / 100,
      method: 'override',
    };
  }

  const pretax = pretaxRetirementAnnual + otherPretaxAnnual;
  const afterPretax = Math.max(0, gross - pretax);
  const taxable = Math.max(0, afterPretax - (STANDARD_DEDUCTION[filingStatus] ?? 30_000));

  const federal = federalIncomeTax(taxable, filingStatus);
  const fica = ficaTax(salaries, filingStatus); // FICA applies to gross wages
  const state = afterPretax * (stateTaxPct / 100);

  const net = afterPretax - federal - fica - state;
  return {
    gross,
    pretax,
    federal,
    fica,
    state,
    net,
    monthlyNet: net / 12,
    effectiveRate: gross > 0 ? (federal + fica + state) / gross : 0,
    method: `estimate-${TAX_YEAR}`,
    taxYear: TAX_YEAR,
  };
}

const PAY_PERIODS = {
  weekly: 52,
  biweekly: 26,
  semimonthly: 24,
  monthly: 12,
  quarterly: 4,
  annual: 1,
};

export function annualize(amount, frequency) {
  return amount * (PAY_PERIODS[frequency] ?? 12);
}

/** Median gap between consecutive deposits -> pay frequency. */
function inferFrequency(dates) {
  if (dates.length < 2) return 'monthly';
  const sorted = [...dates].sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) {
    gaps.push((sorted[i] - sorted[i - 1]) / (1000 * 60 * 60 * 24));
  }
  gaps.sort((a, b) => a - b);
  const medianGap = gaps[Math.floor(gaps.length / 2)];
  if (medianGap <= 9) return 'weekly';
  if (medianGap <= 18) return 'biweekly';
  if (medianGap <= 22) return 'semimonthly';
  if (medianGap <= 45) return 'monthly';
  if (medianGap <= 120) return 'quarterly';
  return 'annual';
}

const HEADER_ALIASES = {
  date: ['date', 'transaction date', 'posted date', 'post date'],
  amount: ['amount', 'credit', 'deposit', 'net pay', 'net amount'],
  description: ['description', 'name', 'memo', 'payee', 'merchant', 'category'],
};

function findColumn(headers, aliases) {
  const lower = headers.map((h) => h.toLowerCase().trim());
  for (const alias of aliases) {
    const idx = lower.indexOf(alias);
    if (idx !== -1) return headers[idx];
  }
  for (const alias of aliases) {
    const idx = lower.findIndex((h) => h.includes(alias));
    if (idx !== -1) return headers[idx];
  }
  return null;
}

const PAYROLL_HINTS = /payroll|direct dep|dir dep|salary|paycheck|wages|employer|dd |ach credit/i;

/**
 * Read a bank/payroll transaction CSV and infer annual income.
 *
 * Works with the export formats Credit Karma, Mint successors, and most banks
 * produce: a date column, a signed amount column, and a description. Deposits
 * whose description looks like payroll are grouped by description; each group
 * becomes a candidate income stream with an inferred frequency.
 */
export function importIncomeCsv(text, { minAmount = 200 } = {}) {
  const rows = parseCsvObjects(text);
  if (!rows.length) return { streams: [], warnings: ['No rows found in file'] };

  const headers = Object.keys(rows[0]);
  const dateCol = findColumn(headers, HEADER_ALIASES.date);
  const amountCol = findColumn(headers, HEADER_ALIASES.amount);
  const descCol = findColumn(headers, HEADER_ALIASES.description);

  const warnings = [];
  if (!amountCol) return { streams: [], warnings: ['Could not find an amount column'] };
  if (!dateCol) warnings.push('No date column found; assuming monthly pay frequency');

  const groups = new Map();
  for (const row of rows) {
    const amount = toNumber(row[amountCol]);
    if (amount === null || amount < minAmount) continue; // deposits only
    const desc = (descCol ? row[descCol] : '') || 'Deposit';
    const date = dateCol ? new Date(row[dateCol]) : null;
    const key = desc.trim().toLowerCase().slice(0, 40);
    if (!groups.has(key)) groups.set(key, { label: desc.trim(), amounts: [], dates: [] });
    const g = groups.get(key);
    g.amounts.push(amount);
    if (date && !Number.isNaN(date.getTime())) g.dates.push(date);
  }

  const streams = [];
  for (const g of groups.values()) {
    if (g.amounts.length < 2) continue; // one-off, not income
    const looksLikePayroll = PAYROLL_HINTS.test(g.label);
    const frequency = inferFrequency(g.dates);
    const typical = median(g.amounts);
    streams.push({
      label: g.label,
      occurrences: g.amounts.length,
      typicalAmount: typical,
      frequency,
      annual: annualize(typical, frequency),
      confidence: looksLikePayroll ? 'high' : 'low',
    });
  }

  streams.sort((a, b) => b.annual - a.annual);
  if (!streams.length) warnings.push('No recurring deposits found. Enter income manually.');
  return { streams, warnings, detected: { dateCol, amountCol, descCol } };
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  if (!s.length) return 0;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
