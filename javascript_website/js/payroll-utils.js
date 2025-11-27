// /js/payroll-utils.js
// small payroll math utilities — cents-based arithmetic to avoid floating point drift

// config (editable)
export const PAYROLL_CONFIG = {
  // OT premium multiplier (additional on top of base pay already counted in daysWorked)
  // 1.25 means each OT hour adds 125% of the hourly rate as OT premium.
  // Since the base pay for those hours is already in daysWorked * ratePerDay,
  // effective OT compensation per hour is 225% of the normal hourly rate.
  otMultiplier: 1.25,
  // Night differential premium rate (10% of hourly rate for ND hours)
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

// -------------------------- attendance / scanner helpers --------------------------
/** buildShiftDate(shiftHHMM, referenceDate)
 *  Convert an HH:mm string into a Date on the same day as the provided referenceDate.
 *  @param {string} shiftHHMM - e.g. "06:00"
 *  @param {Date|string|number} referenceDate - date (or parsable) to copy the day from
 *  @returns {Date}
 */
export function buildShiftDate(shiftHHMM, referenceDate) {
  const [hh, mm] = String(shiftHHMM).split(':').map(Number);
  const d = new Date(referenceDate);
  d.setHours(Number.isFinite(hh) ? hh : 0, Number.isFinite(mm) ? mm : 0, 0, 0);
  return d;
}

/** normalizeTimeIn(rawTime, shiftStartHHMM, windowMin = 10)
 *  If the raw scan time is within ±windowMin minutes of the shift start,
 *  round it to the exact shift start. Otherwise return the original time.
 */
export function normalizeTimeIn(rawTime, shiftStartHHMM, windowMin = 10) {
  const time = new Date(rawTime);
  const shiftStart = buildShiftDate(shiftStartHHMM, time);

  const earlyWindow = new Date(shiftStart.getTime() - windowMin * 60 * 1000);
  const lateWindow  = new Date(shiftStart.getTime() + windowMin * 60 * 1000);

  if (time >= earlyWindow && time <= lateWindow) {
    return new Date(shiftStart); // rounded
  }
  return time;
}

/** evaluateAttendance(rawTime, shiftStartHHMM, config)
 *  Determine status: on-time / late / absent according to thresholds.
 *  - late if minutes after shift start >= lateThresholdMin
 *  - absent if minutes after shift start >= absentThresholdMin
 *  Returns object: { status, minutesLate, recordedTime, shiftStart }
 */
export function evaluateAttendance(rawTime, shiftStartHHMM, config = {}) {
  const lateMin   = config.lateThresholdMin   ?? 30;
  const absentMin = config.absentThresholdMin ?? 60;
  const roundMin  = config.roundWindowMin     ?? 10;

  const normalized = normalizeTimeIn(rawTime, shiftStartHHMM, roundMin);
  const shiftStart = buildShiftDate(shiftStartHHMM, normalized);

  const diffMs  = normalized - shiftStart;
  const diffMin = diffMs > 0 ? Math.floor(diffMs / 60000) : 0;

  let status = "on-time";
  if (diffMin >= absentMin) status = "absent";
  else if (diffMin >= lateMin) status = "late";

  return {
    status,          // "on-time", "late", "absent"
    minutesLate: diffMin,
    recordedTime: normalized,
    shiftStart
  };
}

// Simple mapping for assigned shift names to HH:mm start times
export const SHIFT_STARTS = {
  morning: '06:00',
  mid:     '14:00',
  night:   '22:00'
};

/** evaluateForUser(user, rawTime)
 *  Convenience wrapper that looks up the user's assigned shift and evaluates attendance.
 *  Expects `user.shift` to be one of the keys in SHIFT_STARTS.
 */
export function evaluateForUser(user, rawTime) {
  const shiftHHMM = SHIFT_STARTS[user.shift] || SHIFT_STARTS.morning;
  return evaluateAttendance(rawTime, shiftHHMM);
}

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

  // night differential premium:
  // - regular ND hours: +10% of hourly
  // - ND on OT hours:   also +10% of hourly (OT premium handled separately below)
  if (ndRegularHours > 0) {
    const ndRegExtra = Math.round(hourlyCents * ndRegularHours * PAYROLL_CONFIG.ndRate);
    grossCents += ndRegExtra;
  }
  if (ndOtH > 0) {
    const ndOtExtra = Math.round(hourlyCents * ndOtH * PAYROLL_CONFIG.ndRate);
    grossCents += ndOtExtra;
  }

  // overtime: add OT premium on top of base pay already included via daysWorked
  if (Number(otHours) > 0) {
    // Each OT hour contributes an additional PAYROLL_CONFIG.otMultiplier * hourly
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
  // NOTE: adjustmentsCents represents deduction-type adjustments (loans, cash advances, UT/late amounts)
  // These should not be added to gross; they are included in the deductions.total instead.

  // ------------------ deductions ------------------
  // If a monthlySalary is provided, compute statutory contributions from it
  // and scale by periodScaling (1.0 = full monthly). Otherwise, fall back to
  // simple-percentage approximations on the gross.
  let sssEmployee = 0, sssEmployer = 0, sssTotal = 0;
  let philEmployee = 0, philEmployer = 0, philTotal = 0;
  let pagibigEmployee = 0, pagibigEmployer = 0, pagibigTotal = 0;

  // --- SSS: still based on monthly salary + SSS table/approx ---
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
  } else {
    // legacy simple-percent fallback on gross when no monthly base is available
    sssEmployee = Math.round(grossCents * PAYROLL_CONFIG.sssPercent);
    sssEmployer = 0;
    sssTotal = sssEmployee;
  }

  // --- PhilHealth (custom rule): 2.5% of 26 days * daily rate, employee-only ---
  const dailyRateNum = Number(ratePerDay || 0);
  const philhealthBasePHP = dailyRateNum * 26 * 0.025; // 2.5% of 26 days * ratePerDay
  philEmployee = Math.round(philhealthBasePHP * 100);
  philEmployer = 0;
  philTotal = philEmployee;

  // --- Pag-IBIG (custom rule): fixed 200 PHP, employee-only ---
  const pagibigPHP = 200;
  pagibigEmployee = Math.round(pagibigPHP * 100);
  pagibigEmployer = 0;
  pagibigTotal = pagibigEmployee;

  // St. Peter Life Plan (employee-only)
  const stPeter = Math.round(grossCents * Number(PAYROLL_CONFIG.stPeterPercent || 0));

  // Compose deductions object (employee-side amounts in cents)
  const totalDeductionCents =
    sssEmployee +
    philEmployee +
    pagibigEmployee +
    stPeter +
    (typeof adjustmentsCents === 'number' ? adjustmentsCents : 0);

  const deductions = {
    sss: { employee: sssEmployee, employer: sssEmployer, total: sssTotal },
    philhealth: { employee: philEmployee, employer: philEmployer, total: philTotal },
    pagibig: { employee: pagibigEmployee, employer: pagibigEmployer, total: pagibigTotal },
    stPeter: { employee: stPeter },
    // include adjustmentsCents (loans, cash advance, UT amount etc.)
    // NOTE: computePayrollLine receives 'adjustmentsCents' as a parameter (default 0)
    adjustments_total: typeof adjustmentsCents === 'number' ? adjustmentsCents : 0,
    // simple sum of employee-side deductions (what's withheld) — include adjustments here
    total: totalDeductionCents
  };

  const netCents = grossCents - totalDeductionCents;

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
        stPeter_employee: fromCents(deductions.stPeter.employee),
        adjustments_total: fromCents(deductions.adjustments_total) // expose adjustments in breakdown
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
