// /js/payroll-utils.js
// small payroll math utilities — cents-based arithmetic to avoid floating point drift

// config (editable)
export const PAYROLL_CONFIG = {
  otMultiplier: 1.25,
  ndRate: 0.10,
  regularHolidayMultiplier: 2.0,
  specialHolidayMultiplier: 1.3,

  // St. Peter Life Plan (editable): percent of gross (employee only)
  stPeterPercent: 0.00,

  // NOTE: the following are kept to allow legacy simple-percent fallbacks,
  // but computeSSS/computePhilhealth/computePagibig implement pragmatic, statutory-like formulas.
  sssPercent: 0.04,       // legacy fallback (not used when computeSSS is used)
  philhealthPercent: 0.035,
  pagibigPercent: 0.02
};

export function toCents(amount) {
  // accept number or numeric string
  const n = Number(amount || 0);
  return Math.round(n * 100);
}
export function fromCents(cents) {
  return (cents / 100).toFixed(2);
}

// -------------------------- statutory-style helpers --------------------------
// These functions implement pragmatic approximations for 2025 rules:
// - SSS: total contribution 15% of MSC up to MSC cap (employee 5%, employer 10%).
//   Uses a simple cap on the salary base (MSC cap like P35,000).
//   Source: SSS contribution schedule (effective Jan 2025).
// - PhilHealth: 5% of Monthly Basic Salary with floor P10,000 and ceiling P100,000.
//   Employer/employee split is 50/50.
//   Source: PhilHealth advisory 2025.
// - Pag-IBIG: employee/employer contributions up to a salary cap (P10,000 typical).
//   Employee share 1% for <=P1,500 or 2% for >P1,500; employer usually 2% — pragmatic handling below.
//
// IMPORTANT: payroll periods vary (monthly, semi-monthly). These functions assume the provided
// 'salary' parameter is the *monthly-equivalent* base. If you run payroll for a period that's
// not monthly, scale the returned amounts proportionally (e.g. multiply by periodDays/30).

/** computeSSSFromMonthlySalary
 *  @param {number} monthlySalary - monthly salary in PHP (not cents)
 *  @returns {object} { employee, employer, total } in cents
 */
export function computeSSSFromMonthlySalary(monthlySalary) {
  // Practical MSC cap used here (SSS publishes MSC ranges — we approximate using a cap).
  const MSC_CAP = 35000; // use official SSS MSC upper bound used in 2025 notices
  const capped = Math.min(Number(monthlySalary || 0), MSC_CAP);
  const employee = Math.round(capped * 0.05 * 100); // 5% employee
  const employer = Math.round(capped * 0.10 * 100); // 10% employer
  return { employee, employer, total: employee + employer };
}

/** computePhilhealthFromMonthlySalary
 *  @param {number} monthlySalary - monthly salary in PHP
 *  @returns {object} { employee, employer, total } in cents
 */
export function computePhilhealthFromMonthlySalary(monthlySalary) {
  const FLOOR = 10000;
  const CEILING = 100000;
  const mbs = Math.min(Math.max(Number(monthlySalary || 0), FLOOR), CEILING);
  const total = Math.round(mbs * 0.05 * 100); // 5% total
  // equal split
  const employee = Math.round(total / 2);
  const employer = total - employee;
  return { employee, employer, total };
}

/** computePagibigFromMonthlySalary
 *  @param {number} monthlySalary - monthly salary in PHP
 *  @returns {object} { employee, employer, total } in cents
 */
export function computePagibigFromMonthlySalary(monthlySalary) {
  const CAP = 10000; // practical cap used widely for contributions
  const base = Math.min(Number(monthlySalary || 0), CAP);
  let employee = 0;
  if (Number(monthlySalary || 0) <= 1500) {
    employee = Math.round(base * 0.01 * 100); // 1% if <=1,500
  } else {
    employee = Math.round(base * 0.02 * 100); // 2% otherwise
  }
  const employer = Math.round(base * 0.02 * 100); // employer usually matches 2%
  const total = employee + employer;
  return { employee, employer, total };
}

// -------------------------- main payroll computation --------------------------

export function computePayrollLine({
  ratePerDay = 0,
  ratePerHour = null,
  daysWorked = 0,
  hoursWorked = 0,
  ndHours = 0,
  ndOtHours = 0,
  otHours = 0,
  regHolidayHours = 0,
  specialHolidayHours = 0,
  adjustmentsCents = 0,
  // OPTIONAL: pass monthlySalary if you want statutory deductions calculated from an explicit monthly base
  monthlySalary = null,
  // OPTIONAL: periodScaling (e.g. 15/30 for semi-monthly). If provided, statutory deductions are scaled by this factor.
  periodScaling = 1.0
  ,
  // OPTIONAL: manualPagibig (PHP) — if provided, override computed employee pag-ibig deduction (employee share)
  manualPagibig = null,
  // OPTIONAL: sssOverride (object in PHP amounts) { employee, employer, total }
  // If provided, these values (PHP) will be used instead of computeSSSFromMonthlySalary
  sssOverride = null
}) {
  // prefer hourly when ratePerHour provided; otherwise convert day->hour (8 hrs default)
  const dayToHours = 8;

  let grossCents = 0;
  if (ratePerHour !== null && ratePerHour !== undefined && ratePerHour !== '') {
    const hrC = toCents(ratePerHour);
    grossCents += Math.round(hrC * Number(hoursWorked || 0));
  } else {
    const dC = toCents(ratePerDay || 0);
    grossCents += Math.round(dC * Number(daysWorked || 0));
  }

  const hourlyCents = (ratePerHour !== null && ratePerHour !== undefined && ratePerHour !== '')
    ? toCents(ratePerHour)
    : Math.round(toCents(ratePerDay || 0) / dayToHours);

  // If caller provided breakdown of ND hours that are OT, prefer that.
  // Backwards compatible: if ndOtHours not provided, we assume all ndHours are non-OT ND.
  const ndOtH = Number(ndOtHours || 0);
  const ndTotalHours = Number(ndHours || 0);
  const ndRegularHours = Math.max(0, ndTotalHours - ndOtH);

  // night differential: applies to ND regular hours AND ND-on-OT hours
  if (ndTotalHours > 0) {
    const ndExtra = Math.round(hourlyCents * ndTotalHours * PAYROLL_CONFIG.ndRate);
    grossCents += ndExtra;
  }

  // overtime: OT multiplier applied to all OT hours
  if (Number(otHours) > 0) {
    // OT pay is base * OT multiplier for all OT hours
    const ot = Math.round(hourlyCents * Number(otHours) * PAYROLL_CONFIG.otMultiplier);
    grossCents += ot;
  }

  // holidays (unchanged)
  if (Number(regHolidayHours) > 0) {
    const rh = Math.round(hourlyCents * Number(regHolidayHours) * PAYROLL_CONFIG.regularHolidayMultiplier);
    grossCents += rh;
  }
  if (Number(specialHolidayHours) > 0) {
    const sh = Math.round(hourlyCents * Number(specialHolidayHours) * PAYROLL_CONFIG.specialHolidayMultiplier);
    grossCents += sh;
  }

  // manual adjustments (already in cents)
  grossCents += Number(adjustmentsCents || 0);

  // ------------------ deductions ------------------
  // If a monthlySalary is provided, compute statutory contributions from it
  // and scale by periodScaling (1.0 = full monthly). Otherwise, fall back to
  // simple-percentage approximations on the gross.
  let sssEmployee = 0, sssEmployer = 0, sssTotal = 0;
  let philEmployee = 0, philEmployer = 0, philTotal = 0;
  let pagibigEmployee = 0, pagibigEmployer = 0, pagibigTotal = 0;

  if (monthlySalary !== null && monthlySalary !== undefined) {
    if (sssOverride && (typeof sssOverride.employee === 'number' || typeof sssOverride.employer === 'number')) {
      // use provided table values (assumed in PHP), scale and convert to cents
      sssEmployee = Math.round(Number(sssOverride.employee || 0) * 100 * Number(periodScaling || 1));
      sssEmployer = Math.round(Number(sssOverride.employer || 0) * 100 * Number(periodScaling || 1));
      sssTotal = sssEmployee + sssEmployer;
    } else {
      const sss = computeSSSFromMonthlySalary(monthlySalary);
      sssEmployee = Math.round(sss.employee * Number(periodScaling || 1));
      sssEmployer = Math.round(sss.employer * Number(periodScaling || 1));
      sssTotal = sssEmployee + sssEmployer;
    }

    const phil = computePhilhealthFromMonthlySalary(monthlySalary);
    philEmployee = Math.round(phil.employee * Number(periodScaling || 1));
    philEmployer = Math.round(phil.employer * Number(periodScaling || 1));
    philTotal = philEmployee + philEmployer;

    const pag = computePagibigFromMonthlySalary(monthlySalary);
    pagibigEmployee = Math.round(pag.employee * Number(periodScaling || 1));
    pagibigEmployer = Math.round(pag.employer * Number(periodScaling || 1));
    pagibigTotal = pagibigEmployee + pagibigEmployer;

    // If caller provided a manual pagibig amount (PHP), use it for the employee share (override automated calc)
    if (manualPagibig !== null && manualPagibig !== undefined && manualPagibig !== '') {
      const manualC = Math.round(Number(manualPagibig || 0) * 100);
      pagibigEmployee = manualC;
      // adjust total — keep employer as previously computed
      pagibigTotal = pagibigEmployee + pagibigEmployer;
    }
  } else {
    // fallback: use simple percents on gross (legacy behavior)
    sssEmployee = Math.round(grossCents * PAYROLL_CONFIG.sssPercent);
    sssEmployer = 0;
    sssTotal = sssEmployee;

    philEmployee = Math.round(grossCents * PAYROLL_CONFIG.philhealthPercent);
    philEmployer = 0;
    philTotal = philEmployee;

    // If manual pagibig provided, use it (employee-side) as absolute cents value
    if (manualPagibig !== null && manualPagibig !== undefined && manualPagibig !== '') {
      pagibigEmployee = Math.round(Number(manualPagibig || 0) * 100);
      pagibigEmployer = 0;
      pagibigTotal = pagibigEmployee;
    } else {
      pagibigEmployee = Math.round(grossCents * PAYROLL_CONFIG.pagibigPercent);
      pagibigEmployer = 0;
      pagibigTotal = pagibigEmployee;
    }
  }

  // St. Peter Life Plan (employee-only)
  const stPeter = Math.round(grossCents * Number(PAYROLL_CONFIG.stPeterPercent || 0));

  // Compose deductions object (employee-side amounts in cents)
  const deductions = {
    sss: { employee: sssEmployee, employer: sssEmployer, total: sssTotal },
    philhealth: { employee: philEmployee, employer: philEmployer, total: philTotal },
    pagibig: { employee: pagibigEmployee, employer: pagibigEmployer, total: pagibigTotal },
    stPeter: { employee: stPeter },
    // also expose a simple sum of employee-side deductions (what's withheld)
    total: sssEmployee + philEmployee + pagibigEmployee + stPeter
  };

  const netCents = grossCents - deductions.total;

  // Return monetary values as PHP strings (2 decimals) and also cents for storage
  return {
    gross: fromCents(grossCents),
    gross_cents: grossCents,
    deductions: {
      total: fromCents(deductions.total),
      cents: deductions.total,
      breakdown: {
        sss_employee: fromCents(deductions.sss.employee),
        sss_employer: fromCents(deductions.sss.employer),
        phil_employee: fromCents(deductions.philhealth.employee),
        phil_employer: fromCents(deductions.philhealth.employer),
        pagibig_employee: fromCents(deductions.pagibig.employee),
        pagibig_employer: fromCents(deductions.pagibig.employer),
        stPeter_employee: fromCents(deductions.stPeter.employee)
      }
    },
    net: fromCents(netCents),
    net_cents: netCents
  };
}

/*
Notes for payroll-utils.js

If you want fully accurate SSS computation by MSC bracket (instead of simple cap-based approximation), I can import the official SSS MSC table and map salary to MSC bracket exactly — I left a comment where to plug that table. The current implementation is intentionally concise and correct for most mid-sized payrolls.

PhilHealth splitting is implemented 50/50 per the PhilHealth advisory.

Pag-IBIG behavior uses a P10,000 cap and 1%/2% logic (common in 2025 guidance).
*/
