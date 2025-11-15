// Ensure we can get the signed-in user's ID token for server auth
import { auth } from './firebase-config.js';

// API base (matches pattern used in admin.js). Allows running the frontend on a static server.
const API_BASE = (window.API_BASE && window.API_BASE.replace(/\/$/, '')) || 'http://localhost:3000';

// ==================== SCANNER FUNCTIONS ====================

export function initializeScanner() {
    // Use status-scanner if available (generator page), otherwise use status (scanner page)
    const statusEl = document.getElementById('status-scanner') || document.getElementById('status');
    const debugEl = document.getElementById('debug');
    const cameraSelect = document.getElementById('cameraList');
    const startBtn = document.getElementById('startBtn');
    const retryBtn = document.getElementById('retryBtn');
    const stopBtn = document.getElementById('stopBtn');
    const filePicker = document.getElementById('filePicker');
    const scanFileBtn = document.getElementById('scanFileBtn');
    const actionSelect = document.getElementById('action');
    const readerId = 'reader';

    function dbg(msg){
        const prefix = (new Date()).toLocaleTimeString() + '  ';
        try { debugEl.textContent = prefix + msg + '\n' + debugEl.textContent; } catch(e){ /* ignore UI errors */ }
        console.log(msg);
    }

    function setStatus(msg, ok=true){
        statusEl.textContent = 'Status: ' + msg;
        statusEl.className = ok ? 'utility-status success' : 'utility-status error';
    }

    if (typeof Html5Qrcode === 'undefined') {
        setStatus('html5-qrcode library not loaded. Copy minified file to vendor/html5-qrcode.min.js', false);
        dbg('Html5Qrcode is not defined. Place the file: node_modules/html5-qrcode/html5-qrcode.min.js -> vendor/html5-qrcode.min.js');
        console.warn('Html5Qrcode not loaded — check if a browser extension (adblock/privacy) blocked the CDN script.');
        // Do not throw — exit gracefully so page remains usable and we can retry later.
        return;
    }

    let html5QrCode = null;
    let currentCameraId = null;
    const COOLDOWN_MS = 9000; // per-id
    const GLOBAL_PAUSE_MS = 1500;
    const lastSeen = {}; // map id -> timestamp

    async function enumerateCams(){
        try{
            dbg('Enumerating cameras...');
            const cams = await Html5Qrcode.getCameras();
            cameraSelect.innerHTML = '';
            if(!cams || cams.length===0){
                cameraSelect.innerHTML = '<option value="">(no cameras)</option>';
                setStatus('No cameras found (attempting fallbacks)...', false);
                dbg('Html5Qrcode.getCameras returned none. Attempting navigator.mediaDevices.enumerateDevices and permission prompts.');
                // Try enumerateDevices as a fallback to at least show raw device info
                try {
                    const devs = await navigator.mediaDevices.enumerateDevices();
                    dbg('enumerateDevices result: ' + JSON.stringify(devs.map(d=>({kind:d.kind,label:d.label,id:d.deviceId})), null, 2));
                    const videoInputs = devs.filter(d=>d.kind === 'videoinput');
                    if (videoInputs.length > 0) {
                        videoInputs.forEach((d, idx) => {
                            const opt = document.createElement('option');
                            opt.value = d.deviceId || '';
                            opt.text = d.label || ('Camera ' + (idx+1));
                            cameraSelect.appendChild(opt);
                        });
                        currentCameraId = cameraSelect.options[0].value;
                        cameraSelect.value = currentCameraId;
                        setStatus('Cameras detected via enumerateDevices. You may need to grant permission.', true);
                        dbg('Cameras populated via enumerateDevices, labels may be empty until permission granted.');
                        return;
                    }
                } catch(e2){ dbg('enumerateDevices fallback failed: ' + e2); }

                // If no devices listed, try prompting for permission so labels become available
                try {
                    dbg('Requesting camera permission (temporary getUserMedia) to enable device labels...');
                    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
                    stream.getTracks().forEach(t => t.stop());
                    dbg('Permission granted; re-enumerating cameras...');
                    return await enumerateCams();
                } catch (permErr) {
                    dbg('Permission prompt failed or denied: ' + permErr);
                    setStatus('Camera permission denied or unavailable. Check browser site permissions and allow camera access.', false);
                    return;
                }
            }
            cams.forEach((c, idx) => {
                const opt = document.createElement('option');
                opt.value = c.id;
                opt.text = c.label || ('Camera ' + (idx+1));
                cameraSelect.appendChild(opt);
            });
            currentCameraId = cams[0].id;
            cameraSelect.value = currentCameraId;
            setStatus('Cameras ready. Choose and Start.');
            dbg('Cameras found: ' + cams.map(x=>x.label||x.id).join(', '));
        }catch(err){
            dbg('Error enumerating cameras: ' + (err && err.stack ? err.stack : err));
            setStatus('Error enumerating cameras (see debug)', false);
            try {
                const devs = await navigator.mediaDevices.enumerateDevices();
                dbg('enumerateDevices fallback: ' + JSON.stringify(devs.map(d=>({kind:d.kind,label:d.label,id:d.deviceId})), null, 2));
            } catch (e2) {
                dbg('enumerateDevices fallback failed: ' + e2);
            }
        }
    }

    async function checkPermissionState(){
        try{
            if (navigator.permissions && navigator.permissions.query) {
                const p = await navigator.permissions.query({ name: 'camera' });
                dbg('Camera permission state: ' + p.state);
                return p.state;
            }
        }catch(e){ dbg('permissions.query not supported: ' + e); }
        return null;
    }

    function pauseIfSupported(){
        try { if (html5QrCode && typeof html5QrCode.pause === 'function') html5QrCode.pause(); } catch(e){ dbg('pause error: '+e); }
    }

    function resumeIfSupported(){
        try { if (html5QrCode && typeof html5QrCode.resume === 'function') html5QrCode.resume(); } catch(e){ dbg('resume error: '+e); }
    }

    async function startCamera(deviceId){
        if(!deviceId){ setStatus('No camera selected', false); return; }
        if(!html5QrCode) html5QrCode = new Html5Qrcode(readerId);
        setStatus('Starting camera...');
        try {
            await html5QrCode.start(
                { deviceId: { exact: deviceId } },
                { fps: 10, qrbox: { width: 300, height: 200 } },
                onScanSuccess,
                onScanError
            );
            setStatus('Camera started - scanning...');
            startBtn.disabled = true; stopBtn.disabled = false;
            dbg('Camera started: ' + deviceId);
        } catch (e) {
            dbg('Start camera failed with deviceId ' + deviceId + ': ' + e);
            // Try facingMode fallback (some browsers prefer facingMode over deviceId)
            try {
                dbg('Attempting facingMode fallback...');
                await html5QrCode.start(
                    { facingMode: 'environment' },
                    { fps: 10, qrbox: { width: 300, height: 200 } },
                    onScanSuccess,
                    onScanError
                );
                setStatus('Camera started (facingMode) - scanning...');
                startBtn.disabled = true; stopBtn.disabled = false;
                dbg('Camera started with facingMode fallback');
                return;
            } catch (e2) {
                dbg('FacingMode fallback also failed: ' + e2);
                setStatus('Start camera failed: ' + e + ' / ' + e2, false);
            }
        }
    }

    async function stopCamera(){
        if(!html5QrCode) return;
        try {
            await html5QrCode.stop();
            setStatus('Camera stopped.');
            startBtn.disabled = false; stopBtn.disabled = true;
            dbg('Camera stopped');
        } catch (e) {
            dbg('Stop error: ' + e);
            setStatus('Stop error: ' + e, false);
        }
    }

    function onScanError(err){
        // minor decode errors ignored
    }

    async function onScanSuccess(decodedText, decodedResult){
        dbg('Decoded: ' + decodedText);
        let payload;
        try { payload = JSON.parse(decodedText); } catch(e){ setStatus('Invalid QR payload (not JSON)', false); dbg('Invalid QR: '+e); return; }
        if (!payload.id){ setStatus('QR missing id field', false); dbg('QR missing id'); return; }

        const now = Date.now();
        if (lastSeen[payload.id] && (now - lastSeen[payload.id] < COOLDOWN_MS)){
            dbg('Ignored duplicate scan for ' + payload.id);
            setStatus('Duplicate ignored', false);
            return;
        }
        lastSeen[payload.id] = now;
        // Stop the camera immediately now that we have a successful scan
        try { await stopCamera(); } catch(e){ dbg('stopCamera error: ' + e); }

        setStatus('Sending check to server...');
        try {
            const token = auth.currentUser ? await auth.currentUser.getIdToken(true).catch(e=>{ console.error('getIdToken failed', e); return null; }) : null;
            if (!token) {
                setStatus('Not signed in as admin. Please sign in to use the scanner.', false);
                dbg('Abort /api/check: no ID token available');
                lastSeen[payload.id] = 0; // allow retry later
                setTimeout(()=> resumeIfSupported(), GLOBAL_PAUSE_MS);
                return;
            }

            const res = await fetch(`${API_BASE}/api/check`, {
                method: 'POST',
                headers: {'Content-Type':'application/json', 'Authorization': 'Bearer ' + token},
                body: JSON.stringify({ id: payload.id, action: actionSelect.value })
            });
            const text = await res.text();
            try {
                const j = JSON.parse(text);
                if (j.ok){
                    setStatus(`OK: ${payload.id} ${j.event.action} at ${new Date(j.event.time).toLocaleString()}`);
                    dbg('Server ok: ' + JSON.stringify(j));
                } else {
                    setStatus('Server: ' + (j.error || 'unknown'), false);
                    dbg('Server error: ' + JSON.stringify(j));
                }
            } catch (ex) {
                console.error('Non-JSON response for /api/check:', text);
                setStatus('Network error: see console (non-JSON response)', false);
                dbg('Raw response: ' + text);
            }
        } catch (err){
            setStatus('Network error: ' + err, false);
            dbg('Fetch error: ' + err);
            lastSeen[payload.id] = 0; // allow retry
        }

        // Camera stopped after successful scan; do not auto-resume here.
    }

    async function scanImageFile(){
        const file = filePicker.files[0];
        if (!file){ setStatus('No file selected', false); return; }
        setStatus('Scanning image file...');
        dbg('Scanning file: ' + file.name);
        try {
            if(!html5QrCode) html5QrCode = new Html5Qrcode(readerId);
            if (typeof html5QrCode.scanFileV2 === 'function'){
                const result = await html5QrCode.scanFileV2(file, true);
                dbg('scanFileV2 result: ' + JSON.stringify(result));
                onScanSuccess(result.decodedText, result);
                return;
            }
            if (typeof Html5Qrcode.scanFile === 'function'){
                const result = await Html5Qrcode.scanFile(file, true);
                dbg('scanFile result: ' + JSON.stringify(result));
                onScanSuccess(result.decodedText, result);
                return;
            }
            setStatus('Image-scan API not available in this build', false);
            dbg('No scanFile API available');
        } catch (err){
            dbg('scanFile error: ' + err);
            setStatus('Image scan failed: ' + err, false);
        }
    }

    startBtn.addEventListener('click', async ()=> {
        try {
            // If no cameras listed, request permission to prompt the browser and re-enumerate
            if (!cameraSelect.options || cameraSelect.options.length === 0 || !cameraSelect.value) {
                setStatus('Requesting camera permission...');
                try {
                    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
                    // immediately stop tracks - we just wanted to prompt for permission so labels become available
                    stream.getTracks().forEach(t => t.stop());
                    dbg('Camera permission granted via getUserMedia');
                } catch (permErr) {
                    dbg('User denied camera permission or getUserMedia failed: ' + permErr);
                    setStatus('Camera permission denied or not available', false);
                    return;
                }

                // Re-enumerate after permission
                await enumerateCams();
            }

            currentCameraId = cameraSelect.value || currentCameraId;
            startCamera(currentCameraId);
        } catch (err) {
            dbg('Start button handler error: ' + err);
            setStatus('Failed to start camera: ' + err, false);
        }
    });
    stopBtn.addEventListener('click', stopCamera);
    scanFileBtn.addEventListener('click', scanImageFile);
    if (retryBtn) {
        retryBtn.addEventListener('click', async () => {
            try {
                setStatus('Retrying camera detection...');
                await checkPermissionState();
                // Try a quick permission prompt to allow labels to appear
                try {
                    const s = await navigator.mediaDevices.getUserMedia({ video: true });
                    s.getTracks().forEach(t=>t.stop());
                    dbg('Permission granted on retry');
                } catch (e) {
                    dbg('Retry getUserMedia permission prompt failed: ' + e);
                }
                await enumerateCams();
            } catch (err) {
                dbg('Retry button error: ' + err);
                setStatus('Retry failed: ' + err, false);
            }
        });
    }
    
    // Update file name display when file is selected
    filePicker.addEventListener('change', (e) => {
        const fileNameDisplay = document.getElementById('fileNameDisplay');
        if (fileNameDisplay && e.target.files && e.target.files[0]) {
            fileNameDisplay.textContent = e.target.files[0].name;
        }
    });
    
    cameraSelect.addEventListener('change', (e)=> { currentCameraId = e.target.value; dbg('Camera selected'); });

    (async () => {
        try {
            dbg('Testing navigator.mediaDevices.getUserMedia...');
            await navigator.mediaDevices.getUserMedia({ video:true }).then(s => { s.getTracks().forEach(t=>t.stop()); dbg('Native getUserMedia OK'); });
        } catch (err){
            dbg('Native getUserMedia failed: ' + err);
            setStatus('Browser prevented camera access or none available', false);
        }
        await enumerateCams();
    })();
}

// ==================== GENERATOR FUNCTIONS ====================

export function initializeGenerator() {
    const form = document.getElementById('createForm');
    const resultArea = document.getElementById('resultArea');
    const info = document.getElementById('info');
    const qrPreview = document.getElementById('qrPreview');
    const status = document.getElementById('status');
    const downloadBtn = document.getElementById('downloadBtn');
    const printBtn = document.getElementById('printBtn');

    function setStatus(msg, ok=true){
        status.textContent = msg;
        status.className = ok ? 'utility-status success' : 'utility-status error';
        status.style.display = 'block';
    }

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = document.getElementById('name').value.trim();
        const role = document.getElementById('role').value.trim();
        const rateVal = document.getElementById('rate').value;
        if (!name) { alert('Enter name'); return; }
        setStatus('Creating employee...');
        try {
            const token = auth.currentUser ? await auth.currentUser.getIdToken(true).catch(e=>{ console.error('getIdToken failed', e); return null; }) : null;
            if (!token) {
                setStatus('Not signed in as admin. Please sign in to create employees.', false);
                console.error('Cannot call /api/employee: no ID token available');
                return;
            }

            const res = await fetch(`${API_BASE}/api/employee`, {
                method: 'POST',
                headers: {'Content-Type':'application/json', 'Authorization': 'Bearer ' + token},
                body: JSON.stringify({ name, role, rate: rateVal })
            });

            const text = await res.text();
            try {
                const j = JSON.parse(text);
                if (j.error) {
                    setStatus('Server error: ' + j.error, false);
                    console.error('/api/employee returned error JSON:', j);
                    return;
                }
                // show info & qr
                resultArea.style.display = 'block';
                info.innerHTML = `<div><strong>${j.name}</strong> <span class="muted">${j.id}</span></div><div class="muted">Role: ${role||'—'}</div>`;
                qrPreview.innerHTML = `<img class="generator-qr-image" id="qrImg" src="${j.qrDataURI}" alt="QR for ${j.name}" />`;
                setStatus('Employee created. Right-click QR to save, or use Download button.', true);
                // store current data for download
                window.__lastQR = { id: j.id, name: j.name, dataURI: j.qrDataURI };
            } catch (ex) {
                console.error('Non-JSON response for /api/employee:', text);
                alert('Server returned a non-JSON response. See console for details.');
                setStatus('Network error: non-JSON response (see console)', false);
            }
        } catch (err) {
            setStatus('Network error: ' + err, false);
        }
    });

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

    printBtn.addEventListener('click', () => {
        const qr = window.__lastQR;
        if (!qr) return alert('Generate first');
        const w = window.open('', '_blank');
        w.document.write('<html><head><title>Print QR</title></head><body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;">');
        w.document.write(`<div style="text-align:center"><h3>${qr.name}</h3><img src="${qr.dataURI}" style="width:300px;height:300px"/><div class="muted">${qr.id}</div></div>`);
        w.document.write('</body></html>');
        w.document.close();
        w.focus();
        setTimeout(()=>{ w.print(); }, 400);
    });
}
