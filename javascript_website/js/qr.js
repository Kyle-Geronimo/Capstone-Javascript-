import { auth, db } from './firebase-config.js'; 
import {
  collection,
  getDocs,
  query,
  orderBy,
  doc,
  updateDoc
} from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js';

// API base (matches pattern used in admin.js)
const API_BASE = (window.API_BASE && window.API_BASE.replace(/\/$/, '')) || 'http://localhost:3000';

// -------------------- GENERATOR UI refs --------------------
const createForm = document.getElementById('createForm');
const employeeSelect = document.getElementById('employeeSelect'); // new dropdown
const roleField = document.getElementById('role') || document.getElementById('roleField'); // either id 'role' or 'roleField'
const departmentSelect = document.getElementById('department') || document.getElementById('departmentSelect'); // support either id
const shiftSelect = document.getElementById('shift') || document.getElementById('shiftSelect');
const qrTypeSelect = document.getElementById('qrType'); // optional in some layouts
const resultArea = document.getElementById('resultArea');
const info = document.getElementById('info');
const qrPreview = document.getElementById('qrPreview');
const downloadBtn = document.getElementById('downloadBtn');
const printBtn = document.getElementById('printBtn');
const status = document.getElementById('status');

// -------------------- SCANNER UI refs (kept from original) --------------------
const cameraList = document.getElementById('cameraList');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const retryBtn = document.getElementById('retryBtn');
const filePicker = document.getElementById('filePicker');
const scanFileBtn = document.getElementById('scanFileBtn');
const actionSelect = document.getElementById('action');
const debugEl = document.getElementById('debug');

// -------------------- local maps & helpers --------------------
const usersMap = new Map(); 

function setStatus(msg, ok = true) {
  if (!status) return;
  status.textContent = msg ? ('Status: ' + msg) : '';
  status.className = ok ? 'utility-status success' : 'utility-status error';
}
function dbg(msg) {
  try { if (debugEl) debugEl.textContent = (new Date()).toLocaleTimeString() + '  ' + msg + '\n' + debugEl.textContent; } catch (e) {}
  console.log(msg);
}

// -------------------- Load users for dropdown --------------------
export async function loadUsersDropdown() {
  try {
    setStatus('Loading users...');
    const q = query(collection(db, 'users'), orderBy('username'));
    const snap = await getDocs(q);

    // reset
    employeeSelect.innerHTML = '<option value="">— select employee —</option>';
    usersMap.clear();

    snap.docs.forEach(d => {
      const data = d.data();
      const uid = d.id;
      const label = data.username || data.displayName || data.email || uid;
      // cache all users locally but only add to dropdown those without existing QR
      usersMap.set(uid, { uid, ...data, shift: data.shift || '' });
      if (!data.qrDataURI) {
        const opt = document.createElement('option');
        opt.value = uid;
        opt.textContent = label;
        employeeSelect.appendChild(opt);
      }
    });

    setStatus(`Loaded ${usersMap.size} users (${employeeSelect.options.length - 1} available for generator).`);
  } catch (err) {
    console.error('loadUsersDropdown error', err);
    setStatus('Failed to load users: ' + (err.message || err), false);
  }
}

if (employeeSelect) {
  employeeSelect.addEventListener('change', (e) => {
    const uid = e.target.value;
    if (!uid) {
      if (roleField) roleField.value = '';
      if (departmentSelect) departmentSelect.value = '';
      if (shiftSelect) shiftSelect.value = '';
      return;
    }
    const user = usersMap.get(uid);
    if (user) {
      if (roleField) roleField.value = user.role || '';
      if (departmentSelect) departmentSelect.value = user.department || '';
      if (shiftSelect) shiftSelect.value = user.shift || '';
    } else {
      if (roleField) roleField.value = '';
      if (departmentSelect) departmentSelect.value = '';
      if (shiftSelect) shiftSelect.value = '';
    }
  });
}

// -------------------- Generator submit handler --------------------
if (createForm) {
  createForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();

    const uid = employeeSelect ? employeeSelect.value : (document.getElementById('name') ? document.getElementById('name').value : null);
    if (!uid) {
      setStatus('Please select an employee.', false);
      return;
    }

    const user = usersMap.get(uid);

    // ---------- Prevent creation if user already has a QR ----------
    if (user && user.qrDataURI) {
      setStatus('This user already has a QR. Generation blocked.', false);
      return;
    }

    if (!user) {
      setStatus('Selected user not found.', false);
      return;
    }

    const name = user.username || user.displayName || '';
    const roleVal = (roleField && roleField.value) ? roleField.value : (user.role || '');
    const departmentVal = departmentSelect ? departmentSelect.value : (user.department || '');
    const shiftVal = shiftSelect ? (shiftSelect.value || user.shift || '') : (user.shift || '');

    // Persist changes (department / shift) to users/{uid} if they changed so payroll can read them later
    try {
      const updates = {};
      if (departmentVal && departmentVal !== user.department) updates.department = departmentVal;
      if (shiftVal && shiftVal !== user.shift) updates.shift = shiftVal;
      if (Object.keys(updates).length) {
        await updateDoc(doc(db, 'users', uid), updates);
        usersMap.set(uid, { ...user, ...updates });
      }
    } catch (err) {
      console.warn('Could not save shift/department to user doc:', err);
      // continue anyway — payload will include the shift so generator still works
    }

    setStatus('Creating employee QR...');

    try {
      const token = auth.currentUser ? await auth.currentUser.getIdToken(true).catch(e => { console.error('getIdToken failed', e); return null; }) : null;
      if (!token) {
        setStatus('Not signed in. Please sign in as admin to create employees.', false);
        return;
      }

      const res = await fetch(`${API_BASE}/api/employee`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ id: uid, name, role: roleVal, department: departmentVal })
      });

      const text = await res.text();
      let j;
      try {
        j = JSON.parse(text);
      } catch (ex) {
        console.error('Non-JSON response from /api/employee:', text);
        setStatus('Server returned non-JSON response. See console.', false);
        return;
      }

      if (j.error) {
        setStatus('Server error: ' + j.error, false);
        console.error('/api/employee returned error JSON:', j);
        return;
      }

      if (resultArea) resultArea.style.display = 'block';
      if (info) info.innerHTML = `<div><strong>${j.name}</strong> <span class="muted">${j.id}</span></div><div class="muted">Role: ${roleVal || '—'}</div>`;
      if (qrPreview) qrPreview.innerHTML = `<img class="generator-qr-image" id="qrImg" src="${j.qrDataURI}" alt="QR for ${j.name}" />`;

      if (j.existing) {
        setStatus('User already has a QR — returned existing QR.');
      } else {
        setStatus('Employee created. Right-click QR to save, or use Download/Print.');
      }

      try {
        await updateDoc(doc(db, 'users', uid), { qrDataURI: j.qrDataURI, department: departmentVal });
      } catch (e) {
        console.warn('Failed to update user doc with qrDataURI/department', e);
      }

      window.__lastQR = { id: j.id, name: j.name, dataURI: j.qrDataURI };

    } catch (err) {
      console.error('Error creating employee QR:', err);
      setStatus('Network/server error: ' + (err.message || err), false);
    }
  });
}

const generateBtnAlt = document.getElementById('generateQrBtn');
if (generateBtnAlt && !createForm) {
  generateBtnAlt.addEventListener('click', async () => {
    const uid = employeeSelect ? employeeSelect.value : null;
    if (!uid) { setStatus('Please select an employee.', false); return; }
    const user = usersMap.get(uid);
    if (!user) { setStatus('Selected user not found.', false); return; }
    const name = user.username || user.displayName || '';
    const roleVal = (roleField && roleField.value) ? roleField.value : (user.role || '');
    const departmentVal = departmentSelect ? departmentSelect.value : (user.department || '');
    setStatus('Preparing QR payload...');
    const payload = { id: uid, name, role: roleVal, department: departmentVal, createdAt: new Date().toISOString() };
    qrcodePreview.innerHTML = '';
    const pre = document.createElement('pre');
    pre.textContent = JSON.stringify(payload, null, 2);
    qrcodePreview.appendChild(pre);
    setStatus('QR payload prepared (preview shown). Use form submit to create real QR.');
  });
}

// Download / Print handlers preserved (if those buttons exist)
if (downloadBtn) {
  downloadBtn.addEventListener('click', () => {
    const qr = window.__lastQR;
    if (!qr) return alert('Generate first');
    const a = document.createElement('a');
    a.href = qr.dataURI;
    a.download = `${qr.id}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
}
if (printBtn) {
  printBtn.addEventListener('click', () => {
    const qr = window.__lastQR;
    if (!qr) return alert('Generate first');
    const w = window.open('', '_blank');
    w.document.write('<html><head><title>Print QR</title></head><body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;">');
    w.document.write(`<div style="text-align:center"><h3>${qr.name}</h3><img src="${qr.dataURI}" style="width:300px;height:300px"/><div class="muted">${qr.id}</div></div>`);
    w.document.write('</body></html>');
    w.document.close();
    w.focus();
    setTimeout(() => { w.print(); }, 400);
  });
}

// -------------------- Scanner code --------------------

export async function initializeGenerator() {
  await loadUsersDropdown();
  // If the page had existing fields which expect a name->role mapping, ensure role is filled if employeeSelect already set.
  if (employeeSelect && employeeSelect.value) {
    const u = usersMap.get(employeeSelect.value);
    if (u && roleField) roleField.value = u.role || '';
    if (u && departmentSelect) departmentSelect.value = u.department || '';
  }
}

export function initializeScanner() {
}
