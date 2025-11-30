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
  setDoc,
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

// Lightweight toast helper for QR dashboard notifications
function showQrToast(message, type = 'success') {
  try {
    let container = document.getElementById('qr-toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'qr-toast-container';
      container.style.position = 'fixed';
      container.style.top = '1.25rem';
      container.style.right = '1.25rem';
      container.style.zIndex = '9999';
      container.style.display = 'flex';
      container.style.flexDirection = 'column';
      container.style.gap = '0.5rem';
      document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.textContent = message;
    toast.style.minWidth = '220px';
    toast.style.maxWidth = '320px';
    toast.style.padding = '0.6rem 0.9rem';
    toast.style.borderRadius = '0.5rem';
    toast.style.boxShadow = '0 10px 25px rgba(15,23,42,0.25)';
    toast.style.fontSize = '0.9rem';
    toast.style.color = '#0f172a';
    toast.style.background = type === 'success'
      ? 'linear-gradient(135deg, #a7f3d0, #6ee7b7)'
      : 'linear-gradient(135deg, #fecaca, #fca5a5)';

    container.appendChild(toast);

    setTimeout(() => {
      toast.style.transition = 'opacity 200ms ease, transform 200ms ease';
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(-6px)';
      setTimeout(() => toast.remove(), 220);
    }, 2200);
  } catch (_) {
    // non-fatal: ignore toast errors
  }
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
      // Cache all users locally and always add to dropdown so QR can be regenerated unlimited times
      usersMap.set(uid, { uid, ...data, shift: data.shift || '' });
      const opt = document.createElement('option');
      opt.value = uid;
      opt.textContent = label;
      employeeSelect.appendChild(opt);
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

    // Preflight: try a best-effort health check, but do NOT block QR generation if it fails.
    try {
      const health = await fetch(`${API_BASE}/health`, { method: 'GET' });
      if (!health.ok) {
        let bodyText = '';
        try { bodyText = await health.text(); } catch (_) {}
        console.warn('Health check failed (non-blocking)', health.status, bodyText);
        setStatus(`Warning: health check failed (HTTP ${health.status}). Attempting QR generation anyway...`, false);
      }
    } catch (netErr) {
      console.warn('API health check failed (non-blocking)', netErr);
      setStatus('Warning: could not reach /health endpoint. Attempting QR generation anyway...', false);
    }

    let res, j;
    try {
      res = await fetch(`${API_BASE}/api/generateQR`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify(payload)
      });
      // try to parse JSON, but tolerate non‑JSON bodies when there is an error
      try {
        j = await res.json();
      } catch (_) {
        j = null;
      }
    } catch (fetchErr) {
      console.error('generateQR fetch failed', fetchErr);
      setStatus('Failed to contact QR generation server. See console.', false);
      return;
    }

    if (res.ok && j && j.qrDataURI) {
      qrPreview.innerHTML = `<img src="${j.qrDataURI}" alt="QR">`;

      // Persist latest QR data on the user so other parts of the app (like profile) can reuse it
      try {
        if (j.id) {
          await updateDoc(doc(db, 'users', j.id), {
            department: deptVal || null,
            shift: shiftVal || null,
            qrDataURI: j.qrDataURI
          });
        }
      } catch (err) {
        console.warn('local update doc failed', err);
      }

      // Expose the latest QR globally so Download/Print buttons use the most recent image
      window.__lastQR = {
        id: j.id || uid || name,
        name: name || 'Employee',
        dataURI: j.qrDataURI
      };

      setStatus('QR successfully created.');
      showQrToast('QR successfully created.');
      // Reload dropdown to refresh any derived info, but users now always remain selectable
      await loadUsersDropdown();
    } else {
      const statusCode = res.status;
      const errMsg = (j && (j.error || j.message || j.details)) || 'Unknown error from backend.';
      console.error('generateQR failed', { status: statusCode, body: j });
      setStatus(`Failed to generate QR (HTTP ${statusCode}): ${errMsg}`, false);
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
  let scanRequested = false;
  let scanRequestTimeoutId = null;
  // Local session cache to prevent rapid duplicate scans even if Firestore read fails
  // Key: `${userId}|${yyyy-mm-dd}` -> { hasTimeIn, hasTimeOut }
  const sessionAttendanceState = new Map();

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
      // Reset any pending scan request and animation when camera stops
      scanRequested = false;
      if (scanRequestTimeoutId) {
        clearTimeout(scanRequestTimeoutId);
        scanRequestTimeoutId = null;
      }
      const preview = document.getElementById('cameraPreview');
      if (preview) preview.classList.remove('scan-anim');
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

  // Snap-style scan: only process a QR after admin clicks Scan QR.
  const scanBtn = document.getElementById('scanQrBtn');
  if (scanBtn) {
    scanBtn.addEventListener('click', () => {
      if (!html5Qrcode) {
        addStatus('Start the camera first before scanning.', false);
        return;
      }

      // Mark that the next successful detection should be processed.
      scanRequested = true;
      addStatus('Scanning for QR... hold steady.', true);
      addDebug('Scan requested by admin click');

      const preview = document.getElementById('cameraPreview');
      if (preview) preview.classList.add('scan-anim');

      // Clear any previous timeout and set a new one so a single request
      // does not stay active forever if no QR is detected.
      if (scanRequestTimeoutId) {
        clearTimeout(scanRequestTimeoutId);
        scanRequestTimeoutId = null;
      }
      scanRequestTimeoutId = setTimeout(() => {
        if (!scanRequested) return;
        scanRequested = false;
        const pv = document.getElementById('cameraPreview');
        if (pv) pv.classList.remove('scan-anim');
        addStatus('No QR detected for this scan attempt.', false);
      }, 7000);
    });
  }

  document.getElementById('uploadQrImage')?.addEventListener('change', async (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;

    // Enforce JPG/PNG only
    const name = file.name || '';
    const lower = name.toLowerCase();
    if (!lower.endsWith('.jpg') && !lower.endsWith('.jpeg') && !lower.endsWith('.png')) {
      addStatus('Only .jpg and .png files are supported for QR image upload.', false);
      return;
    }

    try {
      let decodedText = null;

      // Preferred: use Html5Qrcode static file scanning APIs when available
      if (typeof Html5Qrcode !== 'undefined' && typeof Html5Qrcode.scanFileV2 === 'function') {
        const scanResult = await Html5Qrcode.scanFileV2(file, {});
        if (scanResult) {
          if (typeof scanResult === 'string') decodedText = scanResult;
          else if (Array.isArray(scanResult) && scanResult.length > 0) decodedText = scanResult[0].decodedText || scanResult[0].text || null;
          else if (scanResult.decodedText) decodedText = scanResult.decodedText;
          else if (scanResult.text) decodedText = scanResult.text;
        }
      } else if (typeof Html5Qrcode !== 'undefined' && typeof Html5Qrcode.scanFile === 'function') {
        const scanResult = await Html5Qrcode.scanFile(file, {});
        if (scanResult) {
          if (typeof scanResult === 'string') decodedText = scanResult;
          else if (Array.isArray(scanResult) && scanResult.length > 0) decodedText = scanResult[0].decodedText || scanResult[0].text || null;
          else if (scanResult.decodedText) decodedText = scanResult.decodedText;
          else if (scanResult.text) decodedText = scanResult.text;
        }
      }

      // Fallback: use jsQR if Html5Qrcode does not support file scanning
      if (!decodedText && typeof window.jsQR === 'function') {
        const reader = new FileReader();
        const result = await new Promise((resolve, reject) => {
          reader.onload = () => resolve(reader.result);
          reader.onerror = (e) => reject(e);
          reader.readAsDataURL(file);
        });

        const img = new Image();
        const dataUrl = /** @type {string} */ (result || '');
        await new Promise((resolve, reject) => {
          img.onload = () => resolve(null);
          img.onerror = (e) => reject(e);
          img.src = dataUrl;
        });

        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          addStatus('Unable to create canvas for QR decoding.', false);
          return;
        }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

        const jsqrResult = window.jsQR(imageData.data, imageData.width, imageData.height);
        if (jsqrResult && jsqrResult.data) {
          decodedText = jsqrResult.data;
        }
      }

      if (!decodedText) {
        addStatus('No QR found in image', false);
        return;
      }

      await processDecodedText(decodedText);
    } catch (err) {
      console.error('scanFile err', err);
      addStatus('Failed to scan image', false);
    }
  });

  function onScanFailure(error) {
    // optional per-frame failure logs (do not spam)
  }

  // Show a frozen snapshot overlay and require admin confirmation
  // before actually processing the decoded QR payload.
  function showScanConfirmOverlay(decodedText) {
    try {
      const preview = document.getElementById('cameraPreview');
      if (!preview) {
        addDebug('No cameraPreview element for snapshot overlay; processing QR without snapshot.');
        processDecodedText(decodedText);
        return;
      }

      const video = preview.querySelector('video');
      if (!video || !video.videoWidth || !video.videoHeight) {
        addDebug('No active video element for snapshot; processing QR without snapshot.');
        processDecodedText(decodedText);
        return;
      }

      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        addDebug('Failed to get canvas context for snapshot; processing QR without snapshot.');
        processDecodedText(decodedText);
        return;
      }
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/png');

      const overlay = document.createElement('div');
      overlay.id = 'qr-snapshot-overlay';
      overlay.innerHTML = `
        <div class="qr-snapshot-modal">
          <div class="qr-snapshot-image-wrap">
            <img src="${dataUrl}" alt="QR snapshot" />
          </div>
          <div class="qr-snapshot-actions">
            <button type="button" class="qr-snapshot-cancel">Cancel</button>
            <button type="button" class="qr-snapshot-confirm">Confirm</button>
          </div>
        </div>
      `;

      document.body.appendChild(overlay);

      const btnCancel = overlay.querySelector('.qr-snapshot-cancel');
      const btnConfirm = overlay.querySelector('.qr-snapshot-confirm');

      const cleanup = () => {
        try { overlay.remove(); } catch (_) {}
      };

      if (btnCancel) {
        btnCancel.addEventListener('click', () => {
          addStatus('Scan cancelled. Click Scan QR to try again.', false);
          cleanup();
        });
      }

      if (btnConfirm) {
        btnConfirm.addEventListener('click', async () => {
          cleanup();
          try {
            await processDecodedText(decodedText);
          } catch (err) {
            console.error('onScanSuccess confirm err', err);
            addStatus('Error processing QR', false);
          }
        });
      }
    } catch (err) {
      console.error('showScanConfirmOverlay error', err);
      // If anything goes wrong with the overlay, fall back to direct processing
      processDecodedText(decodedText);
    }
  }

  async function onScanSuccess(decodedText, decodedResult) {
    // Do not process continuous detections unless admin explicitly
    // requested a scan via the Scan QR button.
    if (!scanRequested) {
      addDebug('QR detected but no scan was requested; ignoring frame.');
      return;
    }

    // This detection fulfills the pending request; clear the flag and
    // any visual animation before showing the snapshot.
    scanRequested = false;
    if (scanRequestTimeoutId) {
      clearTimeout(scanRequestTimeoutId);
      scanRequestTimeoutId = null;
    }
    const preview = document.getElementById('cameraPreview');
    if (preview) preview.classList.remove('scan-anim');

    showScanConfirmOverlay(decodedText);
  }

  async function processDecodedText(decodedTextOrPayload) {
    let payload;
    if (typeof decodedTextOrPayload === 'string') {
      try {
        payload = JSON.parse(decodedTextOrPayload);
      } catch (e) {
        payload = { id: decodedTextOrPayload };
      }
    } else {
      payload = decodedTextOrPayload || {};
    }

    const id = payload.id || payload.qrValue || payload.value || null;
    let userDoc = null;

    // 1) Try users collection by document ID (modern flow)
    if (id) {
      try {
        const uref = doc(db, 'users', id);
        const usnap = await getDoc(uref);
        if (usnap.exists()) userDoc = { id: usnap.id, ...(usnap.data() || {}) };
      } catch (e) {
        console.warn('users/id lookup failed', e);
      }
    }

    // 2) Try users collection by qrValue field (covers QRs that encode a separate qrValue)
    if (!userDoc && (payload.qrValue || id)) {
      try {
        const val = payload.qrValue || id;
        const uq = query(collection(db, 'users'), where('qrValue', '==', val));
        const usnaps = await getDocs(uq);
        if (!usnaps.empty) {
          const d = usnaps.docs[0];
          userDoc = { id: d.id, ...(d.data() || {}) };
        }
      } catch (e) {
        console.warn('users qrValue lookup failed', e);
      }
    }

    // 3) Legacy employees collection by document ID
    if (!userDoc && id) {
      try {
        const eref = doc(db, 'employees', id);
        const esnap = await getDoc(eref);
        if (esnap.exists()) {
          const data = esnap.data() || {};
          userDoc = {
            id: esnap.id,
            username: data.name || data.username || null,
            role: data.role || 'employee',
            shift: data.shift || null,
            qrValue: data.qrValue || id
          };
        }
      } catch (e) {
        console.warn('employees/id lookup failed', e);
      }
    }

    // 4) Legacy employees collection by qrValue
    if (!userDoc && (payload.qrValue || id)) {
      try {
        const val = payload.qrValue || id;
        const eq = query(collection(db, 'employees'), where('qrValue', '==', val));
        const esnaps = await getDocs(eq);
        if (!esnaps.empty) {
          const d = esnaps.docs[0];
          const data = d.data() || {};
          userDoc = {
            id: d.id,
            username: data.name || data.username || null,
            role: data.role || 'employee',
            shift: data.shift || null,
            qrValue: data.qrValue || val
          };
        }
      } catch (e) {
        console.warn('employees qrValue lookup failed', e);
      }
    }

    // 5) If, after all lookups, there is still no matching record, treat as invalid QR.
    if (!userDoc) {
      addStatus('invalid qr code!', false);
      addDebug(`Rejected QR: no matching user/employee for payload id=${id || '(none)'}`);
      return;
    }

    // Enforce that only admin or employee roles can be used for attendance.
    const role = (userDoc.role || 'employee').toLowerCase();
    if (role !== 'admin' && role !== 'employee') {
      addStatus('invalid qr code!', false);
      addDebug(`Rejected QR: role "${userDoc.role}" is not permitted for attendance.`);
      return;
    }

    const now = new Date();
    const evalRes = evaluateForUser({ shift: userDoc.shift || 'morning' }, now);

    const dayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    const lastInDate = userDoc.lastTimeInDate || null;
    const lastOutDate = userDoc.lastTimeOutDate || null;

    const mode = currentMode === 'in' ? 'time-in' : 'time-out';

    if (mode === 'time-in' && lastInDate === dayKey) {
      addStatus('This account is already time in for today.', false);
      addDebug(`User ${userDoc.id} blocked by lastTimeInDate=${lastInDate}`);
      return;
    }
    if (mode === 'time-out' && lastOutDate === dayKey) {
      addStatus('This account is already time out for today.', false);
      addDebug(`User ${userDoc.id} blocked by lastTimeOutDate=${lastOutDate}`);
      return;
    }

    // Enforce: at most one time-in and one time-out per user per calendar day
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const startIso = startOfDay.toISOString();
    const endIso = endOfDay.toISOString();

    // --- Fast in-memory guard so multiple scans in the same browser session
    //     do not create duplicates even when Firestore checks fail.
    const sessKey = `${userDoc.id}|${dayKey}`;
    const sess = sessionAttendanceState.get(sessKey) || { hasTimeIn: false, hasTimeOut: false };
    if (mode === 'time-in' && sess.hasTimeIn) {
      addStatus('This account is already time in for today.', false);
      addDebug(`Session-blocked duplicate time-in for ${userDoc.id} on ${dayKey}`);
      return;
    }
    if (mode === 'time-out' && sess.hasTimeOut) {
      addStatus('This account is already time out for today.', false);
      addDebug(`Session-blocked duplicate time-out for ${userDoc.id} on ${dayKey}`);
      return;
    }

    try {
      const todayQ = query(
        collection(db, 'attendance'),
        where('userId', '==', userDoc.id),
        where('rawTime', '>=', startIso),
        where('rawTime', '<', endIso)
      );
      const todaySnap = await getDocs(todayQ);
      let hasTimeIn = false;
      let hasTimeOut = false;
      todaySnap.forEach(d => {
        const m = d.data()?.mode;
        if (m === 'time-in') hasTimeIn = true;
        if (m === 'time-out') hasTimeOut = true;
      });

      if (mode === 'time-in' && hasTimeIn) {
        addStatus('This account is already time in for today.', false);
        addDebug(`Blocked duplicate time-in for user ${userDoc.id} on ${startIso}`);
        // Update session cache to mirror Firestore state
        sessionAttendanceState.set(sessKey, { hasTimeIn: true, hasTimeOut: sess.hasTimeOut || hasTimeOut });
        return;
      }
      if (mode === 'time-out' && hasTimeOut) {
        addStatus('This account is already time out for today.', false);
        addDebug(`Blocked duplicate time-out for user ${userDoc.id} on ${startIso}`);
        // Update session cache to mirror Firestore state
        sessionAttendanceState.set(sessKey, { hasTimeIn: sess.hasTimeIn || hasTimeIn, hasTimeOut: true });
        return;
      }
    } catch (err) {
      console.error('Attendance check failed', err);
      addDebug('Attendance check failed: ' + (err.message || String(err)));
      // If the check fails, we still proceed with recording to avoid blocking all scans.
    }

    const record = {
      userId: userDoc.id,
      username: userDoc.username || userDoc.email || null,
      email: userDoc.email || null,
      mode,
      recordedTime: evalRes.recordedTime.toISOString(),
      rawTime: now.toISOString(),
      status: evalRes.status,
      minutesLate: evalRes.minutesLate,
      shift: userDoc.shift || null,
      createdAt: serverTimestamp()
    };
    await addDoc(collection(db, 'attendance'), record);

    // Persist per-day flags back to the user document so duplicates are blocked across refreshes
    try {
      const uref = doc(db, 'users', userDoc.id);
      if (mode === 'time-in') {
        await setDoc(uref, { lastTimeInDate: dayKey }, { merge: true });
      } else if (mode === 'time-out') {
        await setDoc(uref, { lastTimeOutDate: dayKey }, { merge: true });
      }
    } catch (e) {
      console.warn('Failed to update lastTimeIn/OutDate on user', e);
    }

    // Mark this user as having time-in / time-out for the day in the session cache
    const updated = {
      hasTimeIn: sess.hasTimeIn || mode === 'time-in',
      hasTimeOut: sess.hasTimeOut || mode === 'time-out'
    };
    sessionAttendanceState.set(sessKey, updated);

    addStatus(`Recorded ${record.mode} for ${record.username || record.userId} — ${record.status}`);
    addDebug('Saved attendance: ' + JSON.stringify(record));

    // Note: we keep the camera running so the admin can scan multiple
    // unique QRs (and time-in / time-out events) in a single session
    // without needing to refresh the page. Duplicate protection is still
    // enforced by the attendance checks above.
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
