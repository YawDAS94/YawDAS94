/**
 * Core affordability + savings math. Pure functions, no I/O, no DOM.
 * Shared verbatim by the Node server, the unit tests, and the browser UI.
 *
 * Money is handled in plain dollars (floats). Rates are accepted as percentages
 * (6.5 means 6.5%/yr) because that is how humans type them; every function
 * converts to a decimal internally.
 */

const MONTHS = 12;

/** Percent (6.5) -> monthly decimal rate (0.005416...). */
export function monthlyRate(annualPct) {
  return annualPct / 100 / MONTHS;
}

export function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Standard amortizing payment: M = P * i / (1 - (1+i)^-n).
 * Falls back to straight-line when the rate is 0 (the closed form divides by 0).
 */
export function monthlyPayment(principal, annualRatePct, termYears) {
  if (principal <= 0) return 0;
  const n = termYears * MONTHS;
  if (n <= 0) return principal;
  const i = monthlyRate(annualRatePct);
  if (i === 0) return principal / n;
  return (principal * i) / (1 - Math.pow(1 + i, -n));
}

/**
 * PMI is charged while loan-to-value is above 80%, quoted as an annual
 * percentage of the *loan* balance. It drops off later in the loan, but for a
 * "can I carry this payment on day one" test the initial figure is what binds.
 */
export function monthlyPmi(loanAmount, price, pmiAnnualPct) {
  if (price <= 0 || loanAmount <= 0) return 0;
  const ltv = loanAmount / price;
  if (ltv <= 0.8) return 0;
  return (loanAmount * (pmiAnnualPct / 100)) / MONTHS;
}

/**
 * Full monthly carrying cost of a house at a given price: PITI + HOA + PMI.
 * `insuranceAnnual` defaults to a percentage of price when not supplied.
 */
export function housingCost({
  price,
  downPayment,
  ratePct,
  termYears = 30,
  propertyTaxPct = 1.1,
  insuranceAnnual = null,
  insurancePct = 0.5,
  hoaMonthly = 0,
  pmiAnnualPct = 0.6,
}) {
  const loanAmount = Math.max(0, price - downPayment);
  const insurance = (insuranceAnnual ?? price * (insurancePct / 100)) / MONTHS;
  const parts = {
    principalInterest: monthlyPayment(loanAmount, ratePct, termYears),
    propertyTax: (price * (propertyTaxPct / 100)) / MONTHS,
    insurance,
    hoa: hoaMonthly,
    pmi: monthlyPmi(loanAmount, price, pmiAnnualPct),
  };
  const total = Object.values(parts).reduce((a, b) => a + b, 0);
  return {
    ...parts,
    total,
    loanAmount,
    ltv: price > 0 ? loanAmount / price : 0,
    downPaymentPct: price > 0 ? downPayment / price : 0,
  };
}

/**
 * Largest price whose carrying cost clears BOTH underwriting tests:
 *   front-end: housing / gross income        <= frontEndRatio
 *   back-end:  (housing + debts) / gross     <= backEndRatio   (this is DTI)
 *
 * There is no clean closed form once PMI and price-linked tax/insurance are in
 * the loop (the constraint is piecewise at the 80% LTV boundary), so this
 * bisects. 60 iterations over a $0-$25M bracket converges well past cent
 * precision.
 */
export function maxAffordablePrice({
  grossMonthlyIncome,
  monthlyDebts = 0,
  downPayment = 0,
  frontEndRatio = 0.28,
  backEndRatio = 0.36,
  ...costOpts
}) {
  const frontBudget = grossMonthlyIncome * frontEndRatio;
  const backBudget = grossMonthlyIncome * backEndRatio - monthlyDebts;
  const budget = Math.min(frontBudget, backBudget);
  if (budget <= 0) {
    return { price: 0, monthlyBudget: 0, binding: 'income', cost: null };
  }

  let lo = 0;
  let hi = 25_000_000;
  for (let k = 0; k < 60; k++) {
    const mid = (lo + hi) / 2;
    const cost = housingCost({ price: mid, downPayment, ...costOpts }).total;
    if (cost > budget) hi = mid;
    else lo = mid;
  }
  const cost = housingCost({ price: lo, downPayment, ...costOpts });

  // The cost curve is discontinuous at 80% LTV: crossing it turns PMI on and
  // adds a lump to the payment. When a fixed down payment lands the ceiling
  // exactly on that boundary, the answer is capped by the PMI cliff rather than
  // by income -- and the payment leaves budget unspent. That is worth saying
  // out loud, because it means a slightly bigger down payment (not a bigger
  // salary) is what unlocks the next price band.
  // LTV <= 0.8 means down/price >= 0.2, so the boundary price is down / 0.2.
  const cliffPrice = downPayment > 0 ? downPayment / 0.2 : 0;
  const atCliff =
    cliffPrice > 0 && Math.abs(lo - cliffPrice) / cliffPrice < 1e-4 && cost.total < budget - 1;

  return {
    price: lo,
    monthlyBudget: budget,
    binding: atCliff ? 'pmi-cliff' : frontBudget <= backBudget ? 'housing-ratio' : 'total-debt',
    unusedBudget: Math.max(0, budget - cost.total),
    cost,
  };
}

/** Compound a price forward at an annual appreciation rate. */
export function projectPrice(price, annualAppreciationPct, years) {
  return price * Math.pow(1 + annualAppreciationPct / 100, years);
}

/**
 * Future value of a lump sum plus a monthly contribution, compounded monthly.
 * FV = PV(1+i)^n + PMT * ((1+i)^n - 1)/i
 */
export function futureValue({ present = 0, monthlyContribution = 0, annualReturnPct = 0, years }) {
  const n = Math.round(years * MONTHS);
  const i = monthlyRate(annualReturnPct);
  if (i === 0) return present + monthlyContribution * n;
  const growth = Math.pow(1 + i, n);
  return present * growth + monthlyContribution * ((growth - 1) / i);
}

/**
 * Inverse of futureValue: the monthly deposit needed to land on `target`.
 * Returns 0 when existing savings already grow past the target on their own.
 */
export function requiredMonthlyContribution({ target, present = 0, annualReturnPct = 0, years }) {
  const n = Math.round(years * MONTHS);
  if (n <= 0) return Math.max(0, target - present);
  const i = monthlyRate(annualReturnPct);
  const grown = i === 0 ? present : present * Math.pow(1 + i, n);
  const shortfall = target - grown;
  if (shortfall <= 0) return 0;
  if (i === 0) return shortfall / n;
  return shortfall / ((Math.pow(1 + i, n) - 1) / i);
}

/**
 * Cash actually required at the closing table -- not just the down payment.
 * Closing costs and a post-close reserve are the two line items people miss.
 */
export function cashToClose({
  price,
  downPaymentPct,
  closingCostPct = 3,
  reserveMonths = 3,
  monthlyHousingCost = 0,
  movingBuffer = 0,
}) {
  const downPayment = price * (downPaymentPct / 100);
  const closingCosts = price * (closingCostPct / 100);
  const reserves = monthlyHousingCost * reserveMonths;
  return {
    downPayment,
    closingCosts,
    reserves,
    movingBuffer,
    total: downPayment + closingCosts + reserves + movingBuffer,
  };
}

/** Month-by-month savings balance, for the trajectory chart. */
export function savingsSchedule({ present, monthlyContribution, annualReturnPct, years }) {
  const n = Math.round(years * MONTHS);
  const i = monthlyRate(annualReturnPct);
  const rows = [];
  let balance = present;
  for (let m = 0; m <= n; m++) {
    if (m > 0) balance = balance * (1 + i) + monthlyContribution;
    rows.push({ month: m, balance });
  }
  return rows;
}

/**
 * The headline question: "how much do we need to save each month to buy in
 * `years` years?" Ties every piece together and grades the result.
 *
 * Everything price-like is projected to the purchase date: the house
 * appreciates, incomes get raises, and the mortgage rate is whatever the user
 * expects it to be *then* (not today's rate).
 */
export function buildPlan(input) {
  const {
    // Target home
    targetPrice,
    appreciationPct = 3,
    years,
    // Financing at purchase time
    downPaymentPct = 20,
    futureRatePct,
    termYears = 30,
    propertyTaxPct = 1.1,
    insurancePct = 0.5,
    hoaMonthly = 0,
    pmiAnnualPct = 0.6,
    closingCostPct = 3,
    reserveMonths = 3,
    movingBuffer = 0,
    // Household
    incomes = [],
    raisePct = 3,
    monthlyDebts = 0,
    currentSavings = 0,
    savingsReturnPct = 4,
    monthlyTakeHome = null,
    monthlyExpenses = 0,
    currentRent = 0,
    // Underwriting appetite
    frontEndRatio = 0.28,
    backEndRatio = 0.36,
  } = input;

  const grossAnnualNow = incomes.reduce((sum, i) => sum + (Number(i.annual) || 0), 0);
  const grossAnnualAtPurchase = grossAnnualNow * Math.pow(1 + raisePct / 100, years);
  const grossMonthlyAtPurchase = grossAnnualAtPurchase / MONTHS;

  const projectedPrice = projectPrice(targetPrice, appreciationPct, years);
  const downPayment = projectedPrice * (downPaymentPct / 100);

  const cost = housingCost({
    price: projectedPrice,
    downPayment,
    ratePct: futureRatePct,
    termYears,
    propertyTaxPct,
    insurancePct,
    hoaMonthly,
    pmiAnnualPct,
  });

  const cash = cashToClose({
    price: projectedPrice,
    downPaymentPct,
    closingCostPct,
    reserveMonths,
    monthlyHousingCost: cost.total,
    movingBuffer,
  });

  const monthlySavingsNeeded = requiredMonthlyContribution({
    target: cash.total,
    present: currentSavings,
    annualReturnPct: savingsReturnPct,
    years,
  });

  // Can the household actually set that aside today?
  // Rent is a living cost like any other, but it is tracked separately so the
  // plan can show what the payment costs *relative to what you already pay*.
  const surplus =
    monthlyTakeHome === null ? null : monthlyTakeHome - monthlyExpenses - currentRent;
  const feasible = surplus === null ? null : surplus >= monthlySavingsNeeded;

  // Will a lender say yes on the projected numbers?
  const frontEndActual = grossMonthlyAtPurchase > 0 ? cost.total / grossMonthlyAtPurchase : Infinity;
  const backEndActual =
    grossMonthlyAtPurchase > 0 ? (cost.total + monthlyDebts) / grossMonthlyAtPurchase : Infinity;
  const qualifies = frontEndActual <= frontEndRatio && backEndActual <= backEndRatio;

  const maxAtPurchase = maxAffordablePrice({
    grossMonthlyIncome: grossMonthlyAtPurchase,
    monthlyDebts,
    downPayment,
    frontEndRatio,
    backEndRatio,
    ratePct: futureRatePct,
    termYears,
    propertyTaxPct,
    insurancePct,
    hoaMonthly,
    pmiAnnualPct,
  });

  return {
    years,
    grossAnnualNow,
    grossAnnualAtPurchase,
    grossMonthlyAtPurchase,
    targetPrice,
    projectedPrice,
    priceGrowth: projectedPrice - targetPrice,
    cost,
    cash,
    monthlySavingsNeeded,
    savingsProjected: futureValue({
      present: currentSavings,
      monthlyContribution: monthlySavingsNeeded,
      annualReturnPct: savingsReturnPct,
      years,
    }),
    surplus,
    feasible,
    currentRent,
    // What owning costs on top of what you already pay to live somewhere.
    rentDelta: currentRent ? cost.total - currentRent : null,
    frontEndActual,
    backEndActual,
    qualifies,
    maxAffordableAtPurchase: maxAtPurchase.price,
    priceGap: projectedPrice - maxAtPurchase.price,
    // Which wall you hit first. Note that with exactly 20% down the PMI cliff
    // sits precisely at the target price (the boundary IS 5x the down payment),
    // so the ceiling can equal the price while income still has room to spare.
    // Reporting the binding constraint keeps that from reading as "plenty of
    // headroom" when there is none.
    maxAffordableBinding: maxAtPurchase.binding,
    maxAffordableUnusedBudget: maxAtPurchase.unusedBudget,
    schedule: savingsSchedule({
      present: currentSavings,
      monthlyContribution: monthlySavingsNeeded,
      annualReturnPct: savingsReturnPct,
      years,
    }),
    verdict: gradePlan({ qualifies, feasible, surplus, monthlySavingsNeeded }),
  };
}

function gradePlan({ qualifies, feasible, surplus, monthlySavingsNeeded }) {
  if (!qualifies && feasible === false) {
    return {
      level: 'out-of-reach',
      headline: 'Out of reach on this timeline',
      detail:
        'The payment exceeds standard debt-to-income limits AND the down payment needs more than your monthly surplus. Stretch the timeline, raise income, or aim at a cheaper price band.',
    };
  }
  if (!qualifies) {
    return {
      level: 'payment-problem',
      headline: 'You can save the cash, but the payment is too big',
      detail:
        'You can reach the down payment, but the monthly payment breaks standard debt-to-income limits. A larger down payment, a longer term, or a cheaper home fixes this.',
    };
  }
  if (feasible === false) {
    const gap = monthlySavingsNeeded - surplus;
    return {
      level: 'savings-problem',
      headline: 'Payment works, saving the down payment is the squeeze',
      detail: `You would qualify for the loan, but you need about $${Math.round(
        gap
      ).toLocaleString()} more per month than your current surplus to hit the down payment in time.`,
    };
  }
  return {
    level: 'on-track',
    headline: 'On track',
    detail:
      'Both tests pass: the monthly savings fit inside your surplus, and the projected payment sits inside standard debt-to-income limits.',
  };
}

/**
 * Flip the question around: "we can save $X/mo -- when can we buy?"
 * Walks the timeline month by month because the target is itself moving (the
 * house appreciates while you save), so this is a race, not a division.
 * Returns null when savings never catch the appreciating target within maxYears.
 */
export function yearsUntilAffordable(input, maxYears = 30) {
  const { monthlySavingsBudget } = input;
  for (let m = 1; m <= maxYears * MONTHS; m++) {
    const years = m / MONTHS;
    const plan = buildPlan({ ...input, years });
    const saved = futureValue({
      present: input.currentSavings ?? 0,
      monthlyContribution: monthlySavingsBudget,
      annualReturnPct: input.savingsReturnPct ?? 4,
      years,
    });
    if (saved >= plan.cash.total && plan.qualifies) {
      return { years, months: m, plan, savedByThen: saved };
    }
  }
  return null;
}
