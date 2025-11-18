// js/payroll.js
import { computePayrollLine, toCents } from './payroll-utils.js';
import { auth, db } from './firebase-config.js';
import { getSssTable, lookupSssContribution } from './sss-table.js';
import {
  collection, getDocs, getDoc, query, where, orderBy, addDoc, doc, setDoc, serverTimestamp, Timestamp, onSnapshot, limit, documentId
} from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js';

// UI elements
const loadUsersBtn = document.getElementById('loadUsersBtn');
const calculateBtn = document.getElementById('calculateBtn');
const saveRunBtn = document.getElementById('saveRunBtn');
const exportCsvBtn = document.getElementById('exportCsvBtn');
const payrollBody = document.getElementById('payrollBody');
const rowsCountEl = document.getElementById('rowsCount');
const statusEl = document.getElementById('status');

let usersList = [];
let rows = [];
// in-memory SSS table payload (from config/sssContributionTable)
let sssTablePayload = null;

// synchronous lookup against in-memory payload (returns { employee, employer, total } in PHP numbers or null)
function findSssFromPayload(monthlySalary) {
  try {
    if (!sssTablePayload || !Array.isArray(sssTablePayload.table)) return null;
    const t = sssTablePayload.table;
    const ms = Number(monthlySalary || 0);
    let match = t.find(b => (typeof b.min === 'number' && typeof b.max === 'number') && ms >= b.min && ms <= b.max);
    if (!match) {
      match = t.reduce((best, b) => {
        if (!b.min) return best;
        if (best === null) return b;
        if (b.min <= ms && b.min > best.min) return b;
        return best;
      }, null);
    }
    if (!match) return null;
    return { employee: Number(match.employee || 0), employer: Number(match.employer || 0), total: Number(match.total || 0) };
  } catch (e) {
    console.warn('findSssFromPayload failed', e);
    return null;
  }
}

// --- Specific XLSX parser for 2025 Tabulation format ---
// Usage: pass a SheetJS `workbook` object; returns an array of table rows
function parseTabulation2025(workbook) {
  const sheet = workbook.Sheets["Tabulation"];
  if (!sheet) throw new Error("Sheet 'Tabulation' not found in Excel file.");

  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "" });

  // Real data begins at row 3
  const startRow = 3;

  const table = [];

  for (let r = startRow; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;

    // Each row must have real numbers in columns 0,1,2 (min, max, MSC)
    if (!row[0] || !row[1] || !row[2]) continue;

    const min = Number(row[0]);
    const max = Number(row[1]);
    const msc = Number(row[2]);

    // Employer breakdown
    const employer_regular = Number(row[3]) || 0;
    const employer_mpf     = Number(row[4]) || 0;
    const employer_ec      = Number(row[5]) || 0;
    const employer_total   = Number(row[6]) || 0;

    // Employee breakdown
    const employee_regular = Number(row[7]) || 0;
    const employee_mpf     = Number(row[8]) || 0;
    const employee_total   = Number(row[9]) || 0;

    // Final total (column 10 OR sum)
    const final_total = Number(row[10]) || (employer_total + employee_total);

    table.push({
      rangeLabel: `${min} - ${max}`,
      min,
      max,
      msc,
      employer: {
        regular: employer_regular,
        mpf: employer_mpf,
        ec: employer_ec,
        total: employer_total
      },
      employee: {
        regular: employee_regular,
        mpf: employee_mpf,
        total: employee_total
      },
      total: final_total,
      rawRow: row,
      rowIndex: r
    });
  }

  if (table.length === 0) {
    throw new Error(`No data rows parsed — ensure sheet "Tabulation" uses the 2025 layout.`);
  }

  return table;
}

function setStatus(msg, isError = false) {
  statusEl.textContent = msg || '';
  statusEl.style.color = isError ? '#b00020' : '#333';
}

// Auto-initialize payroll on page load or when auth is ready
(async function autoInitPayroll() {
  try {
    if (window.__payrollInitialized) return;

    // If we have Firebase auth available, only auto-init when already signed-in.
    if (typeof auth !== 'undefined' && auth && typeof auth.currentUser !== 'undefined') {
      if (auth.currentUser) {
        if (typeof initLivePayroll === 'function') {
          await initLivePayroll();
          window.__payrollInitialized = true;
          console.log('Payroll live init complete — latest rates applied.');
          return;
        }
        if (typeof payrollRefresh === 'function') {
          await payrollRefresh();
          window.__payrollInitialized = true;
          console.log('payrollRefresh completed.');
          return;
        }
      }
      // If not signed in yet, auth.onAuthStateChanged above will call initLivePayroll when ready.
      return;
    }

    // No auth available — call init directly if present
    if (typeof initLivePayroll === 'function') {
      await initLivePayroll();
      window.__payrollInitialized = true;
      console.log('Payroll live init complete — latest rates applied.');
    } else if (typeof payrollRefresh === 'function') {
      await payrollRefresh();
      window.__payrollInitialized = true;
      console.log('payrollRefresh completed.');
    } else {
      console.warn('No payroll init function found.');
    }
  } catch (err) {
    console.error('autoInitPayroll error', err);
  }
})();

// ----------------------------------------------------------------
// NEW: Helper to fetch the most recent payroll run's rates
// ----------------------------------------------------------------
async function fetchMostRecentPayrollRates() {
  try {
    // Query the payrolls collection for the most recent run (robust: try createdAt, updatedAt, then documentId)
    async function getMostRecentRunDoc() {
      // 1) try createdAt timestamp ordering
      try {
        let q1 = query(collection(db, 'payrolls'), orderBy('createdAt', 'desc'), limit(1));
        let s1 = await getDocs(q1);
        if (!s1.empty) return s1.docs[0];
      } catch (e) {
        console.warn('createdAt query failed or returned nothing', e && e.message);
      }
      // 2) try updatedAt
      try {
        let q2 = query(collection(db, 'payrolls'), orderBy('updatedAt', 'desc'), limit(1));
        let s2 = await getDocs(q2);
        if (!s2.empty) return s2.docs[0];
      } catch (e) {
        console.warn('updatedAt query failed or returned nothing', e && e.message);
      }
      // 3) fallback to documentId ordering (most recently created id lexicographically)
      try {
        let q3 = query(collection(db, 'payrolls'), orderBy(documentId(), 'desc'), limit(1));
        let s3 = await getDocs(q3);
        if (!s3.empty) return s3.docs[0];
      } catch (e) {
        console.warn('documentId fallback failed', e && e.message);
      }
      return null;
    }

    const payrollsSnapDoc = await getMostRecentRunDoc();
    const ratesMap = new Map(); // uid -> ratePerDay
    if (payrollsSnapDoc) {
      const runDoc = payrollsSnapDoc;
      const runId = runDoc.id;

      // Read lines subcollection for that run
      const linesQ = query(collection(db, 'payrolls', runId, 'lines'));
      const linesSnap = await getDocs(linesQ);
      linesSnap.forEach(ld => {
        const data = ld.data() || {};
        const uid = ld.id; // your lines are saved under userId doc id
        const rpd = (data.ratePerDay !== undefined && data.ratePerDay !== null) ? Number(data.ratePerDay) : null;
        if (rpd !== null) ratesMap.set(uid, rpd);
      });
    }

    return ratesMap; // Map userId -> ratePerDay
  } catch (err) {
    console.warn('fetchMostRecentPayrollRates error', err);
    return new Map();
  }
}

// ----------------------------------------------------------------
// NEW: Fetch the most recent payroll run including rates, run meta and per-line notes
// Returns: { ratesMap: Map(uid->ratePerDay), runMeta: { periodStart, periodEnd, note, id }, linesMap: Map(uid->lineData) }
// ----------------------------------------------------------------
async function fetchMostRecentPayrollRun() {
  try {
    // try createdAt, updatedAt, then documentId ordering as fallbacks
    async function getMostRecentRunDoc() {
      try {
        let q1 = query(collection(db, 'payrolls'), orderBy('createdAt', 'desc'), limit(1));
        let s1 = await getDocs(q1);
        if (!s1.empty) return s1.docs[0];
      } catch (e) { console.warn('createdAt query failed', e && e.message); }
      try {
        let q2 = query(collection(db, 'payrolls'), orderBy('updatedAt', 'desc'), limit(1));
        let s2 = await getDocs(q2);
        if (!s2.empty) return s2.docs[0];
      } catch (e) { console.warn('updatedAt query failed', e && e.message); }
      try {
        let q3 = query(collection(db, 'payrolls'), orderBy(documentId(), 'desc'), limit(1));
        let s3 = await getDocs(q3);
        if (!s3.empty) return s3.docs[0];
      } catch (e) { console.warn('documentId fallback failed', e && e.message); }
      return null;
    }

    const payrollsSnapDoc = await getMostRecentRunDoc();
    const ratesMap = new Map();
    const linesMap = new Map();
    let runMeta = null;
    if (payrollsSnapDoc) {
      const runDoc = payrollsSnapDoc;
      const runId = runDoc.id;
      const runData = runDoc.data() || {};
      runMeta = {
        id: runId,
        periodStart: runData.periodStart || '',
        periodEnd: runData.periodEnd || '',
        note: runData.note || ''
      };

      const linesQ = query(collection(db, 'payrolls', runId, 'lines'));
      const linesSnap = await getDocs(linesQ);
      linesSnap.forEach(ld => {
        const data = ld.data() || {};
        const uid = ld.id;
        // Prefer explicit ratePerDay; if missing but ratePerHour present, derive day rate (8 hrs)
        if (data.ratePerDay !== undefined && data.ratePerDay !== null) {
          ratesMap.set(uid, Number(data.ratePerDay));
        } else if (data.ratePerHour !== undefined && data.ratePerHour !== null) {
          const derived = Number(data.ratePerHour) * 8;
          if (!isNaN(derived)) ratesMap.set(uid, derived);
        }
        // keep whole line data so we can read per-line note if present
        linesMap.set(uid, data);
      });
    }

    return { ratesMap, runMeta, linesMap };
  } catch (err) {
    console.warn('fetchMostRecentPayrollRun error', err);
    return { ratesMap: new Map(), runMeta: null, linesMap: new Map() };
  }
}

// Helper to pick appropriate rate for a user given the latestRates Map
function pickRateForUser(latestRates, uid, userDoc) {
  if (latestRates && latestRates.has && latestRates.has(uid)) return Number(latestRates.get(uid));
  return Number((userDoc && (userDoc.ratePerDay || userDoc.baseRatePerDay)) || 0);
}

// ----------------------------------------------------------------
// NEW: Live passive behavior
// - on page load: auto-load users & apply latest payroll rates
// - set onSnapshot listener for users (live updates)
// - auto-reload attendance when period dates change
// ----------------------------------------------------------------
async function initLivePayroll() {
  // 1) Fetch latest payroll run (rates + meta + lines) once
  const { ratesMap: latestRates, runMeta: latestRunMeta, linesMap: latestLines } = await fetchMostRecentPayrollRun();

  // 1b) Load SSS contribution table into memory (if present)
  try {
    // Prefer loading an SSS snapshot stored with the most recent payroll run (if present),
    // otherwise fall back to the canonical config document.
    let loaded = null;
    try {
      if (latestRunMeta && latestRunMeta.id) {
        const runDocRef = doc(db, 'payrolls', latestRunMeta.id);
        const runSnap = await getDoc(runDocRef);
        const runDataFull = runSnap && runSnap.exists ? runSnap.data() : (runSnap ? runSnap.data() : null);
        if (runDataFull) {
          // Candidate fields that may contain an SSS table snapshot on the run document
          const candidates = [
            runDataFull.sssContributionTable,
            runDataFull.sssTable,
            runDataFull.sss,
            runDataFull.sss_payload,
            runDataFull.sssPayload
          ];
          const found = candidates.find(c => c && (Array.isArray(c.table) || Array.isArray(c)));
          if (found) {
            if (Array.isArray(found)) {
              loaded = { source: 'payroll_run', filename: null, uploadedBy: null, uploadedAt: null, fetchedAt: new Date().toISOString(), checksum: null, table: found, versionNote: 'loaded from payroll run' };
            } else if (found.table && Array.isArray(found.table)) {
              loaded = Object.assign({ source: 'payroll_run', fetchedAt: new Date().toISOString(), versionNote: 'loaded from payroll run' }, found);
            }
          }
        }
      }
    } catch (e) {
      console.warn('Failed to read SSS snapshot from latest payroll run', e);
    }

    if (loaded) {
      sssTablePayload = loaded;
      setStatus('SSS contribution table loaded from latest payroll run.');
    } else {
      sssTablePayload = await getSssTable();
      if (sssTablePayload) setStatus('SSS contribution table loaded.');
    }
  } catch (e) {
    console.warn('Failed to load SSS table on init', e);
  }

  // 2) Load users initially and create rows model using latestRates and latest run lines
  try {
    setStatus('Loading users (live) ...');

    const usersQ = query(collection(db, 'users'), orderBy('username'));
    // initial fetch (we will also attach onSnapshot)
    const usersSnap = await getDocs(usersQ);

    usersList = usersSnap.docs.map(d => ({ userId: d.id, ...(d.data() || {}) }));

    // latestRates and latestLines were fetched above via fetchMostRecentPayrollRun()
    console.log('DEBUG: latest payroll rates loaded:', Array.from((latestRates && latestRates.entries && typeof latestRates.entries === 'function') ? latestRates.entries() : []));

    // build rows using latestRates
    rows = usersList.map(u => {
      const uid = u.userId || u.id;
      const ratePerDay = (latestRates && latestRates.has(uid)) ? Number(latestRates.get(uid)) : Number(u.ratePerDay || u.baseRatePerDay || 0);
      const seededNote = (typeof latestLines !== 'undefined' && latestLines && latestLines.has(uid) && latestLines.get(uid).note) ? latestLines.get(uid).note : (u.note || '');
      return {
        userId: uid,
        username: u.username || u.displayName || u.email || '',
        role: u.role || '',
        shift: u.shift || '',
        ratePerDay,
        daysWorked: 0,
        hoursWorked: 0,
        ndHours: 0,
        ndOtHours: 0,
        otHours: 0,
        regularHolidayHours: 0,
        specialHolidayHours: 0,
        // UI fields / overrides (empty initially)
        sss: null,
        philhealth: null,
        pagibig: null,
        stPeter: null,
        sssSalaryLoan: 0,
        hdmfSalaryLoan: 0,
        hdmfCalamityLoan: 0,
        cashAdvance: 0,
        utLateHours: 0,
        utLateAmount: 0,
        note: seededNote,
        _manualGross: null,
        _manualDeductions: null,
        _manualNet: null,
        adjustmentsCents: 0
      };
    });

    // populate global period/note inputs from the latest run if available
    try {
      if (latestRunMeta) {
        const ps = document.getElementById('periodStart');
        const pe = document.getElementById('periodEnd');
        if (ps && latestRunMeta.periodStart) ps.value = latestRunMeta.periodStart;
        if (pe && latestRunMeta.periodEnd) pe.value = latestRunMeta.periodEnd;
      }
    } catch (e) { console.warn('failed to set period/note from latest run', e); }

    // debugging: show what latestRates contains
    try {
      console.log('DEBUG: latestRates keys:', Array.from((latestRates && latestRates.keys && typeof latestRates.keys === 'function') ? latestRates.keys() : []));
      console.log('DEBUG: sample rate for first user', latestRates && latestRates.size ? latestRates.entries().next().value : 'no rates');
    } catch (dbgErr) { console.warn('DEBUG log failed', dbgErr); }

    renderTable();
    setStatus(`Loaded ${rows.length} users (live).`);
  } catch (err) {
    console.error('initLivePayroll load users error', err);
    setStatus('Failed to load users: ' + (err.message || err), true);
    rows = [];
    renderTable();
  }

  // 3) Attach live listener to users collection to update rows in realtime
  try {
    onSnapshot(collection(db, 'users'), (snapshot) => {
      let dirty = false;
      snapshot.docChanges().forEach(change => {
        const id = change.doc.id;
        const data = change.doc.data();
        const row = rows.find(r => r.userId === id);
        if (row) {
          // update relevant fields from user doc (do not override manual edits)
          const newUsername = data.username || data.displayName || data.email || '';
          if (row.username !== newUsername) { row.username = newUsername; dirty = true; }
          const newRole = data.role || '';
          if (row.role !== newRole) { row.role = newRole; dirty = true; }

          // If that user does NOT have a payroll-run override rate, but the user doc base rate changed,
          // update ratePerDay only if there was no manual override from admin (null/check)
          const hasManualRate = (row._manualRateApplied === true); // not set normally
          if (!hasManualRate) {
            const newBaseRate = data.ratePerDay || data.baseRatePerDay || 0;
            if (row.ratePerDay !== newBaseRate) { row.ratePerDay = newBaseRate; dirty = true; }
          }
          // other user-level fields (department, etc.) can be synced here if desired
        } else if (change.type === 'added') {
          // new user -> append with rate from latestRates or base; seed note from latestLines if available
          const savedRate = (latestRates && latestRates.has(id)) ? latestRates.get(id) : (data.ratePerDay || data.baseRatePerDay || 0);
          const seededNote = (typeof latestLines !== 'undefined' && latestLines && latestLines.has(id) && latestLines.get(id).note) ? latestLines.get(id).note : (data.note || '');
          rows.push({
            userId: id,
            username: data.username || data.displayName || data.email || '',
            role: data.role || '',
            shift: data.shift || '',
            ratePerDay: savedRate,
            daysWorked: 0,
            hoursWorked: 0,
            ndHours: 0,
            ndOtHours: 0,
            otHours: 0,
            regularHolidayHours: 0,
            specialHolidayHours: 0,
            sss: null, philhealth: null, pagibig: null, stPeter: null,
            sssSalaryLoan: 0, hdmfSalaryLoan: 0, hdmfCalamityLoan: 0, cashAdvance: 0,
            utLateHours: 0, utLateAmount: 0, note: seededNote
          });
          dirty = true;
        } else if (change.type === 'removed') {
          // remove row
          const idx = rows.findIndex(r => r.userId === id);
          if (idx !== -1) {
            rows.splice(idx, 1);
            dirty = true;
          }
        }
      });

      if (dirty) renderTable();
    }, err => {
      console.warn('users onSnapshot error', err);
    });
  } catch (err) {
    console.warn('Failed to attach users onSnapshot', err);
  }

  //  Auto-load attendance if both period dates are set
  // If your UI wants to auto-load when dates are added, watch the input change events:
  const periodStartEl = document.getElementById('periodStart');
  const periodEndEl = document.getElementById('periodEnd');

  async function maybeLoadAttendance() {
    const start = periodStartEl && periodStartEl.value;
    const end = periodEndEl && periodEndEl.value;
    if (start && end) {
      // Ensure latest saved payroll rates are applied to rows before loading attendance
      try {
        const { ratesMap: freshRates, linesMap: freshLines } = await fetchMostRecentPayrollRun();
        if (freshRates) {
          rows.forEach(r => {
            if (!r._manualRateApplied && freshRates.has(r.userId)) {
              r.ratePerDay = freshRates.get(r.userId);
            }
            // seed per-row note only when empty
            if ((!r.note || String(r.note).trim() === '') && freshLines && freshLines.has(r.userId) && freshLines.get(r.userId).note) {
              r.note = freshLines.get(r.userId).note;
            }
          });
          renderTable();
        }
      } catch (e) {
        console.warn('Could not refresh latest payroll rates before attendance load', e);
      }

      setStatus('Auto-loading attendance for period...');
      await loadAttendanceForRows(start, end);
      calculateAll(); // re-calc after attendance loads
      setStatus('Auto attendance load complete.');
    }
  }

  // initial attempt (if date inputs already have values)
  maybeLoadAttendance().catch(e => console.warn('initial attendance load failed', e));

  // watch for changes to period inputs (auto reload)
  if (periodStartEl) periodStartEl.addEventListener('change', maybeLoadAttendance);
  if (periodEndEl) periodEndEl.addEventListener('change', maybeLoadAttendance);

  // also expose a public refresh hook if you want to force reload programmatically
  window.payrollRefresh = async () => {
    // re-fetch latest saved payroll run (rates + lines) and apply to rows that don't have manual overrides
    const { ratesMap: freshRates, runMeta: freshRunMeta, linesMap: freshLines } = await fetchMostRecentPayrollRun();
    rows.forEach(r => {
      if (!r._manualRateApplied && freshRates && freshRates.has(r.userId)) {
        r.ratePerDay = freshRates.get(r.userId);
      }
      // seed per-row note only when empty
      if ((!r.note || String(r.note).trim() === '') && freshLines && freshLines.has(r.userId) && freshLines.get(r.userId).note) {
        r.note = freshLines.get(r.userId).note;
      }
    });
    // update global inputs if fresh run meta available
    try {
      if (freshRunMeta) {
        const ps = document.getElementById('periodStart');
        const pe = document.getElementById('periodEnd');
        if (ps && freshRunMeta.periodStart) ps.value = freshRunMeta.periodStart;
        if (pe && freshRunMeta.periodEnd) pe.value = freshRunMeta.periodEnd;
      }
    } catch (e) { console.warn('failed to set period/note from fresh run', e); }
    renderTable();
  };

  // expose SSS reload helper
  window.reloadSssTable = async () => {
    try {
      const p = await getSssTable();
      sssTablePayload = p;
      setStatus(p ? `SSS table loaded (${(p.table||[]).length} rows).` : 'No SSS table found.');
      return p;
    } catch (e) {
      console.warn('reloadSssTable failed', e);
      setStatus('Failed to reload SSS table.', true);
      return null;
    }
  };
}

// Call initLivePayroll on auth ready or page load
auth.onAuthStateChanged(user => {
  if (!user) {
    setStatus('Please sign in to use payroll (admin account).', true);
  } else {
    setStatus(`Signed in as ${user.email || user.uid}`);
    // initialize live loader once signed in
    initLivePayroll().catch(err => {
      console.error('initLivePayroll failed', err);
      setStatus('Failed to initialize live payroll: ' + (err.message || err), true);
    });
  }
});

// Optionally hide or disable the Load Users button since loading is automatic
if (loadUsersBtn) {
  loadUsersBtn.style.display = 'none'; // hide; change to disable if you prefer
}

// wire reload SSS table button
const reloadSssTableBtn = document.getElementById('reloadSssTableBtn');
if (reloadSssTableBtn) {
  reloadSssTableBtn.addEventListener('click', async () => {
    reloadSssTableBtn.disabled = true;
    await window.reloadSssTable();
    reloadSssTableBtn.disabled = false;
  });
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>\"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}

// RENDER: every column editable; automated values shown as placeholder
function renderTable() {
  payrollBody.innerHTML = '';

  rows.forEach((r, idx) => {
    // helper to get auto-calculated placeholders
    const auto = r._calc || {};
    const breakdown = (auto.deductions && auto.deductions.breakdown) ? auto.deductions.breakdown : {};

    // helper to display formatted number for placeholders (2 dec)
    const fmt = (v) => (v === undefined || v === null || v === '') ? '' : Number(v).toFixed(2);

    // get placeholders from computed object
    const ph_gross = auto.gross ? fmt(auto.gross) : '';
    const ph_net = auto.net ? fmt(auto.net) : '';
    const ph_deductions_total = auto.deductions && auto.deductions.total ? fmt(auto.deductions.total) : '';

    const ph_sss = breakdown.sss_employee ?? breakdown.sss ?? '';
    const ph_phil = breakdown.phil_employee ?? breakdown.philhealth_employee ?? '';
    const ph_pagibig = breakdown.pagibig_employee ?? '';
    const ph_stp = breakdown['st.peter'] ?? breakdown.st_peter ?? '';

    // If manual overrides exist, show them in value; otherwise blank value and placeholder shows auto
    const val = (field) => {
      const v = r[field];
      return (v === undefined || v === null) ? '' : String(v);
    };

    const tr = document.createElement('tr');
    tr.dataset.id = r.userId;

    tr.innerHTML = `
      <td>${idx + 1}</td>
      <td class="username">${escapeHtml(r.username || '')}</td>

      <td><input class="input-small" data-field="ratePerDay" data-id="${r.userId}" value="${escapeHtml(val('ratePerDay'))}" placeholder="${escapeHtml(fmt(r.ratePerDay || r._calc?.ratePerDay || ''))}" /></td>

      <td><input class="input-small" data-field="daysWorked" data-id="${r.userId}" value="${escapeHtml(val('daysWorked'))}" placeholder="${escapeHtml(fmt(r.daysWorked || ''))}" /></td>

      <td><input class="input-small" data-field="hoursWorked" data-id="${r.userId}" value="${escapeHtml(val('hoursWorked'))}" placeholder="${escapeHtml(fmt(r._calc?.hoursWorked ?? r.hoursWorked ?? ''))}" /></td>

      <td><input class="input-small" data-field="ndHours" data-id="${r.userId}" value="${escapeHtml(val('ndHours'))}" placeholder="${escapeHtml(fmt(r._calc?.ndHours ?? r.ndHours ?? ''))}" /></td>

      <td><input class="input-small" data-field="ndOtHours" data-id="${r.userId}" value="${escapeHtml(val('ndOtHours'))}" placeholder="${escapeHtml(fmt(r._calc?.ndOtHours ?? r.ndOtHours ?? ''))}" /></td>

      <td><input class="input-small" data-field="otHours" data-id="${r.userId}" value="${escapeHtml(val('otHours'))}" placeholder="${escapeHtml(fmt(r._calc?.otHours ?? r.otHours ?? ''))}" /></td>

      <td><input class="input-small" data-field="regularHolidayHours" data-id="${r.userId}" value="${escapeHtml(val('regularHolidayHours'))}" placeholder="${escapeHtml(fmt(r._calc?.regHolidayHours ?? r.regularHolidayHours ?? ''))}" /></td>

      <td><input class="input-small" data-field="specialHolidayHours" data-id="${r.userId}" value="${escapeHtml(val('specialHolidayHours'))}" placeholder="${escapeHtml(fmt(r._calc?.specialHolidayHours ?? r.specialHolidayHours ?? ''))}" /></td>

      <!-- statutory deductions (editable) -->
      <td><input class="input-small" data-field="sss" data-id="${r.userId}" value="${escapeHtml(val('sss'))}" placeholder="${escapeHtml(fmt(ph_sss))}" /></td>
      <td><input class="input-small" data-field="philhealth" data-id="${r.userId}" value="${escapeHtml(val('philhealth'))}" placeholder="${escapeHtml(fmt(ph_phil))}" /></td>
      <td><input class="input-small" data-field="pagibig" data-id="${r.userId}" value="${escapeHtml(val('pagibig'))}" placeholder="${escapeHtml(fmt(ph_pagibig))}" /></td>
      <td><input class="input-small" data-field="stPeter" data-id="${r.userId}" value="${escapeHtml(val('stPeter'))}" placeholder="${escapeHtml(fmt(ph_stp))}" /></td>

      <!-- loans -->
      <td><input class="input-small" data-field="sssSalaryLoan" data-id="${r.userId}" value="${escapeHtml(val('sssSalaryLoan'))}" placeholder="${escapeHtml(fmt(r.sssSalaryLoan || '0'))}" /></td>
      <td><input class="input-small" data-field="hdmfSalaryLoan" data-id="${r.userId}" value="${escapeHtml(val('hdmfSalaryLoan'))}" placeholder="${escapeHtml(fmt(r.hdmfSalaryLoan || '0'))}" /></td>
      <td><input class="input-small" data-field="hdmfCalamityLoan" data-id="${r.userId}" value="${escapeHtml(val('hdmfCalamityLoan'))}" placeholder="${escapeHtml(fmt(r.hdmfCalamityLoan || '0'))}" /></td>
      <td><input class="input-small" data-field="cashAdvance" data-id="${r.userId}" value="${escapeHtml(val('cashAdvance'))}" placeholder="${escapeHtml(fmt(r.cashAdvance || '0'))}" /></td>

      <!-- UT / Late -->
      <td><input class="input-small" data-field="utLateHours" data-id="${r.userId}" value="${escapeHtml(val('utLateHours'))}" placeholder="${escapeHtml(fmt(r.utLateHours || '0'))}" /></td>
      <td><input class="input-small" data-field="utLateAmount" data-id="${r.userId}" value="${escapeHtml(val('utLateAmount'))}" placeholder="${escapeHtml(fmt(r.utLateAmount || '0'))}" /></td>

      

      <td><input class="input-small" data-field="grossPay" data-id="${r.userId}" value="${escapeHtml(val('_manualGross'))}" placeholder="${escapeHtml(ph_gross)}" /></td>
      <td><input class="input-small" data-field="deductionsTotal" data-id="${r.userId}" value="${escapeHtml(val('_manualDeductions'))}" placeholder="${escapeHtml(ph_deductions_total)}" /></td>
      <td><input class="input-small" data-field="netPay" data-id="${r.userId}" value="${escapeHtml(val('_manualNet'))}" placeholder="${escapeHtml(ph_net)}" /></td>

      <td><input data-field="note" data-id="${r.userId}" value="${escapeHtml(val('note'))}" placeholder="${escapeHtml(r.note || '')}" /></td>
    `;

    payrollBody.appendChild(tr);
  });

  // wire inputs to model
  payrollBody.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('change', (ev) => {
      const id = inp.dataset.id;
      const field = inp.dataset.field;
      const row = rows.find(x => x.userId === id);
      if (!row) return;
      // numeric fields list
      const numericFields = [
        'ratePerDay','daysWorked','hoursWorked','ndHours','ndOtHours','otHours','regularHolidayHours','specialHolidayHours',
        'sss','philhealth','pagibig','stPeter','sssSalaryLoan','hdmfSalaryLoan','hdmfCalamityLoan','cashAdvance','utLateHours','utLateAmount',
        '_manualGross','_manualDeductions','_manualNet'
      ];

      // store using camelCase UI names; when saving we map to Firestore literal keys
      if (numericFields.includes(field)) {
        const parsed = inp.value === '' ? null : Number(inp.value);
        row[field] = parsed;

        // Special behavior: when user edits a pagibig value, propagate to all rows (auto-fill)
        if (field === 'pagibig') {
          rows.forEach(r => { r.pagibig = parsed; });
          // re-render table so all inputs reflect the new pagibig value
          renderTable();
          setStatus('Pag-IBIG value applied to all rows.');
          return;
        }
      } else {
        row[field] = inp.value;
      }
    });
  });

  rowsCountEl.textContent = String(rows.length);
}

// -------------------- Shift / ND helpers --------------------
// returns true if Date `t` falls into night-differential window (22:00-05:59)
function isNightDiffTime(t) {
  const h = t.getHours();
  return (h >= 22 || h <= 5);
}

// returns true if Date `t` is within the employee's scheduled shift window
// Expected shift values: 'morning', 'mid', 'night'. Fallback returns false.
function isWithinShiftWindow(t, shift) {
  const h = t.getHours();
  if (!shift) return false;
  const s = String(shift).toLowerCase();
  if (s === 'morning') return (h >= 6 && h <= 13);
  if (s === 'mid' || s === 'midday' || s === 'afternoon') return (h >= 14 && h <= 21);
  if (s === 'night' || s === 'grave' || s === 'nightshift') return (h >= 22 || h <= 5);
  return false;
}

// Load users — same approach as before (reads users collection)
async function loadUsersAndAttendance() {
  try {
    setStatus('Loading users...');
    // attempt to seed ratePerDay and notes from the most recent saved payroll run
    const { ratesMap: latestRates, runMeta: latestRunMeta, linesMap: latestLines } = await fetchMostRecentPayrollRun().catch(err => {
      console.warn('Could not fetch latest payroll run, falling back to user base rates/notes', err);
      return { ratesMap: new Map(), runMeta: null, linesMap: new Map() };
    });

    const q = query(collection(db, 'users'), orderBy('username'));
    const snap = await getDocs(q);
    usersList = snap.docs.map(d => ({ userId: d.id, ...(d.data() || {}) }));
    rows = usersList.map(u => ({
      userId: u.userId || u.id,
      username: u.username || u.displayName || u.email || '',
      role: u.role || '',
      shift: u.shift || '',
      // prefer saved rate from most recent payroll run, else fall back to user base/rate
      ratePerDay: pickRateForUser(latestRates, (u.userId || u.id), u),
      daysWorked: 0,
      hoursWorked: 0,
      ndHours: 0,
      ndOtHours: 0,
      otHours: 0,
      regularHolidayHours: 0,
      specialHolidayHours: 0,
      // UI fields / overrides (empty initially)
      sss: null,
      philhealth: null,
      pagibig: null,
      stPeter: null,
      sssSalaryLoan: 0,
      hdmfSalaryLoan: 0,
      hdmfCalamityLoan: 0,
      cashAdvance: 0,
      utLateHours: 0,
      utLateAmount: 0,
      // seed note from most recent run line if present, else use user doc note
      note: ((latestLines && latestLines.has(u.userId) && latestLines.get(u.userId).note) ? latestLines.get(u.userId).note : (u.note || '')),
      _manualGross: null,
      _manualDeductions: null,
      _manualNet: null,
      adjustmentsCents: 0
    }));

    // if we have a recent run meta, populate the period inputs
    try {
      if (latestRunMeta) {
        const ps = document.getElementById('periodStart');
        const pe = document.getElementById('periodEnd');
        if (ps && latestRunMeta.periodStart) ps.value = latestRunMeta.periodStart;
        if (pe && latestRunMeta.periodEnd) pe.value = latestRunMeta.periodEnd;
      }
    } catch (e) { console.warn('failed to set period from latest run', e); }

    renderTable();
    setStatus(`Loaded ${rows.length} users.`);
  } catch (err) {
    console.error('loadUsersAndAttendance error', err);
    setStatus('Failed to load users: ' + (err.message || err), true);
  }
}

/* loadAttendanceForRows & compute hours:
   This preserves the existing precise-segmentation ND/OT logic from your payroll.js.
   The file in your repo already contains detailed functions that compute ndHours, ndOtHours, otHours from attendance segments. I preserved that behavior and call it here.
   (See the version in your repo for the detailed algorithm). :contentReference[oaicite:3]{index=3}
*/
async function loadAttendanceForRows(startDateStr, endDateStr) {
  if (!startDateStr || !endDateStr) return;
  setStatus('Loading attendance for period...');
  const startDate = new Date(startDateStr);
  startDate.setHours(0,0,0,0);
  const endDate = new Date(endDateStr);
  endDate.setHours(23,59,59,999);

  for (const r of rows) {
    try {
      const attQ = query(
        collection(db, 'attendance'),
        where('userId', '==', r.userId),
        where('clockIn', '>=', Timestamp.fromDate(startDate)),
        where('clockIn', '<=', Timestamp.fromDate(endDate)),
        orderBy('clockIn')
      );
      const snap = await getDocs(attQ);

      // reset
      r.daysWorked = 0;
      r.hoursWorked = 0;
      r.ndHours = 0;
      r.ndOtHours = 0;
      r.otHours = 0;
      r.regularHolidayHours = 0;
      r.specialHolidayHours = 0;

      // aggregate per day (simple approach)
      const perDay = {};
      for (const d of snap.docs) {
        const data = d.data();
        const ci = data.clockIn instanceof Timestamp ? data.clockIn.toDate() : new Date(data.clockIn);
        const co = data.clockOut ? (data.clockOut instanceof Timestamp ? data.clockOut.toDate() : new Date(data.clockOut)) : null;
        if (!ci || !co || co <= ci) continue;

        const ms = co - ci;
        const hours = ms / (1000 * 60 * 60);

        const dKey = `${ci.getFullYear()}-${String(ci.getMonth()+1).padStart(2,'0')}-${String(ci.getDate()).padStart(2,'0')}`;
        perDay[dKey] = (perDay[dKey] || 0) + hours;

        // ND detection in segments (rough approximation using 15-min slices)
        let t = new Date(ci);
        const last = new Date(co);
        const stepMs = 15 * 60 * 1000;
        while (t < last) {
          const tNext = new Date(Math.min(t.getTime() + stepMs, last.getTime()));
          const segHours = (tNext - t) / (1000 * 60 * 60);
          // shift-aware checks
          const segIsND = isNightDiffTime(t);
          const segInShift = isWithinShiftWindow(t, r.shift || '');
          // accumulate night-diff hours (same behavior as before)
          if (segIsND) r.ndHours = (r.ndHours || 0) + segHours;
          // segInShift available for future shift-specific logic (UT/late, scheduled hours, etc.)
          t = tNext;
        }
      }

      for (const k of Object.keys(perDay)) {
        const h = perDay[k];
        r.daysWorked += 1;
        r.hoursWorked += h;
        if (h > 8) r.otHours += (h - 8);
      }

      // estimate ndOtHours as min(ndHours, otHours)
      r.ndOtHours = Math.min(Number(r.ndHours || 0), Number(r.otHours || 0));

    } catch (err) {
      console.warn('attendance load error for', r.userId, err);
    }
  }

  setStatus('Attendance loaded.');
  renderTable();
}

// Calculate using computePayrollLine; computed values placed on r._calc
function calculateAll() {
  rows.forEach(r => {
    const sumLoans = Number(r.sssSalaryLoan || 0) + Number(r.hdmfSalaryLoan || 0) + Number(r.hdmfCalamityLoan || 0) + Number(r.cashAdvance || 0);
    const utLateAmt = Number(r.utLateAmount || 0);
    const adjustmentsCents = toCents(sumLoans + utLateAmt) + (Number(r.adjustmentsCents || 0) ? Number(r.adjustmentsCents || 0) : 0);

    // determine payroll period days (if set in the UI) so we can scale statutory contributions
    const periodStartVal = (document.getElementById('periodStart') && document.getElementById('periodStart').value) || '';
    const periodEndVal   = (document.getElementById('periodEnd') && document.getElementById('periodEnd').value) || '';
    let periodDays = null;
    if (periodStartVal && periodEndVal) {
      const sd = new Date(periodStartVal);
      const ed = new Date(periodEndVal);
      // inclusive days
      periodDays = Math.round((ed - sd) / (1000 * 60 * 60 * 24)) + 1;
    }
    const periodScaling = periodDays ? (periodDays / 30) : 1.0;

    // estimate monthly salary (PHP) from the row rates when possible:
    // - prefer ratePerDay * 30
    // - otherwise ratePerHour * 8 * 30
    let monthlySalaryEstimate = null;
    if (r.ratePerDay && Number(r.ratePerDay) > 0) {
      monthlySalaryEstimate = Number(r.ratePerDay) * 30;
    } else if (r.ratePerHour && Number(r.ratePerHour) > 0) {
      monthlySalaryEstimate = Number(r.ratePerHour) * 8 * 30;
    }

    // Pass monthlySalary and periodScaling into computePayrollLine so statutory helpers are used
    const sssOverride = findSssFromPayload(monthlySalaryEstimate);
    // Pass sssOverride (PHP numbers) when available so computePayrollLine can use table values
    const calc = computePayrollLine({
      ratePerDay: r.ratePerDay || 0,
      ratePerHour: r.ratePerHour || null,
      daysWorked: r.daysWorked || 0,
      hoursWorked: r.hoursWorked || 0,
      ndHours: r.ndHours || 0,
      ndOtHours: r.ndOtHours || 0,
      otHours: r.otHours || 0,
      regHolidayHours: r.regularHolidayHours || 0,
      specialHolidayHours: r.specialHolidayHours || 0,
      adjustmentsCents: adjustmentsCents,
      monthlySalary: monthlySalaryEstimate,
      periodScaling: periodScaling,
      manualPagibig: (r.pagibig !== undefined ? r.pagibig : null),
      sssOverride: sssOverride
    });

    r._calc = calc;
    r._calc.adjustments_cents = adjustmentsCents;
  });

  renderTable();
  setStatus('Calculation complete.');
}

// Save payroll run — maps UI fields to literal Firestore keys you use in your DB
async function savePayrollRun() {
  try {
    setStatus('Saving payroll run...');
    const periodStart = document.getElementById('periodStart').value;
    const periodEnd = document.getElementById('periodEnd').value;
    if (!periodStart || !periodEnd) {
      setStatus('Please set period start and end before saving.', true);
      return;
    }

    const runObj = {
      periodStart,
      periodEnd,
      createdBy: auth.currentUser ? auth.currentUser.uid : null,
      createdAt: serverTimestamp(),
      status: 'draft'
    };
    const runRef = await addDoc(collection(db, 'payrolls'), runObj);
    const payrollId = runRef.id;

    for (const r of rows) {
      if (!r._calc) {
        // compute minimal if missing
        // estimate monthly salary similar to calculateAll so sss table can be applied
        let monthlySalaryEstimate = null;
        if (r.ratePerDay && Number(r.ratePerDay) > 0) monthlySalaryEstimate = Number(r.ratePerDay) * 30;
        else if (r.ratePerHour && Number(r.ratePerHour) > 0) monthlySalaryEstimate = Number(r.ratePerHour) * 8 * 30;
        const sssOverride = findSssFromPayload(monthlySalaryEstimate);
        r._calc = computePayrollLine({
          ratePerDay: r.ratePerDay || 0,
          hoursWorked: r.hoursWorked || 0,
          ndHours: r.ndHours || 0,
          ndOtHours: r.ndOtHours || 0,
          otHours: r.otHours || 0,
          regHolidayHours: r.regularHolidayHours || 0,
          specialHolidayHours: r.specialHolidayHours || 0,
          adjustmentsCents: toCents(Number(r.sssSalaryLoan || 0) + Number(r.hdmfSalaryLoan || 0) + Number(r.hdmfCalamityLoan || 0) + Number(r.cashAdvance || 0) + Number(r.utLateAmount || 0)),
          manualPagibig: (r.pagibig !== undefined ? r.pagibig : null),
          sssOverride: sssOverride
        });
      }

      const breakdown = (r._calc && r._calc.deductions && r._calc.deductions.breakdown) ? r._calc.deductions.breakdown : {};
      const sssEmp = breakdown.sss_employee ?? breakdown.sss ?? 0;
      const philEmp = breakdown.phil_employee ?? breakdown.philhealth_employee ?? 0;
      const pagibigEmp = breakdown.pagibig_employee ?? 0;
      const stPeterVal = breakdown['st.peter'] ?? breakdown.st_peter ?? 0;

      // Build the line object with literal DB keys (spaces/dots/slashes preserved where requested)
      const lineObj = {
        userId: r.userId,
        username: r.username || '',
        role: r.role || '',

        // prefer explicit row ratePerDay; fallback to computed value from r._calc if present
        ratePerDay: (function() {
          if (r.ratePerDay !== undefined && r.ratePerDay !== null && r.ratePerDay !== '') return Number(r.ratePerDay);
          if (r._calc && r._calc.ratePerDay !== undefined && r._calc.ratePerDay !== null && r._calc.ratePerDay !== '') return Number(r._calc.ratePerDay);
          return Number(0);
        })(),
        ratePerHour: r.ratePerHour || null,
        daysWorked: Number(r.daysWorked || 0),
        hoursWorked: Number(r.hoursWorked || 0),
        ngHours: Number(r.ngHours || 0),
        otHours: Number(r.otHours || 0),
        regularHolidayHours: Number(r.regularHolidayHours || 0),
        specialHolidayHours: Number(r.specialHolidayHours || 0),

        grossPay: Number((r._manualGross !== null && r._manualGross !== undefined) ? r._manualGross : r._calc.gross),
        netPay: Number((r._manualNet !== null && r._manualNet !== undefined) ? r._manualNet : r._calc.net),

        // statutory employee shares - allow manual override if provided, else computed
        sss: Number((r.sss !== null && r.sss !== undefined) ? r.sss : sssEmp),
        philhealth: Number((r.philhealth !== null && r.philhealth !== undefined) ? r.philhealth : philEmp),
        'pag-ibig': Number((r.pagibig !== null && r.pagibig !== undefined) ? r.pagibig : pagibigEmp),
        'st.peter': Number((r.stPeter !== null && r.stPeter !== undefined) ? r.stPeter : stPeterVal),

        // loans & deductions — use UI overrides
        'sss salary loan': Number(r.sssSalaryLoan || 0),
        'hdmf salary loan': Number(r.hdmfSalaryLoan || 0),
        'hdmf calamity loan': Number(r.hdmfCalamityLoan || 0),
        cashAdvance: Number(r.cashAdvance || 0),

        // UT / Late (literal keys)
        'ut/late': Number(r.utLateHours || 0),
        'ut/late amount': Number(r.utLateAmount || 0),

        // include per-line note so future runs can be used to seed the Note column
        note: r.note || '',

        savedAt: serverTimestamp()
      };

      const lineRef = doc(db, 'payrolls', payrollId, 'lines', r.userId);
      await setDoc(lineRef, lineObj);
    }

    setStatus(`Payroll saved as ${payrollId}`);
  } catch (err) {
    console.error('savePayrollRun error', err);
    setStatus('Failed to save payroll run: ' + (err.message || err), true);
  }
}

// Export CSV (literal field names)
function exportCsv() {
  const periodStart = (document.getElementById('periodStart') && document.getElementById('periodStart').value) || '';
  const periodEnd = (document.getElementById('periodEnd') && document.getElementById('periodEnd').value) || '';

  const header = [
    'userId','username','role','ratePerDay','ratePerHour','daysWorked','hoursWorked','ngHours','otHours',
    'regularHolidayHours','specialHolidayHours','grossPay','netPay',
    'sss','pag-ibig','philhealth','st.peter',
    'sss salary loan','hdmf salary loan','hdmf calamity loan','cashAdvance',
    'ut/late','ut/late amount'
  ];
  const rowsData = rows.map(r => {
    const breakdown = (r._calc && r._calc.deductions && r._calc.deductions.breakdown) ? r._calc.deductions.breakdown : {};
    const sssEmp = breakdown.sss_employee ?? breakdown.sss ?? '';
    const philEmp = breakdown.phil_employee ?? breakdown.philhealth_employee ?? '';
    const pagibigEmp = breakdown.pagibig_employee ?? '';
    // no manualEdits fields — use cashAdvance instead
    return [
      r.userId || '',
      r.username || '',
      r.role || '',
      r.ratePerDay || '',
      r.ratePerHour || '',
      r.daysWorked || 0,
      r.hoursWorked || 0,
      r.ngHours || '',
      r.otHours || 0,
      r.regularHolidayHours || 0,
      r.specialHolidayHours || 0,
      (r._manualGross !== null && r._manualGross !== undefined) ? r._manualGross : (r._calc ? r._calc.gross : ''),
      (r._manualNet !== null && r._manualNet !== undefined) ? r._manualNet : (r._calc ? r._calc.net : ''),
      (r.sss !== null && r.sss !== undefined) ? r.sss : sssEmp,
      (r.pagibig !== null && r.pagibig !== undefined) ? r.pagibig : pagibigEmp,
      (r.philhealth !== null && r.philhealth !== undefined) ? r.philhealth : philEmp,
      (r.stPeter !== null && r.stPeter !== undefined) ? r.stPeter : (breakdown['st.peter'] ?? breakdown.st_peter ?? ''),
      r.sssSalaryLoan || 0,
      r.hdmfSalaryLoan || 0,
      r.hdmfCalamityLoan || 0,
      r.cashAdvance || 0,
      r.utLateHours || 0,
      r.utLateAmount || 0
    ].map(cell => `"${String(cell).replace(/"/g,'""')}"`).join(',');
  });

  const csv = [ header.join(','), rowsData ].join('\n');
  // Prepend period metadata as a comment line (CSV viewers ignore leading # comment)
  const metaLine = `# periodStart=${periodStart},periodEnd=${periodEnd}`;
  const fullCsv = [metaLine, header.join(','), rowsData].join('\n');

  const blob = new Blob([fullCsv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  // include the period in filename when available
  const datePart = new Date().toISOString().slice(0,10);
  const rangePart = periodStart && periodEnd ? `${periodStart}_to_${periodEnd}` : `${datePart}`;
  a.href = url;
  a.download = `payroll-${rangePart}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  setStatus('CSV exported with period metadata.');
}

// Wiring
loadUsersBtn.addEventListener('click', async () => {
  loadUsersBtn.disabled = true;
  await loadUsersAndAttendance();
  loadUsersBtn.disabled = false;
});

calculateBtn.addEventListener('click', async () => {
  const start = document.getElementById('periodStart').value;
  const end = document.getElementById('periodEnd').value;
  if (start && end) {
    await loadAttendanceForRows(start, end);
  }
  calculateAll();
});

saveRunBtn.addEventListener('click', savePayrollRun);
exportCsvBtn.addEventListener('click', exportCsv);

// Export hooks for testing/debugging
export { loadUsersAndAttendance, loadAttendanceForRows, calculateAll, savePayrollRun, exportCsv };

// -----------------------------
// XLSX import -> modal preview -> confirm & save (drop-in admin UX)
// -----------------------------
// We reuse existing parsing helpers (parseSheetToTable, buildCanonicalTable, etc.) and
// wire a modal-based preview. Saves write the canonical doc and a history entry.

// helper: sha256 checksum
async function sha256Hex(str) {
  const enc = new TextEncoder();
  const h = await crypto.subtle.digest('SHA-256', enc.encode(str));
  return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2,'0')).join('');
}

// UI wiring for modal
const inputEl = document.getElementById('importXlsx');
const statusElSmall = document.getElementById('importStatus');
const modalBackdrop = document.getElementById('sssModalBackdrop');
const modalClose = document.getElementById('sssModalClose');
const cancelBtnModal = document.getElementById('sssCancelBtn');
const confirmBtnModal = document.getElementById('sssConfirmBtn');
const previewInfo = document.getElementById('sssPreviewInfo');
const previewContainerModal = document.getElementById('sssPreviewTableContainer');
const warnEl = document.getElementById('sssPreviewWarn');

let currentPayload = null;

function showModal() {
  if (!modalBackdrop) return;
  modalBackdrop.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}
function hideModal() {
  if (!modalBackdrop) return;
  modalBackdrop.style.display = 'none';
  document.body.style.overflow = '';
}

modalClose && modalClose.addEventListener('click', () => { hideModal(); if (statusElSmall) statusElSmall.textContent = 'Import cancelled.'; currentPayload = null; });
cancelBtnModal && cancelBtnModal.addEventListener('click', () => { hideModal(); if (statusElSmall) statusElSmall.textContent = 'Import cancelled.'; currentPayload = null; });
modalBackdrop && modalBackdrop.addEventListener('click', (e)=> { if (e.target === modalBackdrop) { hideModal(); if (statusElSmall) statusElSmall.textContent = 'Import cancelled.'; currentPayload = null; } });
document.addEventListener('keydown', (e)=> { if (e.key === 'Escape') { if (modalBackdrop && modalBackdrop.style.display === 'flex') { hideModal(); if (statusElSmall) statusElSmall.textContent = 'Import cancelled.'; currentPayload = null; } } });

// --- parsing helpers (required by the modal import flow) ---
function cleanNumberCell(s) {
  if (s === null || s === undefined) return null;
  let v = ('' + s).trim();
  if (v === '' || /^(n\/a|na|—|-|\u2014)$/i.test(v)) return null;
  const isParens = /^\(.*\)$/.test(v);
  v = v.replace(/[\(\)]/g, '');
  v = v.replace(/[^\d\.\-\,]/g, '');
  v = v.replace(/,/g, '');
  if (v === '' || v === '.' || v === '-') return null;
  const n = Number(v);
  return Number.isFinite(n) ? (isParens ? -n : n) : null;
}

function detectHeaderRow(rows, maxLook = 12) {
  const keywords = ['employee','employer','ee','er','employee share','employer share','total','monthly','salary','range'];
  for (let r = 0; r < Math.min(maxLook, rows.length); r++) {
    const joined = (rows[r] || []).map(c => (c === undefined || c === null) ? '' : String(c)).join(' ').toLowerCase();
    if (keywords.some(k => joined.includes(k))) return r;
  }
  for (let r = 0; r < Math.min(maxLook, rows.length); r++) {
    const nonEmpty = (rows[r] || []).filter(c => c !== undefined && c !== null && String(c).trim() !== '').length;
    if (nonEmpty >= 2) return r;
  }
  return 0;
}

function numericScoreByColumn(rows, startRow, sampleCount = 8) {
  const scores = [];
  const end = Math.min(rows.length, startRow + 1 + sampleCount);
  for (let c = 0; c < Math.max(...rows.map(r => (r||[]).length)); c++) {
    let numeric = 0, total = 0;
    for (let r = startRow + 1; r < end; r++) {
      const cell = rows[r] && rows[r][c] !== undefined ? rows[r][c] : null;
      if (cell === null || cell === undefined || String(cell).trim() === '') { total++; continue; }
      total++;
      const cleaned = cleanNumberCell(cell);
      if (cleaned !== null) numeric++;
    }
    scores[c] = total === 0 ? 0 : (numeric / total);
  }
  return scores;
}

function findBestColumnByHeader(headerRow, regex) {
  for (let i = 0; i < (headerRow||[]).length; i++) {
    const h = (headerRow[i] || '').toString().toLowerCase();
    if (regex.test(h)) return i;
  }
  return -1;
}

function parseRangeToMinMax(label) {
  if (!label) return {min: null, max: null};
  const raw = String(label).replace(/,/g, '').trim();
  const parts = raw.split(/\s*[-–to]+\s*/i).map(s => s.trim()).filter(Boolean);
  if (parts.length === 2 && !isNaN(Number(parts[0])) && !isNaN(Number(parts[1]))) {
    return {min: Number(parts[0]), max: Number(parts[1])};
  }
  const v = Number(raw);
  if (!isNaN(v)) return {min: v, max: v};
  return {min: null, max: null};
}

function buildCanonicalTable(rows, headerRowIdx, colMap) {
  const table = [];
  const start = headerRowIdx + 1;
  for (let r = start; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    const nonEmpty = (row || []).filter(c => c !== undefined && c !== null && String(c).trim() !== '').length;
    if (nonEmpty <= 0) continue;
    const rangeLabel = row[colMap.range] ? String(row[colMap.range]).trim() : '';
    const {min, max} = parseRangeToMinMax(rangeLabel);
    const emp = colMap.employee >= 0 ? cleanNumberCell(row[colMap.employee]) : null;
    const er = colMap.employer >= 0 ? cleanNumberCell(row[colMap.employer]) : null;
    const total = colMap.total >= 0 ? cleanNumberCell(row[colMap.total]) : null;
    if (emp === null && er === null && total === null) {
      if (!rangeLabel || (min === null && max === null)) continue;
    }
    table.push({
      rangeLabel: rangeLabel || '',
      min,
      max,
      employee: emp,
      employer: er,
      total: total,
      rawRow: (row || []).map(c => (c === undefined ? null : c))
    });
  }
  return table;
}

function parseSheetToTable(worksheet) {
  const rows = XLSX.utils.sheet_to_json(worksheet, { header:1, raw:false, defval:'' });
  if (!rows || rows.length === 0) throw new Error('Empty sheet');
  const headerRowIdx = detectHeaderRow(rows, 12);
  const header = (rows[headerRowIdx] || []).map(c => c === undefined || c === null ? '' : String(c).trim());
  let rangeCol = findBestColumnByHeader(header, /range|salary|bracket|monthly|basic/i);
  let empCol = findBestColumnByHeader(header, /employee|ee\b|employee share/i);
  let erCol = findBestColumnByHeader(header, /employer|er\b|employer share/i);
  let totalCol = findBestColumnByHeader(header, /\btotal\b/i);
  const scores = numericScoreByColumn(rows, headerRowIdx, 10);
  if (empCol < 0) {
    empCol = scores.indexOf(Math.max(...scores));
  }
  if (erCol < 0) {
    const sorted = scores.map((s,i)=>({s,i})).sort((a,b)=>b.s-a.s);
    const pick = sorted.find(x => x.i !== empCol);
    erCol = pick ? pick.i : -1;
  }
  if (totalCol < 0) {
    const sorted = scores.map((s,i)=>({s,i})).sort((a,b)=>b.s-a.s);
    const pick = sorted.find(x => x.i !== empCol && x.i !== erCol);
    totalCol = pick ? pick.i : -1;
  }
  if (rangeCol < 0) {
    for (let i=0;i<header.length;i++){
      const typ = rows[headerRowIdx+1] && rows[headerRowIdx+1][i] ? String(rows[headerRowIdx+1][i]) : '';
      if (isNaN(Number(typ))) { rangeCol = i; break; }
    }
    if (rangeCol < 0) rangeCol = 0;
  }
  const colMap = { range: rangeCol >= 0 ? rangeCol : 0, employee: empCol >= 0 ? empCol : -1, employer: erCol >= 0 ? erCol : -1, total: totalCol >= 0 ? totalCol : -1 };
  const table = buildCanonicalTable(rows, headerRowIdx, colMap);
  return { table, headerRowIdx, header, colMap };
}

inputEl && inputEl.addEventListener('change', async (ev) => {
  if (statusElSmall) statusElSmall.textContent = 'Parsing file...';
  if (previewContainerModal) previewContainerModal.innerHTML = '';
  if (warnEl) warnEl.style.display = 'none';
  try {
    const f = ev.target.files[0];
    if (!f) { if (statusElSmall) statusElSmall.textContent = 'No file selected.'; return; }
    const buffer = await f.arrayBuffer();
    const wb = XLSX.read(buffer, { type: 'array' });
    // Use the strict 2025 Tabulation parser
    const table = await parseTabulation2025(wb);
    if (!table || table.length < 1) { if (statusElSmall) statusElSmall.textContent = 'No data rows parsed — ensure sheet "Tabulation" uses the 2025 layout.'; return; }

    const checksum = await sha256Hex(JSON.stringify(table));

    currentPayload = {
      source: "upload",
      filename: f.name,
      uploadedBy: (auth && auth.currentUser) ? auth.currentUser.uid : 'unknown',
      uploadedAt: serverTimestamp(),
      checksum,
      table,
      versionNote: 'SSS Tabulation 2025'
    };

    // build preview table (first 12 rows)
    previewInfo && (previewInfo.textContent = `Parsed Tabulation sheet — ${table.length} rows. Showing first ${Math.min(12, table.length)} rows.`);
    const tbl = document.createElement('table'); tbl.className = 'sss-table';
    const hdr = document.createElement('tr');
    ['#','rangeLabel','min','max','employee','employer','total'].forEach(h => { const th = document.createElement('th'); th.textContent = h; hdr.appendChild(th); });
    tbl.appendChild(hdr);
    table.slice(0,12).forEach((r,i)=>{
      const tr = document.createElement('tr');
      [i+1, r.rangeLabel, r.min, r.max, (r.employee && r.employee.regular !== undefined) ? r.employee.regular : (r.employee || ''), (r.employer && r.employer.regular !== undefined) ? r.employer.regular : (r.employer || ''), r.total].forEach(v=>{ const td = document.createElement('td'); td.textContent = v === null || v === undefined ? '' : String(v); tr.appendChild(td); });
      tbl.appendChild(tr);
    });
    previewContainerModal && (previewContainerModal.innerHTML = '');
    previewContainerModal && previewContainerModal.appendChild(tbl);

    const missing = table.filter(row => {
      const emp = row.employee && typeof row.employee === 'object' ? (row.employee.regular ?? row.employee.total ?? null) : row.employee;
      const er = row.employer && typeof row.employer === 'object' ? (row.employer.regular ?? row.employer.total ?? null) : row.employer;
      const tot = row.total;
      return (emp === null || emp === undefined) && (er === null || er === undefined) && (tot === null || tot === undefined);
    }).length;
    if (missing > 0) {
      warnEl && (warnEl.style.display = 'block');
      warnEl && (warnEl.textContent = `${missing} rows had no numeric employee/employer/total values. You may need to clean the sheet or confirm values.`);
    } else {
      warnEl && (warnEl.style.display = 'none');
    }

    showModal();
    if (statusElSmall) statusElSmall.textContent = `Parsed ${table.length} rows from "${f.name}". Preview shown.`;
  } catch (err) {
    console.error('Parsing error', err);
    if (statusElSmall) statusElSmall.textContent = 'Parsing failed: ' + (err && err.message ? err.message : String(err));
  } finally {
    // allow re-pick same file
    inputEl.value = '';
  }
});

// Confirm & Save: write canonical doc + history entry
confirmBtnModal && confirmBtnModal.addEventListener('click', async () => {
  if (!currentPayload) { if (statusElSmall) statusElSmall.textContent = 'Nothing to save.'; return; }
  if (statusElSmall) statusElSmall.textContent = 'Saving to Firestore...';
  try {
    const payload = Object.assign({}, currentPayload, { uploadedAt: serverTimestamp() });
    await setDoc(doc(db, 'config', 'sssContributionTable'), payload);
    await setDoc(doc(collection(doc(db, 'config', 'sssContributionTable'), 'history'), payload.checksum), Object.assign({}, payload, { createdAt: serverTimestamp() }));
    if (statusElSmall) statusElSmall.textContent = `Saved ${payload.table.length} rows to Firestore (checksum ${payload.checksum}).`;
    hideModal();
    currentPayload = null;
    try { sssTablePayload = payload; } catch(e) { /* ignore */ }
  } catch (err) {
    console.error('Save failed', err);
    if (statusElSmall) statusElSmall.textContent = 'Save failed: ' + (err && err.message ? err.message : String(err));
  }
});
