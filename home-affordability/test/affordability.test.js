import test from 'node:test';
import assert from 'node:assert/strict';

import {
  monthlyPayment,
  monthlyPmi,
  housingCost,
  maxAffordablePrice,
  projectPrice,
  futureValue,
  requiredMonthlyContribution,
  cashToClose,
  buildPlan,
  yearsUntilAffordable,
} from '../lib/affordability.js';

const near = (actual, expected, tolerance, msg) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${msg || ''} expected ~${expected}, got ${actual} (tolerance ${tolerance})`
  );

test('monthlyPayment matches the standard amortization figure', () => {
  // $300k at 6.5% over 30 years is $1,896.20 on any mortgage calculator.
  near(monthlyPayment(300_000, 6.5, 30), 1896.2, 0.5);
});

test('monthlyPayment handles a 0% rate as straight-line repayment', () => {
  near(monthlyPayment(360_000, 0, 30), 1000, 0.001);
});

test('monthlyPayment of nothing is nothing', () => {
  assert.equal(monthlyPayment(0, 6.5, 30), 0);
});

test('PMI applies only above 80% LTV', () => {
  assert.equal(monthlyPmi(80_000, 100_000, 0.6), 0, 'exactly 80% LTV is clear of PMI');
  assert.ok(monthlyPmi(90_000, 100_000, 0.6) > 0, '90% LTV owes PMI');
  near(monthlyPmi(90_000, 100_000, 0.6), (90_000 * 0.006) / 12, 0.01);
});

test('housingCost sums PITI and reports LTV', () => {
  const c = housingCost({
    price: 500_000,
    downPayment: 100_000,
    ratePct: 6.5,
    propertyTaxPct: 1.2,
    insurancePct: 0.5,
    hoaMonthly: 150,
  });
  near(c.loanAmount, 400_000, 0.01);
  near(c.ltv, 0.8, 1e-9);
  assert.equal(c.pmi, 0, 'a 20% down payment avoids PMI');
  near(c.propertyTax, 500, 0.01);
  near(c.insurance, 208.33, 0.5);
  near(c.total, c.principalInterest + 500 + 208.33 + 150, 0.5);
});

test('maxAffordablePrice respects the binding ratio', () => {
  const income = 12_000; // $144k/yr gross
  const result = maxAffordablePrice({
    grossMonthlyIncome: income,
    monthlyDebts: 0,
    downPayment: 400_000, // large enough that the PMI boundary is not what binds
    ratePct: 6.5,
  });
  // With no other debts the 28% front-end test binds first.
  near(result.monthlyBudget, income * 0.28, 0.01);
  assert.equal(result.binding, 'housing-ratio');
  near(result.cost.total, result.monthlyBudget, 1, 'solved price should spend the whole budget');
  assert.ok(result.cost.total <= result.monthlyBudget + 1e-6, 'never exceeds the budget');
});

test('maxAffordablePrice stops at the PMI cliff when that binds before income', () => {
  // $100k down + a $3,360/mo budget: the payment at $500k is only ~$3,195, but
  // one dollar more of house crosses 80% LTV and adds PMI, blowing the budget.
  const result = maxAffordablePrice({
    grossMonthlyIncome: 12_000,
    monthlyDebts: 0,
    downPayment: 100_000,
    ratePct: 6.5,
  });
  near(result.price, 500_000, 1, 'ceiling sits exactly on the 20%-down boundary');
  assert.equal(result.binding, 'pmi-cliff');
  assert.equal(result.cost.pmi, 0);
  assert.ok(result.unusedBudget > 100, 'budget is left on the table by the cliff');
});

test('other debts lower the ceiling via the back-end ratio', () => {
  const base = { grossMonthlyIncome: 12_000, downPayment: 100_000, ratePct: 6.5 };
  const clean = maxAffordablePrice({ ...base, monthlyDebts: 0 });
  const indebted = maxAffordablePrice({ ...base, monthlyDebts: 1_500 });
  assert.ok(indebted.price < clean.price, 'debt must reduce buying power');
  assert.equal(indebted.binding, 'total-debt');
});

test('maxAffordablePrice returns zero when income cannot cover existing debt', () => {
  const r = maxAffordablePrice({ grossMonthlyIncome: 3_000, monthlyDebts: 2_000, ratePct: 6.5 });
  assert.equal(r.price, 0);
});

test('projectPrice compounds annually', () => {
  near(projectPrice(500_000, 3, 5), 500_000 * 1.03 ** 5, 0.01);
  near(projectPrice(500_000, 0, 5), 500_000, 1e-9);
});

test('futureValue compounds a lump sum plus monthly deposits', () => {
  // $0 start, $1,000/mo, 5% for 10 years -> ~$155,282
  near(futureValue({ present: 0, monthlyContribution: 1_000, annualReturnPct: 5, years: 10 }), 155_282, 200);
  // Zero return is plain addition.
  near(futureValue({ present: 5_000, monthlyContribution: 500, annualReturnPct: 0, years: 2 }), 17_000, 0.01);
});

test('requiredMonthlyContribution inverts futureValue', () => {
  const target = 150_000;
  const pmt = requiredMonthlyContribution({ target, present: 20_000, annualReturnPct: 4, years: 6 });
  const achieved = futureValue({
    present: 20_000,
    monthlyContribution: pmt,
    annualReturnPct: 4,
    years: 6,
  });
  near(achieved, target, 1, 'round trip should land on the target');
});

test('requiredMonthlyContribution is zero when existing savings already get there', () => {
  const pmt = requiredMonthlyContribution({ target: 50_000, present: 100_000, annualReturnPct: 4, years: 3 });
  assert.equal(pmt, 0);
});

test('cashToClose adds closing costs and reserves on top of the down payment', () => {
  const cash = cashToClose({
    price: 600_000,
    downPaymentPct: 20,
    closingCostPct: 3,
    reserveMonths: 3,
    monthlyHousingCost: 4_000,
  });
  near(cash.downPayment, 120_000, 0.01);
  near(cash.closingCosts, 18_000, 0.01);
  near(cash.reserves, 12_000, 0.01);
  near(cash.total, 150_000, 0.01);
});

const BASE_PLAN = {
  targetPrice: 650_000,
  appreciationPct: 3,
  years: 4,
  downPaymentPct: 20,
  futureRatePct: 6,
  propertyTaxPct: 1.1,
  incomes: [{ label: 'me', annual: 110_000 }, { label: 'spouse', annual: 95_000 }],
  raisePct: 3,
  currentSavings: 40_000,
  savingsReturnPct: 4,
  monthlyTakeHome: 12_000,
  monthlyExpenses: 3_500,
  currentRent: 2_600,
};

test('buildPlan projects price and income to the purchase date', () => {
  const plan = buildPlan(BASE_PLAN);
  near(plan.projectedPrice, 650_000 * 1.03 ** 4, 1);
  near(plan.grossAnnualNow, 205_000, 0.01);
  near(plan.grossAnnualAtPurchase, 205_000 * 1.03 ** 4, 1);
  assert.ok(plan.priceGrowth > 0, 'a 3% market means the target gets more expensive');
});

test('buildPlan savings plan actually reaches the cash needed', () => {
  const plan = buildPlan(BASE_PLAN);
  near(plan.savingsProjected, plan.cash.total, 2, 'saving the prescribed amount must fund the purchase');
  assert.equal(plan.schedule.length, 4 * 12 + 1);
  near(plan.schedule.at(-1).balance, plan.cash.total, 2);
});

test('buildPlan subtracts rent as well as other expenses from surplus', () => {
  const plan = buildPlan(BASE_PLAN);
  near(plan.surplus, 12_000 - 3_500 - 2_600, 0.01);
  near(plan.rentDelta, plan.cost.total - 2_600, 0.01);
});

test('buildPlan flags an unaffordable payment rather than silently passing', () => {
  const plan = buildPlan({ ...BASE_PLAN, targetPrice: 3_000_000 });
  assert.equal(plan.qualifies, false);
  assert.ok(plan.priceGap > 0, 'target should exceed what the income supports');
  assert.ok(['payment-problem', 'out-of-reach'].includes(plan.verdict.level));
});

test('buildPlan reports on-track when both tests pass', () => {
  const plan = buildPlan({ ...BASE_PLAN, targetPrice: 450_000, currentSavings: 90_000 });
  assert.equal(plan.qualifies, true);
  assert.equal(plan.feasible, true);
  assert.equal(plan.verdict.level, 'on-track');
});

test('a longer timeline lowers the monthly savings requirement', () => {
  const short = buildPlan({ ...BASE_PLAN, years: 2 });
  const long = buildPlan({ ...BASE_PLAN, years: 6 });
  assert.ok(long.monthlySavingsNeeded < short.monthlySavingsNeeded);
});

test('yearsUntilAffordable finds a date when the budget is real', () => {
  const found = yearsUntilAffordable({ ...BASE_PLAN, targetPrice: 500_000, monthlySavingsBudget: 4_000 }, 15);
  assert.ok(found, 'should find a purchase date');
  assert.ok(found.savedByThen >= found.plan.cash.total);
  assert.equal(found.plan.qualifies, true);
});

test('yearsUntilAffordable returns null when appreciation outruns saving', () => {
  const found = yearsUntilAffordable(
    { ...BASE_PLAN, targetPrice: 2_000_000, appreciationPct: 8, monthlySavingsBudget: 200, currentSavings: 0 },
    10
  );
  assert.equal(found, null);
});

test('buildPlan reports when the ceiling is the PMI cliff rather than income', () => {
  // At exactly 20% down the PMI boundary sits precisely on the target price
  // (the boundary is 5x the down payment). When income would otherwise stretch
  // past that, the ceiling equals the price with payment budget left unused --
  // which must not be reported as comfortable headroom.
  const plan = buildPlan({ ...BASE_PLAN, incomes: [{ annual: 178_200 }], downPaymentPct: 20 });
  assert.equal(plan.maxAffordableBinding, 'pmi-cliff');
  near(plan.maxAffordableAtPurchase, plan.projectedPrice, 1);
  near(plan.priceGap, 0, 0.01, 'ceiling lands on the target, not above it');
  assert.ok(plan.maxAffordableUnusedBudget > 0, 'income headroom remains despite the ceiling');
});

test('ample income binds on the housing ratio and clears the target outright', () => {
  const plan = buildPlan({ ...BASE_PLAN, incomes: [{ annual: 230_000 }] });
  assert.equal(plan.maxAffordableBinding, 'housing-ratio');
  assert.ok(plan.maxAffordableAtPurchase > plan.projectedPrice, 'real headroom above the target');
  assert.ok(plan.priceGap < 0);
});
