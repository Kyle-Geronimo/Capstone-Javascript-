// /js/payroll-ui.js
// UI glue around computePayrollLine from payroll-utils.js
// Expects certain input/output element IDs in the HTML (see below).

import { computePayrollLine, toCents } from './payroll-utils.js';

// Expected INPUT element IDs (number <input> or anything with .value):
//   ratePerDay           - daily rate
//   daysWorked           - number of days worked
//   hoursWorked          - total hours worked (optional; if empty, days * 8 is enough)
//   otHours              - overtime hours (any shift)
//   ndHours              - total night‑diff hours (10pm–6am, including ND on OT)
//   regHolidayHours      - hours on regular holidays
//   specialHolidayHours  - hours on special non‑working holidays
//
//   monthlySalary        - optional monthly‑equivalent salary base for SSS/PhilHealth/Pag‑IBIG
//   periodScaling        - optional scaling factor (e.g. 26/30 or 13/30) as a number
//
//   adjustmentsTotal     - sum of all manual deductions in PHP (St. Peter, loans, CA, credit, UT/late, etc.)
//                          If you want to keep St. Peter as a percent, set PAYROLL_CONFIG.stPeterPercent > 0
//                          and EXCLUDE it from adjustmentsTotal.
//
// Expected OUTPUT element IDs (can be <input>, <span>, or <td>):
//   grossAmount
//   totalDeductions
//   netAmount
//
// Recommended: call `setupPayrollUI()` once on DOMContentLoaded.

function getNumberValue(id) {
  const el = document.getElementById(id);
  if (!el) return 0;
  const v = parseFloat(el.value || el.textContent || '0');
  return Number.isFinite(v) ? v : 0;
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  if ('value' in el) {
    el.value = value;
  } else {
    el.textContent = value;
  }
}

export function recalculatePayroll() {
  // basic income
  const ratePerDay = getNumberValue('ratePerDay');
  const daysWorked = getNumberValue('daysWorked');

  // If hoursWorked is not provided, we just let computePayrollLine
  // use daysWorked * 8 as the main base via ratePerDay.
  const hoursWorked = getNumberValue('hoursWorked');

  const otHours = getNumberValue('otHours');
  const ndHours = getNumberValue('ndHours');
  const regHolidayHours = getNumberValue('regHolidayHours');
  const specialHolidayHours = getNumberValue('specialHolidayHours');

  // statutory base and scaling
  const monthlySalary = getNumberValue('monthlySalary') || null;
  const periodScaling = getNumberValue('periodScaling') || 1.0;

  // sum of manual deductions (PHP):
  //    St. Peter (if you do not use stPeterPercent),
  //    SSS/Pag‑IBIG/PhilHealth if you insist on fixed values,
  //    HDMF/SSS loans, CA, credit, under‑time amount, etc.
  const adjustmentsPHP = getNumberValue('adjustmentsTotal');
  const adjustmentsCents = toCents(adjustmentsPHP);

  const result = computePayrollLine({
    ratePerDay,
    daysWorked,
    hoursWorked,
    otHours,
    ndHours,
    // we don’t distinguish ndOtHours here; if you want that,
    // add a separate input and pass it as ndOtHours.
    regHolidayHours,
    specialHolidayHours,
    adjustmentsCents,
    monthlySalary,
    periodScaling
  });

  setText('grossAmount', result.gross);
  setText('totalDeductions', result.deductions.total);
  setText('netAmount', result.net);
}

export function setupPayrollUI() {
  const inputIds = [
    'ratePerDay',
    'daysWorked',
    'hoursWorked',
    'otHours',
    'ndHours',
    'regHolidayHours',
    'specialHolidayHours',
    'monthlySalary',
    'periodScaling',
    'adjustmentsTotal'
  ];

  inputIds.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => recalculatePayroll());
    el.addEventListener('change', () => recalculatePayroll());
  });

  // initial computation
  recalculatePayroll();
}

// Optional auto‑init when used via <script type="module"> at the bottom of the page
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupPayrollUI);
} else {
  setupPayrollUI();
}
