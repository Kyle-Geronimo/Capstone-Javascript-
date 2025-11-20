import { auth, db } from './firebase-config.js'; 
import {
  collection,
  getDocs,
  query,
  orderBy,
  doc,
  updateDoc,
  getDoc,
  where,
  addDoc,
  serverTimestamp
} from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js';
import { evaluateForUser } from './payroll-utils.js';

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
const nameField = document.getElementById('nameField') || document.getElementById('name');

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
  createForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const uid = employeeSelect.value || null;
    const name = uid ? (usersMap.get(uid)?.username || '') : (nameField?.value || '');
    const roleVal = roleField?.value || '';
    const deptVal = departmentSelect?.value || '';
    const shiftVal = shiftSelect?.value || '';

    if (!auth.currentUser) { alert('Please sign in first'); return; }
    const token = await auth.currentUser.getIdToken(true);
    const payload = { id: uid, name, role: roleVal, department: deptVal, shift: shiftVal };

    // Preflight: check server health to provide clearer error when backend is down
    try {
      const health = await fetch(`${API_BASE}/health`, { method: 'GET' });
      if (!health.ok) throw new Error('Server health check failed');
    } catch (netErr) {
      console.error('API health check failed', netErr);
      setStatus('Unable to reach backend at ' + API_BASE + '. Start the server (run `npm start` in the project folder).', false);
      return;
    }

    let res, j;
    try {
      res = await fetch(`${API_BASE}/api/generateQR`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify(payload)
      });
      j = await res.json();
    } catch (fetchErr) {
      console.error('generateQR fetch failed', fetchErr);
      setStatus('Failed to contact QR generation server. See console.', false);
      return;
    }
    if (res.ok && j.qrDataURI) {
      qrPreview.innerHTML = `<img src="${j.qrDataURI}" alt="QR">`;
      try {
        if (j.id) await updateDoc(doc(db, 'users', j.id), { department: deptVal || null, shift: shiftVal || null });
      } catch (err) { console.warn('local update doc failed', err); }
      setStatus('QR created and assigned.');
      await loadUsersDropdown();
    } else {
      console.error('generateQR failed', j);
      setStatus('Failed to generate QR. See console.', false);
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
  // --- Scanner controls & logic (initialize event handlers) ---
  let currentMode = 'in'; // 'in' or 'out'
  let html5Qrcode = null;
  let currentCameraId = null;

  function setModeVisuals() {
    const tin = document.getElementById('modeTimeIn');
    const tout = document.getElementById('modeTimeOut');
    if (tin) tin.classList.toggle('active', currentMode === 'in');
    if (tout) tout.classList.toggle('active', currentMode === 'out');
  }
  document.getElementById('modeTimeIn')?.addEventListener('click', () => { currentMode = 'in'; setModeVisuals(); });
  document.getElementById('modeTimeOut')?.addEventListener('click', () => { currentMode = 'out'; setModeVisuals(); });

  async function listCamerasToSelect() {
    try {
      // Primary: try Html5Qrcode helper which may internally request camera access
      let devices = [];
      try {
        devices = await Html5Qrcode.getCameras();
      } catch (hErr) {
        console.warn('Html5Qrcode.getCameras failed, will try navigator.mediaDevices fallback', hErr);
        // Continue to fallback below
      }

      // Fallback: try to use navigator.mediaDevices.enumerateDevices.
      if ((!devices || devices.length === 0) && navigator && navigator.mediaDevices && typeof navigator.mediaDevices.enumerateDevices === 'function') {
        try {
          // Trigger a permission prompt if we don't already have access by briefly requesting a stream.
          if (navigator.mediaDevices.getUserMedia) {
            try {
              const stream = await navigator.mediaDevices.getUserMedia({ video: true });
              // Immediately stop tracks to release camera
              stream.getTracks().forEach(t => t.stop());
            } catch (permErr) {
              // permission denied or not available — we'll still try enumerateDevices which may reveal labels only when granted
              console.warn('getUserMedia prompt failed or denied', permErr);
            }
          }

          const list = await navigator.mediaDevices.enumerateDevices();
          devices = list.filter(d => d.kind === 'videoinput').map(d => ({ id: d.deviceId, label: d.label }));
        } catch (enumErr) {
          console.error('enumerateDevices fallback failed', enumErr);
        }
      }

      const sel = document.getElementById('cameraSelect');
      if (!sel) return;
      sel.innerHTML = '';
      if (!devices || devices.length === 0) {
        sel.innerHTML = '<option>No cameras</option>';
        addStatus('No cameras found. Ensure your browser allows camera access and no other app is using the camera.', false);
        return;
      }
      devices.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.id;
        opt.textContent = d.label || d.id || 'Camera';
        sel.appendChild(opt);
      });
      currentCameraId = devices[0].id;
      sel.value = currentCameraId;
      addStatus(`${devices.length} camera(s) found`);
    } catch (err) {
      console.error('listCameras err', err);
      // Provide a helpful message to the user explaining likely causes
      const msg = (err && err.name === 'NotReadableError') ? 'Camera not readable — it may be in use by another application.' : 'Could not enumerate cameras. Check permissions and that no other app is using the camera.';
      addStatus(msg, false);
    }
  }

  document.getElementById('cameraSelect')?.addEventListener('change', (e) => currentCameraId = e.target.value);

  async function startCameraPreview() {
    if (!currentCameraId) { addStatus('Select camera first', false); return; }
    if (html5Qrcode) return addStatus('Camera already started');
    html5Qrcode = new Html5Qrcode('cameraPreview');
    try {
      await html5Qrcode.start(currentCameraId, { fps: 10, qrbox: 300 }, onScanSuccess, onScanFailure);
      addStatus('Camera started');
    } catch (err) {
      console.error('start error', err);
      addStatus('Camera start failed: ' + (err.message || err), false);
    }
  }
  document.getElementById('startCamera')?.addEventListener('click', startCameraPreview);

  async function stopCameraPreview() {
    if (!html5Qrcode) return addStatus('Scanner not running', false);
    try {
      await html5Qrcode.stop();
      html5Qrcode.clear();
      html5Qrcode = null;
      addStatus('Camera stopped');
    } catch (err) {
      console.error('stop error', err);
      addStatus('Failed to stop camera', false);
    }
  }
  document.getElementById('stopCamera')?.addEventListener('click', stopCameraPreview);

  document.getElementById('retryCameras')?.addEventListener('click', async () => {
    await listCamerasToSelect();
    addStatus('Retried camera enumeration');
  });

  document.getElementById('uploadQrImage')?.addEventListener('change', async (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    try {
      // Support multiple html5-qrcode builds: prefer scanFileV2, fall back to scanFile.
      let scanResult = null;
      if (Html5Qrcode && typeof Html5Qrcode.scanFileV2 === 'function') {
        scanResult = await Html5Qrcode.scanFileV2(file, {});
      } else if (Html5Qrcode && typeof Html5Qrcode.scanFile === 'function') {
        // older builds may expose scanFile which returns decoded text or an object
        scanResult = await Html5Qrcode.scanFile(file, {});
      } else {
        throw new Error('Html5Qrcode scanFile API not available in this build');
      }

      // Normalize result to decodedText string (support different return shapes)
      let decodedText = null;
      if (!scanResult) decodedText = null;
      else if (typeof scanResult === 'string') decodedText = scanResult;
      else if (Array.isArray(scanResult) && scanResult.length > 0) {
        // some versions return an array of results
        decodedText = scanResult[0].decodedText || scanResult[0].text || null;
      } else if (scanResult.decodedText) decodedText = scanResult.decodedText;
      else if (scanResult.text) decodedText = scanResult.text;

      if (!decodedText) return addStatus('No QR found in image', false);
      await processDecodedText(decodedText);
    } catch (err) {
      console.error('scanFile err', err);
      addStatus('Failed to scan image', false);
    }
  });

  function onScanFailure(error) {
    // optional per-frame failure logs (do not spam)
  }
  async function onScanSuccess(decodedText, decodedResult) {
    try {
      let payload;
      try { payload = JSON.parse(decodedText); } catch(e) { payload = { id: decodedText }; }
      await processDecodedText(payload);
    } catch (err) {
      console.error('onScanSuccess err', err);
      addStatus('Error processing QR', false);
    }
  }

  async function processDecodedText(payload) {
    const id = payload.id || payload.qrValue || payload.value || null;
    let userDoc = null;
    if (id) {
      const uref = doc(db, 'users', id);
      const usnap = await getDoc(uref);
      if (usnap.exists()) userDoc = { id: usnap.id, ...(usnap.data()||{}) };
    }
    if (!userDoc && payload.qrValue) {
      const q = query(collection(db, 'users'), where('qrValue','==', payload.qrValue));
      const snaps = await getDocs(q);
      if (!snaps.empty) { const d = snaps.docs[0]; userDoc = { id: d.id, ...(d.data()||{}) }; }
    }
    if (!userDoc) { addStatus('QR not linked to user', false); return; }

    const now = new Date();
    const evalRes = evaluateForUser({ shift: userDoc.shift || 'morning' }, now);

    const record = {
      userId: userDoc.id,
      username: userDoc.username || userDoc.email || null,
      mode: currentMode === 'in' ? 'time-in' : 'time-out',
      recordedTime: evalRes.recordedTime.toISOString(),
      rawTime: now.toISOString(),
      status: evalRes.status,
      minutesLate: evalRes.minutesLate,
      shift: userDoc.shift || null,
      createdAt: serverTimestamp()
    };
    await addDoc(collection(db, 'attendance'), record);

    addStatus(`Recorded ${record.mode} for ${record.username || record.userId} — ${record.status}`);
    addDebug('Saved attendance: ' + JSON.stringify(record));
  }

  // initial camera enumeration
  listCamerasToSelect().catch(e => console.warn('camera list init failed', e));
}

// Helper small UI functions (used by scanner)
function addStatus(txt, ok = true) {
  const el = document.getElementById('scannerStatusLog');
  if (!el) return;
  const d = document.createElement('div');
  d.textContent = `${new Date().toLocaleTimeString()} — ${txt}`;
  d.style.color = ok ? '#0a0' : '#a00';
  el.prepend(d);
}
function addDebug(txt) {
  const el = document.getElementById('scannerDebugLog');
  if (!el) return;
  const d = document.createElement('div');
  d.textContent = `${new Date().toISOString()} ${txt}`;
  el.prepend(d);
}
