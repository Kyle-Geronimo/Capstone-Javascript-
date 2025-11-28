// js/payroll.js
import { computePayrollLine, toCents } from './payroll-utils.js';
import { auth, db } from './firebase-config.js';
import { getSssTable, lookupSssContribution } from './sss-table.js';
import {
  collection, getDocs, getDoc, query, where, orderBy, addDoc, doc, setDoc, serverTimestamp, Timestamp, onSnapshot, limit, documentId,
  updateDoc, arrayUnion, arrayRemove
} from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js';

// UI elements
const loadUsersBtn = document.getElementById('loadUsersBtn');
const calculateBtn = document.getElementById('calculateBtn');
const saveRunBtn = document.getElementById('saveRunBtn');
const exportCsvBtn = document.getElementById('exportCsvBtn');
const payrollBody = document.getElementById('payrollBody');
const rowsCountEl = document.getElementById('rowsCount');
const statusEl = document.getElementById('status');
const payrollLoadingOverlay = document.getElementById('payrollLoadingOverlay');
const payrollLoadingTextEl = document.getElementById('payrollLoadingText');

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
  // Defensive: ensure SheetJS is loaded
  if (typeof XLSX === 'undefined') {
    throw new Error('SheetJS (XLSX) not loaded. Add <script src="https://cdn.sheetjs.com/xlsx-latest/package/dist/xlsx.full.min.js"></script> or include ../vendor/xlsx.full.min.js before payroll.js');
  }

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

// Robust tabulation parser + preview renderer (drop-in replacement)
async function parseTabulationWorkbook(fileOrWorkbook) {
  // load workbook if a File object is passed
  let workbook;
  if (fileOrWorkbook && fileOrWorkbook.SheetNames) workbook = fileOrWorkbook;
  else if (fileOrWorkbook && typeof File !== 'undefined' && fileOrWorkbook instanceof File) {
    const ab = await fileOrWorkbook.arrayBuffer();
    workbook = XLSX.read(ab, { type: 'array', cellDates: true, defval: '' });
  } else throw new Error('parseTabulationWorkbook expects a File or workbook');

  const sheetName = workbook.SheetNames.find(n => /tabulation|sss|contribution/i.test(n)) || workbook.SheetNames[0];
  const ws = workbook.Sheets[sheetName];
  const rawRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  // --- detect header block (first 20 rows)
  const first20 = rawRows.slice(0, 20);
  let headerStart = first20.findIndex(row => (row || []).join(' ').toUpperCase().match(/RANGE|MONTHLY|SALARY|EMPLOYER|EMPLOYEE|COMPENSATION/));
  if (headerStart === -1) headerStart = first20.findIndex(r => r && r.some(c => String(c).trim() !== ''));
  if (headerStart === -1) headerStart = 0;

  // allow up to 4 header rows (concat)
  const headerRows = [];
  for (let i = headerStart; i < Math.min(headerStart + 4, rawRows.length); i++) headerRows.push(rawRows[i] || []);

  const maxCols = Math.max(...headerRows.map(r => r.length));
  const columns = Array.from({length: maxCols}, (_,ci) => {
    const parts = [];
    for (let r=0;r<headerRows.length;r++){
      const t = (headerRows[r][ci]||'').toString().trim();
      if (t) parts.push(t);
    }
    return parts.join(' ').replace(/\s+/g,' ').trim().toUpperCase();
  });

  // DEBUG: show the columns the parser sees
  console.debug('Tabulation parser: detected headerStart=', headerStart, 'headerRows=', headerRows.length);
  console.debug('Detected columns:', columns.map((c,i)=>`${i}:${c}`));

  // helpers to find columns more flexibly
  const findFirst = (...keys) => {
    const K = keys.map(k=>k.toUpperCase());
    for (let i=0;i<columns.length;i++){
      const col = columns[i]||'';
      if (K.every(k => k && col.includes(k))) return i;
    }
    for (let i=0;i<columns.length;i++){
      const col = columns[i]||'';
      for (const k of K) if (k && col.includes(k)) return i;
    }
    return -1;
  };

  // find obvious column indices
  let idxRange = findFirst('RANGE','COMPENSATION');
  const idxFrom = findFirst('FROM') >=0 ? findFirst('FROM') : -1;
  const idxTo = findFirst('TO') >=0 ? findFirst('TO') : -1;
  let idxMSC = findFirst('MONTHLY','SALARY','CREDIT');
  let idxEmployeesComp = findFirst('EMPLOYEES','COMPENSATION');
  // find MPF columns (may appear twice: employer and employee)
  const mpfCols = [];
  columns.forEach((c,i)=>{ if (/\bMPF\b/.test(c) || c.includes('MANDATORY PROVIDENT') ) mpfCols.push(i); });
  // find EC columns
  const ecCols = [];
  columns.forEach((c,i)=>{ if (/\bEC\b/.test(c) || c.includes('EMPLOYER CONTRIBUTION') ) ecCols.push(i); });
  // find REGULAR SS & TOTAL columns (there may be multiple 'TOTAL' labels)
  const totalCols = columns.map((c,i)=> c.includes('TOTAL') ? i : -1).filter(i=>i>=0);
  const regSSCols = [];
  columns.forEach((c,i)=>{ if (c.includes('REGULAR SS') || c.includes('REGULAR')) regSSCols.push(i); });

  console.debug('Detected mpfCols=', mpfCols, 'ecCols=', ecCols, 'totalCols=', totalCols, 'regSSCols=', regSSCols);

  // Heuristics for which MPF/EC map to Employer vs Employee:
  // - if there are two MPF columns, decide by position relative to keywords EMPLOYER/EMPLOYEE in column header text:
  const employerKeywords = ['EMPLOYER'];
  const employeeKeywords = ['EMPLOYEE'];
  function chooseSideIndex(candidates) {
    if (candidates.length === 0) return {employer:-1, employee:-1};
    if (candidates.length === 1) {
      // single MPF column: determine by scanning headerRows to see whether the header mentions EMPLOYER or EMPLOYEE near it
      const i = candidates[0];
      const headerText = headerRows.map(r=> (r[i]||'')).join(' ').toUpperCase();
      if (headerText.includes('EMPLOYER')) return {employer:i, employee:-1};
      if (headerText.includes('EMPLOYEE')) return {employer:-1, employee:i};
      // otherwise guess: if column index is left of center assume employer, else employee
      return (i < maxCols/2) ? {employer:i, employee:-1} : {employer:-1, employee:i};
    }
    // two or more: find one that mentions EMPLOYER and one that mentions EMPLOYEE; else pick left one employer, right one employee
    let empIdx=-1, eeIdx=-1;
    for (const i of candidates) {
      const h = headerRows.map(r=> (r[i]||'')).join(' ').toUpperCase();
      if (h.includes('EMPLOYER')) empIdx = i;
      if (h.includes('EMPLOYEE')) eeIdx = i;
    }
    if (empIdx===-1 || eeIdx===-1) {
      // fallback: pick leftmost for employer, rightmost for employee
      const sorted = candidates.slice().sort((a,b)=>a-b);
      empIdx = sorted[0];
      eeIdx = sorted[sorted.length-1];
    }
    return {employer:empIdx, employee:eeIdx};
  }

  const mpfMap = chooseSideIndex(mpfCols);
  const ecMap = chooseSideIndex(ecCols);
  // REGULAR SS: similarly map two regs (employer/employee)
  const regMap = chooseSideIndex(regSSCols);

  // For totals, we want: employerTotal, employeeTotal, grandTotal (there may be multiple 'TOTAL' columns)
  // We'll choose totals by proximity: total column nearest mpf/reg/emp clusters
  let employerTotalIdx = -1, employeeTotalIdx = -1, grandTotalIdx = -1;
  if (totalCols.length) {
    // try to assign employer/employee totals by checking header text for EMPLOYER/EMPLOYEE
    for (const t of totalCols) {
      const h = columns[t] || '';
      if (h.includes('EMPLOYER')) employerTotalIdx = t;
      else if (h.includes('EMPLOYEE')) employeeTotalIdx = t;
      else if (h.includes('GRAND') || h.includes('CONTRIBUTION')) grandTotalIdx = t;
    }
    // fallback: left-most total near left side -> employer, middle -> employee, right -> grand
    if (employerTotalIdx === -1 || employeeTotalIdx === -1) {
      const sorted = totalCols.slice().sort((a,b)=>a-b);
      if (sorted.length === 1) grandTotalIdx = sorted[0];
      if (sorted.length === 2) { employerTotalIdx = sorted[0]; employeeTotalIdx = sorted[1]; }
      if (sorted.length >=3) { employerTotalIdx = sorted[0]; employeeTotalIdx = sorted[1]; grandTotalIdx = sorted[sorted.length-1]; }
    }
  }

  console.debug('mpfMap=', mpfMap, 'ecMap=', ecMap, 'regMap=', regMap, 'employerTotalIdx=', employerTotalIdx, 'employeeTotalIdx=', employeeTotalIdx, 'grandTotalIdx=', grandTotalIdx);

  // begin parsing rows from first non-empty after header block
  let dataStart = headerStart + headerRows.length;
  for (let r = dataStart; r < Math.min(dataStart+30, rawRows.length); r++) {
    const row = rawRows[r] || [];
    if (row.some(c => c !== null && c !== undefined && String(c).trim() !== '')) { dataStart = r; break; }
  }

  const parsed = [];
  let emptyStreak = 0;
  for (let r = dataStart; r < rawRows.length; r++) {
    const row = rawRows[r] || [];
    const nonEmpty = row.some(c => c !== null && c !== undefined && String(c).trim() !== '');
    if (!nonEmpty) { emptyStreak++; if (emptyStreak>8) break; else continue; }
    emptyStreak = 0;

    const getVal = i => (i>=0 && i<row.length) ? row[i] : '';

    // Range handling: either in one range col or FROM/TO split
    let rawRange = getVal(idxRange);
    let rangeLow=null, rangeHigh=null;
    if (rawRange===null || String(rawRange).trim()==='') {
      if (idxFrom>=0 || idxTo>=0) {
        const f = getVal(idxFrom); const t = getVal(idxTo);
        rawRange = `${f||''}${(f&&t)?' - ':''}${t||''}`;
        rangeLow = parseNum(f); rangeHigh = parseNum(t);
      }
    } else {
      // if rawRange contains '-', split
      if (String(rawRange).includes('-')) {
        const parts = String(rawRange).split('-').map(s=>s.trim());
        rangeLow = parseNum(parts[0]); rangeHigh = parseNum(parts[1]);
      } else {
        const n = parseNum(rawRange);
        if (n!==null) { rangeLow = n; rangeHigh = n; }
      }
    }

    // numeric picks
    const monthlySalaryCredit = parseNum(getVal(idxMSC) || getVal(idxEmployeesComp));
    const employeesComp = parseNum(getVal(idxEmployeesComp));
    // employer/employee MPF & EC using mpfMap/ecMap
    const employerMPF = mpfMap.employer !== -1 ? parseNum(getVal(mpfMap.employer)) : null;
    const employeeMPF = mpfMap.employee !== -1 ? parseNum(getVal(mpfMap.employee)) : null;
    const employerEC = ecMap.employer !== -1 ? parseNum(getVal(ecMap.employer)) : null;
    const employeeEC = ecMap.employee !== -1 ? parseNum(getVal(ecMap.employee)) : null; // rarely present

    const employerRegSS = regMap.employer !== -1 ? parseNum(getVal(regMap.employer)) : null;
    const employeeRegSS = regMap.employee !== -1 ? parseNum(getVal(regMap.employee)) : null;

    const employerTotal = employerTotalIdx !== -1 ? parseNum(getVal(employerTotalIdx)) : null;
    const employeeTotal = employeeTotalIdx !== -1 ? parseNum(getVal(employeeTotalIdx)) : null;
    const grandTotal = grandTotalIdx !== -1 ? parseNum(getVal(grandTotalIdx)) : null;

    // compute fallbacks
    const computedEmployerTotal = sumIgnoreNull([employerRegSS, employerMPF, employerEC, employerTotal]);
    const computedEmployeeTotal = sumIgnoreNull([employeeRegSS, employeeMPF, employeeTotal]);
    const computedGrand = sumIgnoreNull([computedEmployerTotal, computedEmployeeTotal, grandTotal]);

    // push row
    parsed.push({
      rowIndex: r,
      rawRange: rawRange,
      rangeLow, rangeHigh,
      monthlySalaryCredit, employeesComp,
      employer: { regularSS: employerRegSS, mpf: employerMPF, ec: employerEC, total: employerTotal !== null ? employerTotal : computedEmployerTotal },
      employee: { regularSS: employeeRegSS, mpf: employeeMPF, ec: employeeEC, total: employeeTotal !== null ? employeeTotal : computedEmployeeTotal },
      totalContribution: grandTotal !== null ? grandTotal : computedGrand,
      rawRow: row,
      detectedColumns: columns
    });
  }

  console.debug('parseTabulationWorkbook: parsed rows=', parsed.length);
  return parsed;

  // helpers
  function parseNum(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number' && isFinite(v)) return v;
    const s = String(v).trim();
    if (!s || /^[-—–]$/.test(s)) return null;
    // remove commas, currency symbols, spaces; handle parentheses
    const isPar = /^\(.*\)$/.test(s);
    let t = s.replace(/[^0-9\.\-\(\)]/g,'').replace(/\s+/g,'');
    if (isPar) t = '-' + t.replace(/[()]/g,'');
    const lastDot = t.lastIndexOf('.');
    if (lastDot !== -1) {
      const left = t.slice(0,lastDot).replace(/\./g,'');
      const right = t.slice(lastDot+1).replace(/\./g,'');
      t = left + '.' + right;
    } else t = t.replace(/\./g,'');
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  function sumIgnoreNull(arr) {
    const nums = arr.filter(x => x !== null && x !== undefined && !Number.isNaN(x));
    if (!nums.length) return null;
    return nums.reduce((a,b)=>a+(b||0),0);
  }
}

function renderPreviewFromParsed(parsedRows, container) {
  if (!container) container = previewContainerModal || document.getElementById('sssPreviewTableContainer') || document.body;
  container.innerHTML = '';

  const wrapper = document.createElement('div'); wrapper.className = 'import-preview';
  const table = document.createElement('table'); table.style.width = '100%'; table.style.borderCollapse = 'collapse';

  const thead = document.createElement('thead');
  const tr1 = document.createElement('tr');
  const tr2 = document.createElement('tr');

  const hdr = (text, opts = {}) => {
    const th = document.createElement('th');
    th.innerHTML = text;
    if (opts.colspan) th.colSpan = opts.colspan;
    if (opts.rowspan) th.rowSpan = opts.rowspan;
    th.style.border = '1px solid #ddd'; th.style.padding = '6px'; th.style.background = opts.bg || '#e8f7d6'; th.style.fontWeight = '700'; th.style.textAlign = 'center';
    return th;
  };
  // Top header: make Range of Compensation span TWO columns (from/to)
  tr1.appendChild(hdr('RANGE OF COMPENSATION', {colspan:2}));
  tr1.appendChild(hdr('MONTHLY SALARY CREDIT', {colspan:3}));
  tr1.appendChild(hdr('EMPLOYER', {colspan:4}));
  tr1.appendChild(hdr('EMPLOYEE', {colspan:3}));
  tr1.appendChild(hdr('TOTAL', {rowspan:2}));

  const sub = ['FROM', 'TO', 'EMPLOYEES COMPENSATION', 'MANDATORY PROVIDENT FUND', 'TOTAL', 'REGULAR SS', 'MPF', 'EC', 'TOTAL', 'REGULAR SS', 'MPF', 'TOTAL'];
  for (let s of sub) { const th = hdr(s, {bg: '#fff'}); th.style.fontWeight = '700'; tr2.appendChild(th); }

  thead.appendChild(tr1); thead.appendChild(tr2); table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const r of parsedRows) {
    const tr = document.createElement('tr');
    const td = (v, css = '') => { const cell = document.createElement('td'); cell.innerHTML = (v === null || v === undefined || v === '') ? '' : String(v); cell.style.border = '1px solid #eee'; cell.style.padding = '6px'; if (css) cell.className = css; return cell; };

    // Render two columns for range (from/to). Display '-' when a side is missing.
    const fromTxt = (r.rangeLow !== null && r.rangeLow !== undefined) ? formatNum(r.rangeLow) : '-';
    const toTxt = (r.rangeHigh !== null && r.rangeHigh !== undefined) ? formatNum(r.rangeHigh) : (r.rawRange || '');
    tr.appendChild(td(fromTxt));
    tr.appendChild(td(toTxt));
    tr.appendChild(td(formatNum(r.monthlySalaryCredit)));
    tr.appendChild(td(formatNum(r.employeesCompensation)));
    tr.appendChild(td(formatNum(r.monthlySalaryCredit)));
    tr.appendChild(td(formatNum(r.employerRegSS)));
    tr.appendChild(td(formatNum(r.employerMPF)));
    tr.appendChild(td(formatNum(r.employerEC)));
    tr.appendChild(td(formatNum(r.employerTotal)));
    tr.appendChild(td(formatNum(r.employeeRegSS)));
    tr.appendChild(td(formatNum(r.employeeMPF)));
    tr.appendChild(td(formatNum(r.employeeTotal)));
    tr.appendChild(td(formatNum(r.totalContribution)));
    tbody.appendChild(tr);
  }

  table.appendChild(tbody); wrapper.appendChild(table);
  const info = document.createElement('div'); info.className = 'preview-info'; info.textContent = `Parsed rows: ${parsedRows.length}`; wrapper.appendChild(info);
  container.appendChild(wrapper);

  function formatNum(n) { if (n === null || n === undefined || n === '') return ''; return Number(n).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2}); }
}

function setStatus(msg, isError = false) {
  if (typeof statusEl !== 'undefined' && statusEl && statusEl !== null) {
    try {
      statusEl.textContent = msg || '';
      statusEl.style.color = isError ? '#b00020' : '#333';
    } catch (e) {
      // defensive: ignore DOM write errors
      console.warn('setStatus DOM update failed', e);
    }
  } else {
    // fallback to console when no status element present
    if (msg) {
      if (isError) console.error(msg); else console.log(msg);
    }
  }
}

// Lightweight helpers to control the full-page payroll loading overlay
function showPayrollLoading(message) {
  if (!payrollLoadingOverlay) return;
  if (payrollLoadingTextEl && message) payrollLoadingTextEl.textContent = message;
  payrollLoadingOverlay.classList.remove('hidden');
}

function hidePayrollLoading() {
  if (!payrollLoadingOverlay) return;
  payrollLoadingOverlay.classList.add('hidden');
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
// (Implementation is the exported `fetchMostRecentPayrollRun` later in this file.)
// ----------------------------------------------------------------

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
  if (!payrollBody) {
    console.log('Payroll table not found on this page. Skipping logic.');
    return;
  }
  // 1) Fetch latest payroll run (rates + meta + lines) once.
  //    If this fails (e.g. no payrolls yet or indexing/permission issues),
  //    fall back to an empty payload so we still load users and render rows.
  let latestRates = new Map();
  let latestRunMeta = null;
  let latestLines = new Map();
  try {
    const payload = await fetchMostRecentPayrollRun();
    if (payload) {
      latestRates = payload.ratesMap instanceof Map ? payload.ratesMap : (payload.ratesMap || new Map());
      latestRunMeta = payload.runMeta || null;
      latestLines = payload.linesMap instanceof Map ? payload.linesMap : (payload.linesMap || new Map());
    }
  } catch (err) {
    console.warn('fetchMostRecentPayrollRun failed; continuing with base user rates only', err);
    latestRates = new Map();
    latestRunMeta = null;
    latestLines = new Map();
  }

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

    // build rows using latestRates and, when available, values from the latest saved payroll run
    rows = usersList.map(u => {
      const uid = u.userId || u.id;
      const savedLine = (typeof latestLines !== 'undefined' && latestLines && latestLines.has(uid)) ? latestLines.get(uid) : null;
      const seededNote = savedLine && savedLine.note ? savedLine.note : (u.note || '');

      // Priority for ratePerDay:
      // 1) ratePerDay saved on the latest payroll line (what you edited last run)
      // 2) latestRates map (e.g. from an older run)
      // 3) base rate stored on the user document
      const userBaseRate = Number(u.ratePerDay || u.baseRatePerDay || 0);
      const savedRate = savedLine && savedLine.ratePerDay !== undefined && savedLine.ratePerDay !== null
        ? Number(savedLine.ratePerDay)
        : null;
      const rateFromLatest = (latestRates && latestRates.has(uid)) ? Number(latestRates.get(uid)) : null;
      const ratePerDay = savedRate !== null ? savedRate : (rateFromLatest !== null ? rateFromLatest : userBaseRate);

      return {
        userId: uid,
        username: u.username || u.displayName || u.email || '',
        role: u.role || '',
        shift: u.shift || '',
        ratePerDay,

        // Use saved values from latest payroll run when available so edits persist
        daysWorked: savedLine && typeof savedLine.daysWorked === 'number' ? Number(savedLine.daysWorked) : 0,
        hoursWorked: savedLine && typeof savedLine.hoursWorked === 'number' ? Number(savedLine.hoursWorked) : 0,
        ndHours: savedLine && typeof savedLine.ngHours === 'number' ? Number(savedLine.ngHours) : 0,
        ndOtHours: 0,
        otHours: savedLine && typeof savedLine.otHours === 'number' ? Number(savedLine.otHours) : 0,
        regularHolidayHours: savedLine && typeof savedLine.regularHolidayHours === 'number' ? Number(savedLine.regularHolidayHours) : 0,
        specialHolidayHours: savedLine && typeof savedLine.specialHolidayHours === 'number' ? Number(savedLine.specialHolidayHours) : 0,

        // UI fields / overrides (seed from saved line when present)
        sss: (savedLine && typeof savedLine.sss === 'number') ? Number(savedLine.sss) : null,
        philhealth: (savedLine && typeof savedLine.philhealth === 'number') ? Number(savedLine.philhealth) : null,
        pagibig: (savedLine && typeof savedLine['pag-ibig'] === 'number') ? Number(savedLine['pag-ibig']) : null,
        stPeter: (savedLine && typeof savedLine['st.peter'] === 'number') ? Number(savedLine['st.peter']) : null,

        sssSalaryLoan: Number((savedLine && savedLine['sss salary loan']) || 0),
        // NEW: SSS Calamity Loan
        sssCalamityLoan: Number((savedLine && savedLine['sss calamity loan']) || 0),
        hdmfSalaryLoan: Number((savedLine && savedLine['hdmf salary loan']) || 0),
        hdmfCalamityLoan: Number((savedLine && savedLine['hdmf calamity loan']) || 0),
        cashAdvance: Number((savedLine && savedLine.cashAdvance) || 0),
        credit: Number((savedLine && savedLine.credit) || 0),
        utLateHours: Number((savedLine && savedLine['ut/late']) || 0),
        utLateAmount: Number((savedLine && savedLine['ut/late amount']) || 0),
        note: seededNote,

        // Manual override fields (not persisted yet; reset when reopening page)
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
        if (ps && latestRunMeta.periodStart) ps.value = formatDateForInput(latestRunMeta.periodStart);
        if (pe && latestRunMeta.periodEnd) pe.value = formatDateForInput(latestRunMeta.periodEnd);
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
            sssSalaryLoan: 0, sssCalamityLoan: 0, hdmfSalaryLoan: 0, hdmfCalamityLoan: 0, cashAdvance: 0,
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
        if (ps && freshRunMeta.periodStart) ps.value = formatDateForInput(freshRunMeta.periodStart);
        if (pe && freshRunMeta.periodEnd) pe.value = formatDateForInput(freshRunMeta.periodEnd);
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

// The exported `fetchMostRecentPayrollRun` is implemented later in this file
// and will attach itself to `window` for non-module pages. Removing the
// temporary inline definition to avoid duplicate implementations.

// -------------------------
// Holidays: load, lookup, isHoliday
// -------------------------
import { /* ensure these are available for admin helpers */ } from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js';

// Load holidays doc once
export async function loadHolidaysDoc() {
  const ref = doc(db, 'payroll_settings', 'holidays');
  const snap = await getDoc(ref);
  if (!snap.exists()) return { regularHolidays: [], specialHolidays: [] };
  const data = snap.data();
  return {
    regularHolidays: data.regularHolidays || [],
    specialHolidays: data.specialHolidays || []
  };
}

// Build lookup sets/maps for quick check (for a given year).
// Recurring holidays are matched by month-day (MM-DD)
// Non-recurring holidays are matched by full YYYY-MM-DD.
export function buildHolidayLookup({ regularHolidays = [], specialHolidays = [] } = {}) {
  const regByFull = new Map();   // full date -> holiday obj (non-recurring)
  const regByMD = new Map();     // month-day -> holiday obj (recurring)
  const specByFull = new Map();
  const specByMD = new Map();

  function pushToMaps(list, byFull, byMD) {
    for (const h of list || []) {
      if (!h || !h.date) continue;
      const full = h.date;
      const md = full.slice(5); // "MM-DD"
      // Treat missing `recurring` as recurring (legacy entries highlight every year).
      const isRecurring = (typeof h.recurring === 'undefined') ? true : !!h.recurring;
      if (isRecurring) {
        const existing = byMD.get(md);
        if (!existing) byMD.set(md, [h]);
        else existing.push(h);
      } else {
        const existing = byFull.get(full);
        if (!existing) byFull.set(full, [h]);
        else existing.push(h);
      }
    }
  }

  pushToMaps(regularHolidays, regByFull, regByMD);
  pushToMaps(specialHolidays, specByFull, specByMD);

  return {
    regByFull, regByMD, specByFull, specByMD
  };
}

// Check if a JS Date (or date string "YYYY-MM-DD") is a holiday and return details.
// Returns { isHoliday: boolean, kinds: ['regular'|'special'], items: [holiday objects] }
export function isHoliday(dateInput, lookup) {
  let yyyyMMdd;
  if (typeof dateInput === 'string') yyyyMMdd = dateInput;
  else {
    const y = dateInput.getFullYear();
    const m = String(dateInput.getMonth() + 1).padStart(2, '0');
    const d = String(dateInput.getDate()).padStart(2, '0');
    yyyyMMdd = `${y}-${m}-${d}`;
  }
  const md = yyyyMMdd.slice(5);

  const items = [];
  const kinds = new Set();

  if (lookup.regByFull.has(yyyyMMdd)) {
    items.push(...lookup.regByFull.get(yyyyMMdd));
    kinds.add('regular');
  }
  if (lookup.regByMD.has(md)) {
    items.push(...lookup.regByMD.get(md));
    kinds.add('regular');
  }
  if (lookup.specByFull.has(yyyyMMdd)) {
    items.push(...lookup.specByFull.get(yyyyMMdd));
    kinds.add('special');
  }
  if (lookup.specByMD.has(md)) {
    items.push(...lookup.specByMD.get(md));
    kinds.add('special');
  }

  return { isHoliday: items.length > 0, kinds: Array.from(kinds), items };
}

// -------------------------
// Admin helpers: add/toggle/remove holidays
// -------------------------
// Add a holiday (defaults to recurring: true)
export async function addHoliday({ dateYMD, name, kind = 'regular', recurring = true, notes = '' }) {
  const ref = doc(db, 'payroll_settings', 'holidays');
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    const payload = {
      updatedAt: serverTimestamp(),
      updatedBy: (auth.currentUser && auth.currentUser.uid) || null,
      regularHolidays: [],
      specialHolidays: []
    };
    await setDoc(ref, payload, { merge: true });
  }

  const field = (kind === 'special') ? 'specialHolidays' : 'regularHolidays';
  const data = (await getDoc(ref)).data();
  const arr = data[field] || [];
  arr.push({ date: dateYMD, name, recurring, notes, monthDay: (dateYMD || '').slice(5) });
  await updateDoc(ref, {
    [field]: arr,
    updatedAt: serverTimestamp(),
    updatedBy: auth.currentUser ? auth.currentUser.uid : null
  });
}

// Toggle recurring flag for a specific holiday (search by date+name)
export async function toggleRecurring({ dateYMD, name, kind = 'regular', makeRecurring }) {
  const ref = doc(db, 'payroll_settings', 'holidays');
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('holidays doc missing');
  const data = snap.data();
  const field = (kind === 'special') ? 'specialHolidays' : 'regularHolidays';
  const arr = data[field] || [];
  const newArr = arr.map(h => {
    if (h.date === dateYMD && (!name || h.name === name)) {
      return { ...h, recurring: !!makeRecurring };
    }
    return h;
  });
  await updateDoc(ref, { [field]: newArr, updatedAt: serverTimestamp(), updatedBy: auth.currentUser.uid });
}

// Remove holiday
export async function removeHoliday({ dateYMD, name, kind = 'regular' }) {
  const ref = doc(db, 'payroll_settings', 'holidays');
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  const data = snap.data();
  const field = (kind === 'special') ? 'specialHolidays' : 'regularHolidays';
  const newArr = (data[field] || []).filter(h => !(h.date === dateYMD && (!name || h.name === name)));
  await updateDoc(ref, { [field]: newArr, updatedAt: serverTimestamp(), updatedBy: auth.currentUser.uid });
}

// Fetch the most recent payroll run and its lines.
// Returns { runId, runMeta, linesMap }
export async function fetchMostRecentPayrollRun() {
  try {
    const payrollsCol = collection(db, 'payrolls');
    const q = query(payrollsCol, orderBy('createdAt', 'desc'), limit(1));
    const snaps = await getDocs(q);
    if (snaps.empty) return { runId: null, runMeta: null, linesMap: new Map() };
    const runDoc = snaps.docs[0];
    const runMeta = runDoc.data();
    const runId = runDoc.id;

    // Read lines subcollection
    const linesCol = collection(db, 'payrolls', runId, 'lines');
    const linesSnap = await getDocs(linesCol);
    const linesMap = new Map();
    linesSnap.forEach(d => {
      const data = d.data();
      // prefer explicit userId field, else use doc id
      const uid = data.userId || d.id;
      linesMap.set(uid, Object.assign({ id: d.id }, data));
    });

    // also expose as plain object for compatibility
    const linesObj = {};
    for (const [k,v] of linesMap) linesObj[k] = v;

    // (window exposure moved outside the function to ensure availability
    // at module evaluation time for non-module pages)

    return { runId, runMeta, linesMap, linesObj };
  } catch (err) {
    console.error('fetchMostRecentPayrollRun failed', err);
    throw err;
  }
}

// Ensure non-module pages can call the helper immediately after this script loads.
if (typeof window !== 'undefined' && typeof window.fetchMostRecentPayrollRun === 'undefined') {
  window.fetchMostRecentPayrollRun = fetchMostRecentPayrollRun;
}

// === Holiday calendars (Regular & Special) ===
// NOTE: `db`, `getDoc`, `setDoc`, and `serverTimestamp` are already imported above.

// Config: Firestore doc path where holidays are stored
const HOLIDAYS_DOC_PATH = { col: 'payroll_settings', doc: 'holidays' };

// local caches (Set of ISO date strings)
let regHolidays = new Set();
let specHolidays = new Set();

let regCalState = { year: (new Date()).getFullYear(), month: (new Date()).getMonth() }; // 0-based month
let specCalState = { year: (new Date()).getFullYear(), month: (new Date()).getMonth() };

async function loadHolidaysFromFirestore() {
  try {
    const ref = doc(db, HOLIDAYS_DOC_PATH.col, HOLIDAYS_DOC_PATH.doc);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      regHolidays = new Set();
      specHolidays = new Set();
      return;
    }
    const data = snap.data() || {};

    // Support both legacy shape (regularHolidays/specialHolidays with objects)
    // and newer simple arrays (regular/special with date strings).
    const legacyRegular = Array.isArray(data.regularHolidays) ? data.regularHolidays.map(h => h.date || h) : [];
    const legacySpecial = Array.isArray(data.specialHolidays) ? data.specialHolidays.map(h => h.date || h) : [];
    const simpleRegular = Array.isArray(data.regular) ? data.regular : [];
    const simpleSpecial = Array.isArray(data.special) ? data.special : [];

    const mergedRegular = [...legacyRegular, ...simpleRegular];
    const mergedSpecial = [...legacySpecial, ...simpleSpecial];

    regHolidays = new Set(mergedRegular.map(d => (new Date(d)).toISOString().slice(0,10)));
    specHolidays = new Set(mergedSpecial.map(d => (new Date(d)).toISOString().slice(0,10)));
  } catch (err) {
    console.error('Failed to load holidays', err);
  }
}

async function saveHolidaysToFirestore() {
  try {
    const ref = doc(db, HOLIDAYS_DOC_PATH.col, HOLIDAYS_DOC_PATH.doc);
    await setDoc(ref, {
      regular: Array.from(regHolidays),
      special: Array.from(specHolidays),
      updatedAt: serverTimestamp()
    }, { merge: true });
    showHolidayStatus('Saved holidays.');
  } catch (err) {
    console.error('Failed to save holidays', err);
    showHolidayStatus('Save failed. See console.', true);
  }
}

function showHolidayStatus(msg, isError = false) {
  const el = document.getElementById('holidayStatus');
  if (!el) return;
  el.textContent = msg;
  el.style.color = isError ? '#b91c1c' : '#2b6cb0';
  setTimeout(()=>{ el.textContent = ''; }, 3500);
}

/* ---------- Calendar renderer ---------- */
function renderCalendar(containerId, stateObj, selectedSet, monthLabelId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const year = stateObj.year, month = stateObj.month;
  const firstDay = new Date(year, month, 1);
  const startWeekday = firstDay.getDay(); // 0 Sun..6 Sat
  const daysInMonth = new Date(year, month+1, 0).getDate();
  const prevDays = new Date(year, month, 0).getDate();

  let html = '<table><thead><tr>';
  const wkNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  for (const w of wkNames) html += `<th>${w}</th>`;
  html += '</tr></thead><tbody>';

  for (let r=0; r<6; r++) {
    html += '<tr>';
    for (let c=0; c<7; c++) {
      const cellIndex = r*7 + c;
      const dayNum = cellIndex - startWeekday + 1;
      let cellHtml = '';
      let cellClass = '';
      let iso = '';
      if (dayNum <= 0) {
        const d = prevDays + dayNum;
        const dt = new Date(year, month-1, d);
        iso = dt.toISOString().slice(0,10);
        cellHtml = `<div class="other-month">${d}</div>`;
      } else if (dayNum > daysInMonth) {
        const d = dayNum - daysInMonth;
        const dt = new Date(year, month+1, d);
        iso = dt.toISOString().slice(0,10);
        cellHtml = `<div class="other-month">${d}</div>`;
      } else {
        const d = dayNum;
        const dt = new Date(year, month, d);
        iso = dt.toISOString().slice(0,10);
        const short = d;
        cellHtml = `<div class="this-month">${short}</div>`;
        if (selectedSet.has(iso)) cellClass = 'selected-date';
      }
      html += `<td data-iso="${iso}" class="${cellClass}">${cellHtml}</td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  container.innerHTML = html;

  const label = document.getElementById(monthLabelId);
  if (label) label.textContent = `${firstDay.toLocaleString(undefined,{month:'long'})} ${year}`;

  container.querySelectorAll('td').forEach(td => {
    td.addEventListener('click', async (ev) => {
      const iso = td.getAttribute('data-iso');
      if (!iso) return;
      if (selectedSet.has(iso)) selectedSet.delete(iso);
      else selectedSet.add(iso);
      renderCalendar(containerId, stateObj, selectedSet, monthLabelId);
      await saveHolidaysToFirestore();
    });
  });
}

/* ---------- wire calendar nav & controls ---------- */
function setupCalendarControls() {
  document.getElementById('regPrevMonth')?.addEventListener('click', () => {
    regCalState.month--;
    if (regCalState.month < 0) { regCalState.month = 11; regCalState.year--; }
    renderCalendar('regHolidayCalendar', regCalState, regHolidays, 'regMonthLabel');
  });
  document.getElementById('regNextMonth')?.addEventListener('click', () => {
    regCalState.month++;
    if (regCalState.month > 11) { regCalState.month = 0; regCalState.year++; }
    renderCalendar('regHolidayCalendar', regCalState, regHolidays, 'regMonthLabel');
  });
  document.getElementById('clearRegHolidays')?.addEventListener('click', async () => {
    if (!confirm('Clear all Regular Holidays?')) return;
    regHolidays.clear();
    renderCalendar('regHolidayCalendar', regCalState, regHolidays, 'regMonthLabel');
    await saveHolidaysToFirestore();
  });

  document.getElementById('specPrevMonth')?.addEventListener('click', () => {
    specCalState.month--;
    if (specCalState.month < 0) { specCalState.month = 11; specCalState.year--; }
    renderCalendar('specHolidayCalendar', specCalState, specHolidays, 'specMonthLabel');
  });
  document.getElementById('specNextMonth')?.addEventListener('click', () => {
    specCalState.month++;
    if (specCalState.month > 11) { specCalState.month = 0; specCalState.year++; }
    renderCalendar('specHolidayCalendar', specCalState, specHolidays, 'specMonthLabel');
  });
  document.getElementById('clearSpecHolidays')?.addEventListener('click', async () => {
    if (!confirm('Clear all Special Holidays?')) return;
    specHolidays.clear();
    renderCalendar('specHolidayCalendar', specCalState, specHolidays, 'specMonthLabel');
    await saveHolidaysToFirestore();
  });
}

/* ---------- Utility helpers payroll should call ---------- */
function normalizeToISODateOnly(d) {
  const dt = new Date(d);
  return dt.toISOString().slice(0,10);
}
function isRegHoliday(dateOrIso) {
  const iso = (typeof dateOrIso === 'string') ? (new Date(dateOrIso)).toISOString().slice(0,10) : normalizeToISODateOnly(dateOrIso);
  return regHolidays.has(iso);
}
function isSpecHoliday(dateOrIso) {
  const iso = (typeof dateOrIso === 'string') ? (new Date(dateOrIso)).toISOString().slice(0,10) : normalizeToISODateOnly(dateOrIso);
  return specHolidays.has(iso);
}

/* ---------- Init: load + render ---------- */
(async function initHolidayPickers() {
  try {
    await loadHolidaysFromFirestore();
    renderCalendar('regHolidayCalendar', regCalState, regHolidays, 'regMonthLabel');
    renderCalendar('specHolidayCalendar', specCalState, specHolidays, 'specMonthLabel');
    setupCalendarControls();
  } catch (err) {
    console.error('initHolidayPickers failed', err);
  }
})();

// Export helper functions for other code (if module environment)
window.payrollHolidays = {
  isRegHoliday,
  isSpecHoliday,
  getRegHolidays: () => Array.from(regHolidays),
  getSpecHolidays: () => Array.from(specHolidays)
};

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

// Helper: format various date/timestamp types to `yyyy-MM-dd` for input[type=date].
function formatDateForInput(v) {
  if (!v && v !== 0) return '';
  // Already a proper string
  if (typeof v === 'string') {
    // Accept yyyy-mm-dd or ISO-like strings
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    const parsed = new Date(v);
    if (!isNaN(parsed.getTime())) return parsed.toISOString().slice(0,10);
    return '';
  }
  // Firestore Timestamp has toDate()
  if (typeof v.toDate === 'function') {
    const d = v.toDate();
    return isNaN(d.getTime()) ? '' : d.toISOString().slice(0,10);
  }
  // Raw object with seconds/nanoseconds
  if (v && typeof v === 'object' && (v.seconds !== undefined || v.nanoseconds !== undefined)) {
    try {
      const ms = Number(v.seconds || 0) * 1000 + Math.round((Number(v.nanoseconds || 0) / 1e6));
      const d = new Date(ms);
      return isNaN(d.getTime()) ? '' : d.toISOString().slice(0,10);
    } catch (e) {
      return '';
    }
  }
  // Date object
  if (v instanceof Date) {
    return isNaN(v.getTime()) ? '' : v.toISOString().slice(0,10);
  }
  // Fallback when type is not recognized
  return '';
}

function renderTable() {
  if (!payrollBody) return;
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

      <!-- Days: default from attendance but now editable by admin -->
      <td><input class="input-small" data-field="daysWorked" data-id="${r.userId}" value="${escapeHtml(fmt(r.daysWorked || auto.daysWorked || ''))}" placeholder="${escapeHtml(fmt(r.daysWorked || auto.daysWorked || ''))}" /></td>

      <td><input class="input-small" data-field="hoursWorked" data-id="${r.userId}" value="${escapeHtml(fmt(r.hoursWorked || auto.hoursWorked || ''))}" placeholder="${escapeHtml(fmt(r.hoursWorked || auto.hoursWorked || ''))}" /></td>

      <td><input class="input-small" data-field="ndHours" data-id="${r.userId}" value="${escapeHtml(fmt(r.ndHours || auto.ndHours || ''))}" placeholder="${escapeHtml(fmt(r.ndHours || auto.ndHours || ''))}" /></td>

      <td><input class="input-small" data-field="ndOtHours" data-id="${r.userId}" value="${escapeHtml(fmt(r.ndOtHours || auto.ndOtHours || ''))}" placeholder="${escapeHtml(fmt(r.ndOtHours || auto.ndOtHours || ''))}" /></td>

      <td><input class="input-small" data-field="otHours" data-id="${r.userId}" value="${escapeHtml(fmt(r.otHours || auto.otHours || ''))}" placeholder="${escapeHtml(fmt(r.otHours || auto.otHours || ''))}" /></td>

      <td><input class="input-small" data-field="regularHolidayHours" data-id="${r.userId}" value="${escapeHtml(fmt(r.regularHolidayHours || auto.regHolidayHours || ''))}" placeholder="${escapeHtml(fmt(r.regularHolidayHours || auto.regHolidayHours || ''))}" /></td>

      <td><input class="input-small" data-field="specialHolidayHours" data-id="${r.userId}" value="${escapeHtml(fmt(r.specialHolidayHours || auto.specialHolidayHours || ''))}" placeholder="${escapeHtml(fmt(r.specialHolidayHours || auto.specialHolidayHours || ''))}" /></td>

      <!-- statutory deductions: default from automation but now editable overrides -->
      <td><input class="input-small" data-field="sss" data-id="${r.userId}" value="${escapeHtml(fmt(r.sss ?? ph_sss))}" placeholder="${escapeHtml(fmt(ph_sss))}" /></td>
      <td><input class="input-small" data-field="philhealth" data-id="${r.userId}" value="${escapeHtml(fmt(r.philhealth ?? ph_phil))}" placeholder="${escapeHtml(fmt(ph_phil))}" /></td>
      <td><input class="input-small" data-field="pagibig" data-id="${r.userId}" value="${escapeHtml(fmt(r.pagibig ?? ph_pagibig))}" placeholder="${escapeHtml(fmt(ph_pagibig))}" /></td>
      <!-- ST. Peter: manual deduction -->
      <td><input class="input-small" data-field="stPeter" data-id="${r.userId}" value="${escapeHtml(val('stPeter'))}" placeholder="${escapeHtml(fmt(ph_stp))}" /></td>

      <!-- loans (manual deductions) -->
      <td><input class="input-small" data-field="sssSalaryLoan" data-id="${r.userId}" value="${escapeHtml(val('sssSalaryLoan'))}" placeholder="${escapeHtml(fmt(r.sssSalaryLoan || '0'))}" /></td>
      <td><input class="input-small" data-field="sssCalamityLoan" data-id="${r.userId}" value="${escapeHtml(val('sssCalamityLoan'))}" placeholder="${escapeHtml(fmt(r.sssCalamityLoan || '0'))}" /></td>
      <td><input class="input-small" data-field="hdmfSalaryLoan" data-id="${r.userId}" value="${escapeHtml(val('hdmfSalaryLoan'))}" placeholder="${escapeHtml(fmt(r.hdmfSalaryLoan || '0'))}" /></td>
      <td><input class="input-small" data-field="hdmfCalamityLoan" data-id="${r.userId}" value="${escapeHtml(val('hdmfCalamityLoan'))}" placeholder="${escapeHtml(fmt(r.hdmfCalamityLoan || '0'))}" /></td>
      <td><input class="input-small" data-field="cashAdvance" data-id="${r.userId}" value="${escapeHtml(val('cashAdvance'))}" placeholder="${escapeHtml(fmt(r.cashAdvance || '0'))}" /></td>
      <td><input class="input-small" data-field="credit" data-id="${r.userId}" value="${escapeHtml(val('credit'))}" placeholder="${escapeHtml(fmt(r.credit || '0'))}" /></td>

      <!-- UT / Late: default from attendance but editable -->
      <td><input class="input-small" data-field="utLateHours" data-id="${r.userId}" value="${escapeHtml(fmt(r.utLateHours || auto.utLateHours || ''))}" placeholder="${escapeHtml(fmt(r.utLateHours || auto.utLateHours || ''))}" /></td>
      <td><input class="input-small" data-field="utLateAmount" data-id="${r.userId}" value="${escapeHtml(fmt(r.utLateAmount || auto.utLateAmount || ''))}" placeholder="${escapeHtml(fmt(r.utLateAmount || auto.utLateAmount || ''))}" /></td>

      <!-- Gross / Deductions: fully automated, read-only; Net Pay remains computed-only -->
      <td><input class="input-small" data-field="grossPay" data-id="${r.userId}" value="${escapeHtml(ph_gross)}" placeholder="${escapeHtml(ph_gross)}" readonly /></td>
      <td><input class="input-small" data-field="deductionsTotal" data-id="${r.userId}" value="${escapeHtml(ph_deductions_total)}" placeholder="${escapeHtml(ph_deductions_total)}" readonly /></td>
      <td><input class="input-small" data-field="netPay" data-id="${r.userId}" value="${escapeHtml(ph_net)}" placeholder="${escapeHtml(ph_net)}" readonly /></td>

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
        // Editable numeric inputs; gross/deductions/net remain computed-only
        'ratePerDay',
        'daysWorked','hoursWorked','ndHours','ndOtHours','otHours',
        'regularHolidayHours','specialHolidayHours',
        'sss','philhealth','pagibig','stPeter',
        'sssSalaryLoan','sssCalamityLoan','hdmfSalaryLoan','hdmfCalamityLoan','cashAdvance','credit',
        'utLateHours','utLateAmount'
      ];

      // store using camelCase UI names; when saving we map to Firestore literal keys
      if (numericFields.includes(field)) {
        const parsed = inp.value === '' ? null : Number(inp.value);
        row[field] = parsed;

        // Persist ratePerDay edits directly onto the user document so they
        // remain permanent across payroll runs and page refreshes.
        if (field === 'ratePerDay' && parsed !== null && !Number.isNaN(parsed)) {
          try {
            const uref = doc(db, 'users', id);
            // fire-and-forget; no need to await here
            updateDoc(uref, { ratePerDay: parsed }).catch(e => console.warn('Failed to update user ratePerDay', e));
          } catch (e) {
            console.warn('Error scheduling ratePerDay update', e);
          }
        }

        // no special propagation behavior; all other deductions are automated
      } else {
        row[field] = inp.value;
      }
    });
  });

  if (typeof rowsCountEl !== 'undefined' && rowsCountEl && 'textContent' in rowsCountEl) {
    rowsCountEl.textContent = String(rows.length);
  }
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
    showPayrollLoading('Loading users and payroll table…');
    setStatus('Loading users...');
    // attempt to seed ratePerDay and notes from the most recent saved payroll run
    const { ratesMap: latestRates, runMeta: latestRunMeta, linesMap: latestLines } = await fetchMostRecentPayrollRun().catch(err => {
      console.warn('Could not fetch latest payroll run, falling back to user base rates/notes', err);
      return { ratesMap: new Map(), runMeta: null, linesMap: new Map() };
    });

    const q = query(collection(db, 'users'), orderBy('username'));
    const snap = await getDocs(q);
    usersList = snap.docs.map(d => ({ userId: d.id, ...(d.data() || {}) }));
    rows = usersList.map(u => {
      const savedLine = (latestLines && latestLines.has(u.userId)) ? latestLines.get(u.userId) : null;
      return {
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
      sssSalaryLoan: Number((savedLine && savedLine['sss salary loan']) || 0),
      sssCalamityLoan: Number((savedLine && savedLine['sss calamity loan']) || 0),
      hdmfSalaryLoan: Number((savedLine && savedLine['hdmf salary loan']) || 0),
      hdmfCalamityLoan: Number((savedLine && savedLine['hdmf calamity loan']) || 0),
      cashAdvance: Number((savedLine && savedLine.cashAdvance) || 0),
      utLateHours: Number((savedLine && savedLine['ut/late']) || 0),
      utLateAmount: Number((savedLine && savedLine['ut/late amount']) || 0),
      // seed note from most recent run line if present, else use user doc note
      note: ((savedLine && savedLine.note) ? savedLine.note : (u.note || '')),
      _manualGross: null,
      _manualDeductions: null,
      _manualNet: null,
      adjustmentsCents: 0
    };
    });

    // if we have a recent run meta, populate the period inputs
    try {
      if (latestRunMeta) {
        const ps = document.getElementById('periodStart');
        const pe = document.getElementById('periodEnd');
        if (ps && latestRunMeta.periodStart) ps.value = formatDateForInput(latestRunMeta.periodStart);
        if (pe && latestRunMeta.periodEnd) pe.value = formatDateForInput(latestRunMeta.periodEnd);
      }
    } catch (e) { console.warn('failed to set period from latest run', e); }

    renderTable();
    setStatus(`Loaded ${rows.length} users.`);
  } catch (err) {
    console.error('loadUsersAndAttendance error', err);
    setStatus('Failed to load users: ' + (err.message || err), true);
  } finally {
    hidePayrollLoading();
  }
}

   /* 
    NOTE:
    This implementation preserves the precise ND/OT segmentation behavior from the
    earlier version of your payroll logic by computing ndHours, ndOtHours, and
    otHours from attendance records and then aggregating them per user.
   */
async function loadAttendanceForRows(startDateStr, endDateStr) {
  if (!startDateStr || !endDateStr) return;
  showPayrollLoading('Loading attendance and recalculating…');
  setStatus('Loading attendance for period...');
  const startDate = new Date(startDateStr);
  startDate.setHours(0,0,0,0);
  const endDate = new Date(endDateStr);
  endDate.setHours(23,59,59,999);

  // helper: compute scheduled shift start Date for a given clock-in
  function getShiftStartForClockIn(shiftName, clockInDate) {
    const ci = new Date(clockInDate);
    const y = ci.getFullYear();
    const m = ci.getMonth();
    const d = ci.getDate();
    const h = ci.getHours();

    // default morning: 06:00 same calendar day
    if (shiftName === 'morning') {
      return new Date(y, m, d, 6, 0, 0, 0);
    }

    // mid shift: 14:00 same calendar day
    if (shiftName === 'mid') {
      return new Date(y, m, d, 14, 0, 0, 0);
    }

    // night shift: typically 22:00–05:59.
    // If clock-in is after midnight but before 06:00, treat shift start as 22:00 previous calendar day.
    if (shiftName === 'night') {
      if (h < 6) {
        const prev = new Date(y, m, d);
        prev.setDate(prev.getDate() - 1);
        return new Date(prev.getFullYear(), prev.getMonth(), prev.getDate(), 22, 0, 0, 0);
      }
      return new Date(y, m, d, 22, 0, 0, 0);
    }

    // unknown shift: no scheduled start
    return null;
  }

  for (const r of rows) {
    try {
      // First, try QR-scanner style events that use rawTime + mode (time-in/time-out)
      const attCol = collection(db, 'attendance');
      const startIso = startDate.toISOString();
      const endIso = endDate.toISOString();

      const qrStyleQ = query(
        attCol,
        where('userId', '==', r.userId),
        where('rawTime', '>=', startIso),
        where('rawTime', '<=', endIso),
        orderBy('rawTime')
      );
      let snap = await getDocs(qrStyleQ);

      // If no QR-style events found, fall back to legacy clockIn/clockOut documents
      let usingLegacy = false;
      if (!snap || snap.empty) {
        const legacyQ = query(
          attCol,
          where('userId', '==', r.userId),
          where('clockIn', '>=', Timestamp.fromDate(startDate)),
          where('clockIn', '<=', Timestamp.fromDate(endDate)),
          orderBy('clockIn')
        );
        snap = await getDocs(legacyQ);
        usingLegacy = true;
      }
      const hadAttendance = snap && !snap.empty;

      // If there is no attendance for this user in the selected period, preserve any
      // manual values entered by the user (do not overwrite with zeros).
      if (!hadAttendance) {
        // leave r.* fields as-is and continue to next row
        continue;
      }

      // reset (we have attendance rows and will compute fresh aggregates)
      r.daysWorked = 0;
      r.hoursWorked = 0;
      r.ndHours = 0;
      r.ndOtHours = 0;
      r.otHours = 0;
      r.regularHolidayHours = 0;
      r.specialHolidayHours = 0;
      // reset UT/Late tracking (will be computed from per-day aggregation)
      r.utLateHours = 0;
      r.utLateAmount = 0;

      // aggregate per day (simple approach)
      const perDay = {};
      const perDayLateMinutes = {};

      if (usingLegacy) {
        // Legacy documents with explicit clockIn/clockOut
        for (const d of snap.docs) {
          const data = d.data();
          const ci = data.clockIn instanceof Timestamp ? data.clockIn.toDate() : new Date(data.clockIn);
          const co = data.clockOut ? (data.clockOut instanceof Timestamp ? data.clockOut.toDate() : new Date(data.clockOut)) : null;
          if (!ci || !co || co <= ci) continue;

          const ms = co - ci;
          const hours = ms / (1000 * 60 * 60);

          const dKey = `${ci.getFullYear()}-${String(ci.getMonth()+1).padStart(2,'0')}-${String(ci.getDate()).padStart(2,'0')}`;
          perDay[dKey] = (perDay[dKey] || 0) + hours;

          // Late detection per scan based on scheduled shift start and 30-minute grace window
          if (r.shift) {
            const shiftStart = getShiftStartForClockIn(r.shift, ci);
            if (shiftStart && ci > shiftStart) {
              const diffMs = ci.getTime() - shiftStart.getTime();
              const diffMin = Math.floor(diffMs / 60000);
              const graceMin = 30;
              if (diffMin > graceMin) {
                const lateMin = diffMin - graceMin;
                perDayLateMinutes[dKey] = (perDayLateMinutes[dKey] || 0) + lateMin;
              }
            }
          }

          // ND detection in segments (rough approximation using 15-min slices)
          let t = new Date(ci);
          const last = new Date(co);
          const stepMs = 15 * 60 * 1000;
          while (t < last) {
            const tNext = new Date(Math.min(t.getTime() + stepMs, last.getTime()));
            const segHours = (tNext - t) / (1000 * 60 * 60);
            const segIsND = isNightDiffTime(t);
            if (segIsND) r.ndHours = (r.ndHours || 0) + segHours;
            t = tNext;
          }
        }
      } else {
        // QR-style events: pair time-in / time-out per day
        const events = snap.docs
          .map(d => ({ id: d.id, ...(d.data() || {}) }))
          .filter(e => e.rawTime && e.mode)
          .map(e => ({
            mode: String(e.mode || '').toLowerCase(),
            time: new Date(e.rawTime)
          }))
          .filter(e => !isNaN(e.time.getTime()))
          .sort((a, b) => a.time - b.time);

        const used = new Set();
        for (let i = 0; i < events.length; i++) {
          if (used.has(i)) continue;
          const evIn = events[i];
          if (evIn.mode !== 'time-in') continue;

          // find the next unused time-out after this time-in
          let evOut = null;
          for (let j = i + 1; j < events.length; j++) {
            if (used.has(j)) continue;
            if (events[j].mode === 'time-out' && events[j].time > evIn.time) {
              evOut = events[j];
              used.add(j);
              break;
            }
          }
          if (!evOut) continue;

          used.add(i);
          const ci = evIn.time;
          const co = evOut.time;
          if (!ci || !co || co <= ci) continue;

          const ms = co - ci;
          const hours = ms / (1000 * 60 * 60);

          const dKey = `${ci.getFullYear()}-${String(ci.getMonth()+1).padStart(2,'0')}-${String(ci.getDate()).padStart(2,'0')}`;
          perDay[dKey] = (perDay[dKey] || 0) + hours;

          // Late detection based on scheduled shift start and 30-minute grace window
          if (r.shift) {
            const shiftStart = getShiftStartForClockIn(r.shift, ci);
            if (shiftStart && ci > shiftStart) {
              const diffMs = ci.getTime() - shiftStart.getTime();
              const diffMin = Math.floor(diffMs / 60000);
              const graceMin = 30;
              if (diffMin > graceMin) {
                const lateMin = diffMin - graceMin;
                perDayLateMinutes[dKey] = (perDayLateMinutes[dKey] || 0) + lateMin;
              }
            }
          }

          // ND detection in segments (15-min slices)
          let t = new Date(ci);
          const last = new Date(co);
          const stepMs = 15 * 60 * 1000;
          while (t < last) {
            const tNext = new Date(Math.min(t.getTime() + stepMs, last.getTime()));
            const segHours = (tNext - t) / (1000 * 60 * 60);
            const segIsND = isNightDiffTime(t);
            if (segIsND) r.ndHours = (r.ndHours || 0) + segHours;
            t = tNext;
          }
        }
      }

      for (const k of Object.keys(perDay)) {
        const h = perDay[k];

        // Shift-specific day length: morning/mid = 8h, night = 9h
        const shiftName = (r.shift || '').toLowerCase();
        const dayHours = (shiftName === 'night') ? 9 : 8;

        // Convert hours -> days using shift-specific threshold (allow fractional days)
        r.daysWorked += (h / dayHours);
        r.hoursWorked += h;

        // Overtime is any work beyond the shift-specific daily hours
        if (h > dayHours) r.otHours += (h - dayHours);

        // UNDER-TIME / LATE detection (conservative default):
        // If daily worked hours < 8, count the difference as UT/Late hours.
        // (This is a simple rule; adjust if you have scheduled shift expected hours.)
        const lateMinutesForDay = perDayLateMinutes[k] || 0;
        if (lateMinutesForDay > 0) {
          // convert accumulated late minutes (beyond 30-minute grace) into hours
          r.utLateHours = (r.utLateHours || 0) + (lateMinutesForDay / 60);
        } else if (!r.shift && h < 8) {
          // Fallback when no shift is configured: keep previous behavior
          r.utLateHours = (r.utLateHours || 0) + (8 - h);
        }
      }

      // estimate ndOtHours as min(ndHours, otHours)
      r.ndOtHours = Math.min(Number(r.ndHours || 0), Number(r.otHours || 0));

      // Compute UT / LATE AMOUNT automatically using Rate/Day / 8 * utLateHours
      // If ratePerDay is missing, leave utLateAmount at existing value (0)
      if (Number(r.ratePerDay || 0) > 0) {
        r.utLateAmount = (Number(r.ratePerDay) / 8) * (Number(r.utLateHours || 0));
      } else {
        r.utLateAmount = Number(r.utLateAmount || 0);
      }

    } catch (err) {
      console.warn('attendance load error for', r.userId, err);
    }
  }

  setStatus('Attendance loaded.');
  renderTable();
  hidePayrollLoading();
}

// Calculate using computePayrollLine; computed values placed on r._calc
function calculateAll() {
  rows.forEach(r => {
    const sumLoans = Number(r.sssSalaryLoan || 0)
             + Number(r.sssCalamityLoan || 0)  // added
             + Number(r.hdmfSalaryLoan || 0)
             + Number(r.hdmfCalamityLoan || 0)
             + Number(r.cashAdvance || 0)
             + Number(r.stPeter || 0) // St. Peter treated as manual deduction
             + Number(r.credit || 0); // include credit in manual deductions

    // Under Time / Late Amount = (daily rate / 8) * missing hours
    const ratePerDayNum = Number(r.ratePerDay || 0);
    const utHours = Number(r.utLateHours || 0);
    const utLateAmt = (ratePerDayNum / 8) * utHours;
    r.utLateAmount = utLateAmt; // reflect back to the UI/rendering model

    const adjustmentsCents = toCents(sumLoans + utLateAmt) + Number(r.adjustmentsCents || 0);

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

    // Only pass a monthlySalary estimate into statutory computations when there is actual work in the period.
    // If days/hours are zero (no pay for the period), avoid using the monthly estimate which would trigger
    // PhilHealth floor/ceiling logic and produce non-zero contributions even when gross is empty.
    const hasWork = (Number(r.daysWorked || 0) > 0) || (Number(r.hoursWorked || 0) > 0);
    const monthlySalaryForStat = hasWork ? monthlySalaryEstimate : null;
    const sssOverride = findSssFromPayload(monthlySalaryForStat);
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
      monthlySalary: monthlySalaryForStat,
      periodScaling: periodScaling,
      manualSss: (r.sss !== null && r.sss !== undefined ? r.sss : null),
      manualPhilhealth: (r.philhealth !== null && r.philhealth !== undefined ? r.philhealth : null),
      manualPagibig: (r.pagibig !== undefined && r.pagibig !== null ? r.pagibig : null),
      manualStPeter: (r.stPeter !== null && r.stPeter !== undefined ? r.stPeter : null),
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
    showPayrollLoading('Saving payroll run…');
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
          adjustmentsCents: toCents(
            Number(r.sssSalaryLoan || 0) +
            Number(r.sssCalamityLoan || 0) +
            Number(r.hdmfSalaryLoan || 0) +
            Number(r.hdmfCalamityLoan || 0) +
            Number(r.cashAdvance || 0) +
            Number(r.credit || 0) +
            Number(r.utLateAmount || 0)
          ),
          manualSss: (r.sss !== null && r.sss !== undefined ? r.sss : null),
          manualPhilhealth: (r.philhealth !== null && r.philhealth !== undefined ? r.philhealth : null),
          manualPagibig: (r.pagibig !== undefined && r.pagibig !== null ? r.pagibig : null),
          manualStPeter: (r.stPeter !== null && r.stPeter !== undefined ? r.stPeter : null),
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
        'sss calamity loan': Number(r.sssCalamityLoan || 0),
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
  } finally {
    hidePayrollLoading();
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
    'sss salary loan','sss calamity loan','hdmf salary loan','hdmf calamity loan','cashAdvance',
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
      r.sssCalamityLoan || 0,
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

// Wiring (defensive: only attach listeners if the elements exist on the page)
if (typeof loadUsersBtn !== 'undefined' && loadUsersBtn && loadUsersBtn.addEventListener) {
  loadUsersBtn.addEventListener('click', async () => {
    loadUsersBtn.disabled = true;
    await loadUsersAndAttendance();
    loadUsersBtn.disabled = false;
  });
}

if (typeof calculateBtn !== 'undefined' && calculateBtn && calculateBtn.addEventListener) {
  calculateBtn.addEventListener('click', async () => {
    const periodStartEl = document.getElementById('periodStart');
    const periodEndEl = document.getElementById('periodEnd');
    const start = periodStartEl ? periodStartEl.value : '';
    const end = periodEndEl ? periodEndEl.value : '';
    if (start && end) {
      await loadAttendanceForRows(start, end);
    }
    calculateAll();
  });
}

if (typeof saveRunBtn !== 'undefined' && saveRunBtn && saveRunBtn.addEventListener) {
  saveRunBtn.addEventListener('click', savePayrollRun);
}

if (typeof exportCsvBtn !== 'undefined' && exportCsvBtn && exportCsvBtn.addEventListener) {
  exportCsvBtn.addEventListener('click', exportCsv);
}

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

// File-specific parser + preview renderer for your Tabulation 2025.xlsx
// Requires XLSX (SheetJS) to be loaded before this runs.

async function parseTabulation2025File(file) {
  if (!file) throw new Error('No file provided');
  if (typeof XLSX === 'undefined') throw new Error('XLSX (SheetJS) not loaded');

  const ab = await file.arrayBuffer();
  const wb = XLSX.read(ab, { type: 'array', cellDates: true, defval: '' });

  // pick the sheet named "Tabulation" or first sheet
  const sheetName = wb.SheetNames.find(n => /tabulation|sss|tab/i.test(n)) || wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];

  // get raw rows as arrays
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  // According to the uploaded file, headers are at rows index 1..2 (0-based),
  // and data begins at row index 3. We'll use that mapping explicitly to avoid guessing.
  const headerStart = 1;
  const headerRowCount = 2;
  const dataStart = headerStart + headerRowCount; // 3

  // Map exact column indices found in your sheet:
  const IDX = {
    RANGE_FROM: 0,
    RANGE_TO: 1,
    MSC_EMP_COMP: 2,
    MSC_MPF: 3,
    MSC_TOTAL: 4,
    EMPLOYER_REGULAR_SS: 5,
    EMPLOYER_MPF: 6,
    EMPLOYER_EC: 7,
    EMPLOYER_TOTAL: 8,
    EMPLOYEE_REGULAR_SS: 9,
    EMPLOYEE_MPF: 10,
    EMPLOYEE_TOTAL: 11,
    GRAND_TOTAL: 12
  };

  function parseNum(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number' && isFinite(v)) return v;
    let s = String(v).trim();
    if (!s || /^[-—–]$/.test(s)) return null;
    // remove non-number characters except ., -, parentheses
    const isPar = /^\(.*\)$/.test(s);
    s = s.replace(/[^0-9\.\-\(\)]/g, '');
    if (isPar) s = '-' + s.replace(/[()]/g, '');
    // fix multiple dots (keep last as decimal)
    if ((s.match(/\./g) || []).length > 1) {
      const parts = s.split('.');
      s = parts.slice(0, -1).join('').replace(/\./g, '') + '.' + parts[parts.length - 1];
    } else {
      s = s.replace(/\./g, (m, i, st) => {
        // if there's more than 3 digits before dot and no other dot, treat dot as decimal; otherwise leave (we handle below)
        return '.';
      });
    }
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  const parsedRows = [];
  for (let r = dataStart; r < raw.length; r++) {
    const row = raw[r] || [];
    // skip empty rows
    if (!row.some(c => (c !== null && c !== undefined && String(c).trim() !== ''))) continue;

    // read values by column index (we standardize missing to null)
    const get = (i) => (i >= 0 && i < row.length) ? row[i] : '';

    // Range handling (FROM/TO)
    const rawFrom = get(IDX.RANGE_FROM);
    const rawTo = get(IDX.RANGE_TO);
    const rangeFrom = parseNum(rawFrom);
    const rangeTo = parseNum(rawTo);

    // numeric fields
    const msc_emp_comp = parseNum(get(IDX.MSC_EMP_COMP));
    const msc_mpf = parseNum(get(IDX.MSC_MPF));
    const msc_total = parseNum(get(IDX.MSC_TOTAL));

    const emp_reg = parseNum(get(IDX.EMPLOYER_REGULAR_SS));
    const emp_mpf = parseNum(get(IDX.EMPLOYER_MPF));
    const emp_ec = parseNum(get(IDX.EMPLOYER_EC));
    const emp_total = parseNum(get(IDX.EMPLOYER_TOTAL));

    const ee_reg = parseNum(get(IDX.EMPLOYEE_REGULAR_SS));
    const ee_mpf = parseNum(get(IDX.EMPLOYEE_MPF));
    const ee_total = parseNum(get(IDX.EMPLOYEE_TOTAL));

    const grand_total = parseNum(get(IDX.GRAND_TOTAL));

    // fallback compute totals if missing
    const computedEmployerTotal = [emp_reg, emp_mpf, emp_ec].some(x => x != null) ? (Number(emp_reg || 0) + Number(emp_mpf || 0) + Number(emp_ec || 0)) : (emp_total != null ? emp_total : null);
    const computedEmployeeTotal = [ee_reg, ee_mpf].some(x => x != null) ? (Number(ee_reg || 0) + Number(ee_mpf || 0)) : (ee_total != null ? ee_total : null);
    const computedGrand = (computedEmployerTotal != null || computedEmployeeTotal != null) ? (Number(computedEmployerTotal || 0) + Number(computedEmployeeTotal || 0)) : (grand_total != null ? grand_total : null);

    parsedRows.push({
      rowIndex: r,
      rangeFrom,
      rangeTo,
      msc_emp_comp,
      msc_mpf,
      msc_total,
      employer: { regularSS: emp_reg, mpf: emp_mpf, ec: emp_ec, total: emp_total != null ? emp_total : computedEmployerTotal },
      employee: { regularSS: ee_reg, mpf: ee_mpf, total: ee_total != null ? ee_total : computedEmployeeTotal },
      totalContribution: grand_total != null ? grand_total : computedGrand,
      rawRow: row
    });
  }

  return { sheetName, parsedRows };
}


// Render preview that mirrors Excel grouped header layout
function renderTabulationPreview(parsedRows, container) {
  if (!container) container = document.getElementById('tabulationPreview') || document.body;
  container.innerHTML = '';

  const table = document.createElement('table');
  table.style.width = '100%';
  table.style.borderCollapse = 'collapse';
  table.style.fontFamily = 'Arial, sans-serif';
  table.style.fontSize = '13px';

  // build header (top row groups + second-row subheaders)
  const thead = document.createElement('thead');
  const top = document.createElement('tr');
  const sub = document.createElement('tr');

  const makeTH = (txt, opts = {}) => {
    const th = document.createElement('th');
    th.innerHTML = txt;
    if (opts.colspan) th.colSpan = opts.colspan;
    if (opts.rowspan) th.rowSpan = opts.rowspan;
    th.style.border = '1px solid #dcdcdc';
    th.style.padding = '6px';
    th.style.textAlign = 'center';
    th.style.background = '#e8f7d6';
    th.style.fontWeight = '700';
    return th;
  };

  // top grouped headers
  // Range of Compensation -> colspan 2 (FROM, TO)
  top.appendChild(makeTH('RANGE OF COMPENSATION', { colspan: 2 }));
  // Monthly Salary Credit -> Employees Compensation | Mandatory Provident Fund | Total
  top.appendChild(makeTH('MONTHLY SALARY CREDIT', { colspan: 3 }));
  // Employer group -> 4 subcols
  top.appendChild(makeTH('EMPLOYER', { colspan: 4 }));
  // Employee group -> 3 subcols
  top.appendChild(makeTH('EMPLOYEE', { colspan: 3 }));
  // Grand TOTAL column (right-most) — rowspan 2
  top.appendChild(makeTH('TOTAL', { rowspan: 2 }));

  // second/sub header row (must match colspan counts):
  const subHeaders = [
    'FROM', 'TO',
    'EMPLOYEES COMPENSATION', 'MANDATORY PROVIDENT FUND', 'TOTAL',
    'REGULAR SS', 'MPF', 'EC', 'TOTAL',
    'REGULAR SS', 'MPF', 'TOTAL'
  ];
  for (const h of subHeaders) {
    const th = document.createElement('th');
    th.textContent = h;
    th.style.border = '1px solid #dcdcdc';
    th.style.padding = '6px';
    th.style.textAlign = 'center';
    th.style.background = '#ffffff';
    th.style.fontWeight = '700';
    sub.appendChild(th);
  }

  thead.appendChild(top);
  thead.appendChild(sub);
  table.appendChild(thead);

  // body
  const tbody = document.createElement('tbody');
  const format = (v) => {
    if (v === null || v === undefined || v === '') return '';
    if (typeof v === 'number') return v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const n = Number(String(v).replace(/[^0-9\.\-]/g, ''));
    return Number.isFinite(n) ? n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(v);
  };

  for (const pr of parsedRows) {
    const tr = document.createElement('tr');

    // Range FROM, TO
    const td = (v, align = 'right') => {
      const cell = document.createElement('td');
      cell.textContent = (v === null || v === undefined || v === '') ? '' : (typeof v === 'number' ? format(v) : String(v));
      cell.style.border = '1px solid #eee';
      cell.style.padding = '6px';
      cell.style.textAlign = align;
      return cell;
    };

    tr.appendChild(td(pr.rangeFrom, 'right'));
    tr.appendChild(td(pr.rangeTo, 'right'));

    // Monthly Salary Credit subcolumns:
    // 1) Employees compensation (msc_emp_comp)
    // 2) Mandatory Provident Fund (msc_mpf)
    // 3) MSC total (msc_total or fallback to msc_emp_comp)
    tr.appendChild(td(pr.msc_emp_comp, 'right'));
    tr.appendChild(td(pr.msc_mpf, 'right'));
    tr.appendChild(td(pr.msc_total != null ? pr.msc_total : pr.msc_emp_comp, 'right'));

    // Employer: REGULAR SS, MPF, EC, TOTAL
    tr.appendChild(td(pr.employer && pr.employer.regularSS, 'right'));
    tr.appendChild(td(pr.employer && pr.employer.mpf, 'right'));
    tr.appendChild(td(pr.employer && pr.employer.ec, 'right'));
    tr.appendChild(td(pr.employer && (pr.employer.total != null ? pr.employer.total : '')));

    // Employee: REGULAR SS, MPF, TOTAL
    tr.appendChild(td(pr.employee && pr.employee.regularSS, 'right'));
    tr.appendChild(td(pr.employee && pr.employee.mpf, 'right'));
    tr.appendChild(td(pr.employee && (pr.employee.total != null ? pr.employee.total : '')));

    // Grand TOTAL
    tr.appendChild(td(pr.totalContribution, 'right'));

    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  container.appendChild(table);
}

inputEl && inputEl.addEventListener('change', async (ev) => {
  if (statusElSmall) statusElSmall.textContent = 'Parsing file...';
  if (previewContainerModal) previewContainerModal.innerHTML = '';
  if (warnEl) warnEl.style.display = 'none';
  try {
    const f = ev.target.files[0];
    if (!f) { if (statusElSmall) statusElSmall.textContent = 'No file selected.'; return; }
    // Use the file-specific parser tailored to Tabulation 2025
    const { sheetName, parsedRows } = await parseTabulation2025File(f);
    if (!parsedRows || parsedRows.length < 1) { if (statusElSmall) statusElSmall.textContent = 'No data rows parsed — ensure the uploaded sheet contains tabulation rows.'; return; }

    const checksum = await sha256Hex(JSON.stringify(parsedRows));

    currentPayload = {
      source: "upload",
      filename: f.name,
      uploadedBy: (auth && auth.currentUser) ? auth.currentUser.uid : 'unknown',
      uploadedAt: serverTimestamp(),
      checksum,
      table: parsedRows,
      versionNote: 'SSS Tabulation (parsed)'
    };

    previewInfo && (previewInfo.textContent = `Parsed Tabulation sheet — ${parsedRows.length} rows (sheet: ${sheetName}).`);
    renderTabulationPreview(parsedRows, previewContainerModal);

    const missing = parsedRows.filter(row => {
      const emp = (row.employee && (row.employee.total ?? row.employee.regularSS)) ?? null;
      const er = (row.employer && (row.employer.total ?? row.employer.regularSS)) ?? null;
      const tot = row.totalContribution ?? null;
      return (emp === null || emp === undefined) && (er === null || er === undefined) && (tot === null || tot === undefined);
    }).length;
    if (missing > 0) {
      warnEl && (warnEl.style.display = 'block');
      warnEl && (warnEl.textContent = `${missing} rows had no numeric employer/employee/total values. You may need to clean the sheet or confirm values.`);
    } else {
      warnEl && (warnEl.style.display = 'none');
    }

    showModal();
    if (statusElSmall) statusElSmall.textContent = `Parsed ${parsedRows.length} rows from "${f.name}". Preview shown.`;
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
