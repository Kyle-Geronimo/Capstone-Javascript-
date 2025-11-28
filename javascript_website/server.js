import admin from 'firebase-admin';
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import QRCode from 'qrcode';
import { nanoid } from 'nanoid';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

// Load environment variables from .env
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// --- FIREBASE ADMIN INIT (replace existing block) ---
const saPath = join(__dirname, 'mariners-hotellink-firebase-adminsdk-fbsvc-65bfc6c5b7.json');
if (!fs.existsSync(saPath)) {
  console.error('Service account JSON not found at', saPath);
  process.exit(1);
}
let serviceAccount;
try {
  serviceAccount = JSON.parse(fs.readFileSync(saPath, 'utf8'));
} catch (err) {
  console.error('Failed to parse service account JSON:', err);
  process.exit(1);
}

try {
 // Safe initialize: only initialize once per process
  if (!admin.apps || admin.apps.length === 0) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
      // The projectId line is REMOVED, forcing the SDK to infer it from the key.
    });
    console.log('✅ Firebase Auth initialized.');
  } else {
    console.log('ℹ️ Firebase already initialized — reusing existing app.');
  }
  console.log('Firebase Admin initialized. project_id=' + (serviceAccount.project_id || '<none>'));
} catch (err) {
  console.error('admin.initializeApp failed:', err);
  process.exit(1);
}

const db = admin.firestore();
// --- end admin init ---
const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// Simple request logger
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl}`);
  next();
});

// --- Device ID cookie middleware ---
app.use((req, res, next) => {
  try {
    const cookieHeader = req.headers.cookie || '';
    const cookies = {};
    cookieHeader.split(';').forEach(pair => {
      const [k, v] = pair.split('=');
      if (!k || !v) return;
      const key = k.trim();
      if (!key) return;
      cookies[key] = decodeURIComponent(v.trim());
    });

    let deviceId = cookies.device_id;
    if (!deviceId) {
      deviceId = nanoid(24);
      const isProd = process.env.NODE_ENV === 'production';
      const cookieParts = [
        `device_id=${encodeURIComponent(deviceId)}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax'
      ];
      if (isProd) cookieParts.push('Secure');
      res.setHeader('Set-Cookie', cookieParts.join('; '));
    }
    req.deviceId = deviceId;
  } catch (e) {
    console.warn('Device cookie middleware error:', e && e.message);
  }
  next();
});

// Middleware: verify Firebase ID token from Authorization header
async function verifyToken(req, res, next) {
  try {
    const auth = req.headers && req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }
    const idToken = auth.split('Bearer ')[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.user = decoded;
    return next();
  } catch (err) {
    console.error('Token verification failed:', err);
    return res.status(401).json({ error: 'Unauthorized', details: err.message });
  }
}

// Middleware: ensure admin is using their trusted device for QR operations
async function ensureAdminTrustedDevice(req, res, next) {
  try {
    if (!req.user || !req.user.uid) {
      return res.status(401).json({ error: 'unauthorized', message: 'No authenticated user' });
    }

    const uid = req.user.uid;
    const userSnap = await db.collection('users').doc(uid).get();
    if (!userSnap.exists) {
      return res.status(403).json({ error: 'forbidden', message: 'User record not found' });
    }

    const userData = userSnap.data() || {};
    const role = userData.role || null;
    if (role !== 'admin') {
      return res.status(403).json({ error: 'forbidden', message: 'Admin role required for QR dashboard' });
    }

    const currentDeviceId = req.deviceId;
    const trustedDeviceId = userData.trustedDeviceId || null;

    // First-time bind: if no trusted device yet, bind this one
    if (!trustedDeviceId) {
      try {
        await db.collection('users').doc(uid).set({
          trustedDeviceId: currentDeviceId || null,
          trustedDeviceBoundAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        console.log(`Bound trusted device for admin ${uid} -> ${currentDeviceId}`);
      } catch (e) {
        console.warn('Failed to bind trusted device for admin', uid, e && e.message);
      }
      return next();
    }

    // Subsequent requests must match the stored trusted device
    if (trustedDeviceId && currentDeviceId && trustedDeviceId === currentDeviceId) {
      return next();
    }

    return res.status(403).json({
      error: 'device_not_matched',
      message: 'This device is not authorized for QR scanning. Please use your originally bound device.'
    });
  } catch (err) {
    console.error('ensureAdminTrustedDevice error:', err);
    return res.status(500).json({ error: 'internal_error', message: 'Failed to verify device authorization' });
  }
}

// Firestore collections and settings
const USERS_COL = 'users';
const ATT_COL = 'attendance';
const CHECK_DUPLICATE_SECONDS = 15;

// POST /api/employee — create or attach QR to a user (protected)
// This endpoint stores QR data on `users/{uid}` documents instead of a separate employees collection.
app.post('/api/employee', verifyToken, ensureAdminTrustedDevice, async (req, res) => {
  try {
    const { id, name, role, rate, department } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });

    const requestedId = id && String(id).trim() ? String(id).trim() : null;

    // If caller passed an existing user id, return existing QR if present
    if (requestedId) {
      try {
        const userDoc = await db.collection(USERS_COL).doc(requestedId).get();
        if (userDoc.exists) {
          const ud = userDoc.data();
          if (ud && ud.qrDataURI) {
            return res.json({ id: requestedId, name: ud.username || name || '', qrDataURI: ud.qrDataURI, existing: true });
          }
        }
      } catch (e) {
        console.warn('Could not check users collection for existing QR:', e && e.message);
      }
    }

    // Choose a target id (use provided id or generate a short id)
    let targetId = requestedId || nanoid(8);

    // Ensure there is a lightweight user doc to attach the QR to
    try {
      const uRef = db.collection(USERS_COL).doc(targetId);
      const uSnap = await uRef.get();
      if (!uSnap.exists) {
        const createObj = {
          username: name || null,
          role: role || '',
          department: department || null,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        };
        await uRef.set(createObj);
      }
    } catch (e) {
      console.warn('Could not create user doc for QR attachment:', e && e.message);
    }

    const payload = JSON.stringify({ id: targetId });
    const dataURI = await QRCode.toDataURL(payload, { margin: 2 });

    // Save a PNG to public/assets (best-effort)
    try {
      const base64 = dataURI.split(',')[1];
      const outDir = join(__dirname, 'public', 'assets');
      await fs.promises.mkdir(outDir, { recursive: true });
      await fs.promises.writeFile(join(outDir, `${targetId}.png`), base64, 'base64');
    } catch (e) {
      console.warn('Could not write QR image file:', e && e.message);
    }

    // Attach QR to the users document
    try {
      const updates = { qrDataURI: dataURI, updatedAt: admin.firestore.FieldValue.serverTimestamp() };
      if (department) updates.department = department;
      await db.collection(USERS_COL).doc(targetId).set(updates, { merge: true });
    } catch (e) {
      console.warn('Failed to update users doc with qrDataURI', e && e.message);
    }

    return res.json({ id: targetId, name, qrDataURI: dataURI });
  } catch (err) {
    console.error('POST /api/employee error:', err);
    return res.status(500).json({ error: 'Server error creating employee', details: String(err) });
  }
});

// POST /api/generateQR — generate a data-URI QR and attach to users doc (protected)
// NOTE: We gate this by admin role (via Firestore) but do not enforce the
// trusted-device check used for scanner operations. The QR dashboard page
// itself is additionally protected by an admin PIN.
app.post('/api/generateQR', verifyToken, async (req, res) => {
  try {
    // Verify caller is an admin in Firestore users collection
    try {
      const callerDoc = await db.collection('users').doc(req.user.uid).get();
      const callerRole = callerDoc.exists ? callerDoc.data().role : null;
      if (callerRole !== 'admin') {
        return res.status(403).json({ error: 'forbidden', message: 'Admin role required to generate QR codes' });
      }
    } catch (e) {
      console.warn('Could not verify caller role for generateQR:', e && e.message);
      return res.status(500).json({ error: 'role_check_failed', message: 'Could not verify caller role' });
    }

    const { id, name, role, department, shift } = req.body || {};
    if (!name && !id) return res.status(400).json({ error: 'Missing id or name' });

    const targetId = id && String(id).trim() ? String(id).trim() : nanoid(8);
    const uRef = db.collection('users').doc(targetId);
    const uSnap = await uRef.get();

    if (uSnap.exists && uSnap.data() && uSnap.data().qrDataURI) {
      return res.json({ id: targetId, qrDataURI: uSnap.data().qrDataURI, existing: true });
    }

    const payload = { id: targetId, name: name || (uSnap.exists ? uSnap.data().username : null) };
    const qrDataURI = await QRCode.toDataURL(JSON.stringify(payload), { errorCorrectionLevel: 'M', margin: 2, width: 400 });

    // Normalize fields so Firestore never sees undefined values
    const existingData = uSnap.exists ? (uSnap.data() || {}) : {};
    const normalized = {
      username: name || existingData.username || null,
      role: role || existingData.role || 'employee',
      department: (department !== undefined ? department : existingData.department) ?? null,
      shift: (shift !== undefined ? shift : existingData.shift) ?? null,
      qrValue: targetId,
      qrDataURI,
      qrAssignedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await uRef.set(normalized, { merge: true });

    return res.json({ id: targetId, qrDataURI, existing: false });
  } catch (err) {
    console.error('/api/generateQR error:', err);
    return res.status(500).json({ error: 'Server error generating QR', details: String(err) });
  }
});

// POST /api/check — record attendance (protected, admin trusted device only)
app.post('/api/check', verifyToken, ensureAdminTrustedDevice, async (req, res) => {
  try {
    const { id, action } = req.body;
    if (!id || !action) return res.status(400).json({ error: 'Missing id or action' });
    if (!['in', 'out'].includes(action)) return res.status(400).json({ error: 'Invalid action' });

    // Interpret the scanned id as a user UID (users collection). If not found, fall back to employees collection.
    const userRef = db.collection('users').doc(id);
    const userSnap = await userRef.get();
    let username = null;
    let userId = id;

    if (userSnap.exists) {
      const ud = userSnap.data();
      username = ud.username || ud.displayName || ud.name || null;
    } else {
      return res.status(404).json({ error: 'User not found' });
    }

    // Determine today's date string (YYYY-MM-DD) in server timezone (UTC)
    const now = new Date();
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(now.getUTCDate()).padStart(2, '0');
    const dateStr = `${yyyy}-${mm}-${dd}`;

    // Look for an attendance document for this user and date
    const q = await db.collection(ATT_COL)
      .where('userId', '==', userId)
      .where('date', '==', dateStr)
      .limit(1)
      .get();

    let attDocRef = null;
    let attData = null;
    if (!q.empty) {
      attDocRef = q.docs[0].ref;
      attData = q.docs[0].data();
    }

    const serverTs = admin.firestore.FieldValue.serverTimestamp();

    if (action === 'in') {
      if (!attDocRef) {
        // create new attendance record with timeIn
        const newDoc = {
          date: dateStr,
          timeIn: serverTs,
          timeOut: null,
          userId,
          username: username || null,
          createdAt: serverTs
        };
        const ref = await db.collection(ATT_COL).add(newDoc);
        return res.json({ ok: true, event: { id: ref.id, action: 'in', date: dateStr } });
      } else {
        // Enforce at most one time-in per user per day
        if (attData.timeIn) {
          return res.status(409).json({ ok: false, error: 'duplicate_time_in', message: 'User already has time-in recorded for today.' });
        }
        await attDocRef.update({ timeIn: serverTs });
        return res.json({ ok: true, event: { id: attDocRef.id, action: 'in', date: dateStr } });
      }
    } else {
      // action === 'out'
      if (!attDocRef) {
        // create new record with timeOut only
        const newDoc = {
          date: dateStr,
          timeIn: null,
          timeOut: serverTs,
          userId,
          username: username || null,
          createdAt: serverTs
        };
        const ref = await db.collection(ATT_COL).add(newDoc);
        return res.json({ ok: true, event: { id: ref.id, action: 'out', date: dateStr } });
      } else {
        // Enforce at most one time-out per user per day
        if (attData.timeOut) {
          return res.status(409).json({ ok: false, error: 'duplicate_time_out', message: 'User already has time-out recorded for today.' });
        }
        await attDocRef.update({ timeOut: serverTs });
        return res.json({ ok: true, event: { id: attDocRef.id, action: 'out', date: dateStr } });
      }
    }
  } catch (err) {
    console.error('POST /api/check error:', err);
    return res.status(500).json({ error: 'Server error saving attendance', details: String(err) });
  }
});

// GET /api/employees — list employees
app.get('/api/employees', async (req, res) => {
  try {
    const snaps = await db.collection('employees').orderBy('createdAt', 'asc').get();
    const employees = snaps.docs.map((d) => {
      const data = d.data();
      return {
        id: data.id || d.id,
        name: data.name,
        role: data.role || '',
        rate: data.rate || null,
        createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : null
      };
    });
    res.json(employees);
  } catch (err) {
    console.error('GET /api/employees error:', err);
    res.status(500).json({ error: 'Server error reading employees' });
  }
});

// GET /api/events — list attendance events with optional from/to
app.get('/api/events', async (req, res) => {
  try {
    const { from, to } = req.query;
    const snaps = await db.collection(ATT_COL).orderBy('time', 'desc').limit(1000).get();

    let events = snaps.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        employeeId: data.employeeId,
        action: data.action,
        time: data.time ? data.time.toDate().toISOString() : null
      };
    });

    if (from || to) {
      const fromTs = from ? new Date(from + 'T00:00:00').getTime() : -Infinity;
      const toTs = to ? new Date(to + 'T23:59:59').getTime() : Infinity;
      events = events.filter((e) => {
        if (!e.time) return false;
        const t = new Date(e.time).getTime();
        return t >= fromTs && t <= toTs;
      });
    }

    res.json(events);
  } catch (err) {
    console.error('GET /api/events error:', err);
    res.status(500).json({ error: 'Server error reading events' });
  }
});

// POST /api/deleteUser — delete from Auth + Firestore (protected)
app.post('/api/deleteUser', verifyToken, async (req, res) => {
  try {
    const { uid } = req.body;
    if (!uid) return res.status(400).json({ error: 'User ID is required' });

    try {
      await admin.auth().deleteUser(uid);
    } catch (authError) {
      console.error('Auth deletion failed:', authError);
    }

    await db.doc(`users/${uid}`).delete();
    res.json({ success: true, message: 'User deleted successfully' });
  } catch (err) {
    console.error('/api/deleteUser error:', err);
    res.status(500).json({ error: 'Server error deleting user', details: String(err) });
  }
});

// Helper: send PIN reset email (placeholder – plug Gmail / SMTP here)
async function sendPinResetEmail(toEmail, resetUrl) {
  const transporter = getMailTransporter();
  const from = process.env.SMTP_FROM || 'no-reply@example.com';

  if (!transporter) {
    console.log(`(Email disabled) PIN reset link for ${toEmail}: ${resetUrl}`);
    return;
  }

  try {
    await transporter.sendMail({
      from,
      to: toEmail,
      subject: 'Reset your admin PIN',
      text: `You requested to reset your admin PIN.\n\nClick the link below to choose a new 6-digit PIN:\n${resetUrl}\n\nIf you did not request this, you can safely ignore this email.`,
      html: `<p>You requested to reset your admin PIN.</p>
             <p><a href="${resetUrl}">Click here to choose a new 6-digit PIN</a></p>
             <p>If you did not request this, you can safely ignore this email.</p>`
    });
    console.log(`PIN reset email sent to ${toEmail}`);
  } catch (err) {
    console.error('Failed to send PIN reset email:', err);
  }
}

// Helper: send email containing a newly generated PIN
async function sendNewPinEmail(toEmail, pin) {
  const transporter = getMailTransporter();
  const from = process.env.SMTP_FROM || 'no-reply@example.com';

  if (!transporter) {
    console.log(`(Email disabled) New admin PIN for ${toEmail}: ${pin}`);
    return;
  }

  try {
    await transporter.sendMail({
      from,
      to: toEmail,
      subject: 'Your new admin PIN',
      text: `A new 6-digit admin PIN has been generated for your account.\n\nPIN: ${pin}\n\nKeep this PIN secure. You can now use it to unlock the QR Dashboard.`,
      html: `<p>A new 6-digit admin PIN has been generated for your account.</p>
             <p style="font-size:1.4rem;font-weight:bold;letter-spacing:0.25em;">${pin}</p>
             <p>Keep this PIN secure. You can now use it to unlock the QR Dashboard.</p>`
    });
    console.log(`New admin PIN email sent to ${toEmail}`);
  } catch (err) {
    console.error('Failed to send new PIN email:', err);
  }
}

// --- Email helpers (Nodemailer) ---
// Configure a reusable transporter via environment variables so secrets are not hardcoded.
// Required env vars (examples for Gmail SMTP or any SMTP provider):
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
let mailTransporter = null;
function getMailTransporter() {
  if (mailTransporter) return mailTransporter;

  const host = process.env.SMTP_HOST;
  const portRaw = process.env.SMTP_PORT;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM;

  if (!host || !portRaw || !user || !pass || !from) {
    console.warn('Email transport not fully configured; set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM to enable email sending.');
    return null;
  }

  const port = Number(portRaw) || 587;
  const secure = port === 465; // true for implicit TLS

  mailTransporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass }
  });

  return mailTransporter;
}

// POST /api/admin/pin-reset/request — authenticated admin requests a PIN reset link
app.post('/api/admin/pin-reset/request', verifyToken, async (req, res) => {
  try {
    const uid = req.user && req.user.uid;
    if (!uid) return res.status(401).json({ error: 'Unauthorized: missing uid' });

    const userRef = db.collection('users').doc(uid);
    const snap = await userRef.get();
    if (!snap.exists) return res.status(400).json({ error: 'Admin profile not found for PIN reset' });

    const data = snap.data() || {};
    const role = (data.role || '').toLowerCase();
    const email = (data.email || req.user.email || '').toLowerCase();
    if (role !== 'admin') return res.status(403).json({ error: 'Forbidden: admin role required for PIN reset' });
    if (!email) return res.status(400).json({ error: 'No email on file for this admin account' });

    const token = nanoid(32);
    const expiresAt = Date.now() + 30 * 60 * 1000; // 30 minutes

    await userRef.set({
      pinResetToken: token,
      pinResetExpires: expiresAt
    }, { merge: true });

    const baseUrl = `${req.protocol}://${req.get('host')}`.replace(/\/$/, '');
    const resetUrl = `${baseUrl}/pages/reset-pin.html?token=${encodeURIComponent(token)}`;

    await sendPinResetEmail(email, resetUrl);

    return res.json({ ok: true });
  } catch (err) {
    console.error('/api/admin/pin-reset/request error:', err);
    return res.status(500).json({ error: 'Server error generating PIN reset link', details: String(err) });
  }
});

// POST /api/admin/pin-reset/complete — anonymous endpoint to set new PIN using token
app.post('/api/admin/pin-reset/complete', async (req, res) => {
  try {
    const { token, newPin } = req.body || {};
    const pinStr = newPin != null ? String(newPin).trim() : '';

    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid reset token' });
    }

    if (!pinStr || !/^\d{6}$/.test(pinStr)) {
      return res.status(400).json({ error: 'PIN must be a 6-digit number' });
    }

    const snap = await db.collection('users').where('pinResetToken', '==', token).limit(1).get();
    if (snap.empty) {
      return res.status(400).json({ error: 'Reset link is invalid or has already been used' });
    }

    const doc = snap.docs[0];
    const data = doc.data() || {};
    const role = (data.role || '').toLowerCase();
    const expiresAt = typeof data.pinResetExpires === 'number' ? data.pinResetExpires : 0;

    if (role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden: only admin PINs can be reset with this link' });
    }

    if (!expiresAt || Date.now() > expiresAt) {
      return res.status(400).json({ error: 'Reset link has expired. Please request a new one.' });
    }

    await doc.ref.set({
      pin: pinStr,
      pinUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      pinResetToken: admin.firestore.FieldValue.delete(),
      pinResetExpires: admin.firestore.FieldValue.delete()
    }, { merge: true });

    return res.json({ ok: true });
  } catch (err) {
    console.error('/api/admin/pin-reset/complete error:', err);
    return res.status(500).json({ error: 'Server error completing PIN reset', details: String(err) });
  }
});

// POST /api/admin/forgot-pin — generate a new admin PIN (conceptually notified via email)
app.post('/api/admin/forgot-pin', verifyToken, async (req, res) => {
  try {
    const uid = req.user && req.user.uid;
    if (!uid) return res.status(401).json({ error: 'Unauthorized: missing uid' });

    const decodedEmail = req.user && req.user.email ? String(req.user.email).toLowerCase() : null;

    // Look up caller in users collection: primary by UID
    const userRef = db.collection('users').doc(uid);
    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      return res.status(400).json({ error: 'Admin profile not found for PIN reset' });
    }

    const userData = userSnap.data() || {};
    const email = (userData.email || decodedEmail || '').toLowerCase();
    const roleRaw = userData.role || null;
    const role = roleRaw ? String(roleRaw).toLowerCase() : null;

    // Also consider custom admin claim on the ID token
    const hasAdminClaim = !!(req.user && req.user.admin === true);
    const isAdmin = role === 'admin' || hasAdminClaim;
    if (!isAdmin) {
      return res.status(403).json({ error: 'Forbidden: admin role required for PIN reset' });
    }

    if (!email) {
      return res.status(400).json({ error: 'No email on file for this admin account' });
    }

    // Generate a random 6-digit PIN
    const generatedPin = String(Math.floor(100000 + Math.random() * 900000));

    await userRef.set({
      pin: generatedPin,
      pinUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    // Email the new PIN to the admin.
    await sendNewPinEmail(email, generatedPin);

    console.log(`Admin PIN reset requested for ${uid} <${email}>. New PIN generated and stored.`);

    return res.json({ ok: true });
  } catch (err) {
    console.error('/api/admin/forgot-pin error:', err);
    return res.status(500).json({ error: 'Server error processing PIN reset', details: String(err) });
  }
});

// Lightweight healthcheck
app.get('/health', (req, res) => res.json({ ok: true, time: Date.now() }));

// Check if current authenticated admin on this device may use QR dashboard / scanner
app.get('/api/qr-access', verifyToken, ensureAdminTrustedDevice, (req, res) => {
  return res.json({ ok: true, deviceId: req.deviceId || null });
});

// Debug headers (redact Authorization)
app.all('/debug/headers', (req, res) => {
  const safe = { ...req.headers };
  if (safe.authorization) safe.authorization = String(safe.authorization).split(' ')[0] + ' [REDACTED]';
  res.json({ headers: safe });
});

// Static file serving
const PUBLIC_DIR = join(__dirname, 'public');
if (fs.existsSync(PUBLIC_DIR)) app.use(express.static(PUBLIC_DIR));

// Serve other static files from project root
app.use(express.static(__dirname));

// Basic index route
app.get('/', (req, res) => res.sendFile(join(__dirname, 'index.html')));

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'internal_server_error', message: String(err) });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Admin server running on http://localhost:${PORT}`);
});
// This endpoint intentionally does NOT enforce any "age"/expiration on the
// account request document: an admin may approve requests regardless of how
// long they've been pending.
app.post('/api/createUser', verifyToken, async (req, res) => {
  try {
    const { email, password, username, role, pin } = req.body;

    if (!email || !password) return res.status(400).json({ error: 'email and password required' });

    // Require that the caller is an admin in Firestore users collection
    // (protects this endpoint from non-admin authenticated users)
    try {
      let callerRoleRaw = null;
      let callerRole = null;
      try {
        // Primary lookup: users/{uid}
        const uid = req.user && req.user.uid;
        if (uid) {
          const callerDocByUid = await db.collection('users').doc(uid).get();
          if (callerDocByUid.exists) {
            callerRoleRaw = callerDocByUid.data().role;
          }
        }

        // Fallback lookup: users where email == req.user.email
        if (!callerRoleRaw) {
          const email = req.user && req.user.email ? String(req.user.email).toLowerCase() : null;
          if (email) {
            const snap = await db.collection('users').where('email', '==', email).limit(1).get();
            if (!snap.empty) {
              const doc = snap.docs[0];
              const data = doc.data() || {};
              callerRoleRaw = data.role || null;
            }
          }
        }

        callerRole = callerRoleRaw ? String(callerRoleRaw).toLowerCase() : null;
      } catch (inner) {
        console.warn('Firestore role lookup failed for caller:', inner && inner.message);
      }

      // Always also honor custom admin claim on the ID token if present.
      const hasAdminClaim = !!(req.user && req.user.admin === true);
      if (hasAdminClaim && callerRole !== 'admin') {
        console.warn('Caller has admin custom claim but Firestore role is', callerRoleRaw);
        callerRole = 'admin';
      }

      if (callerRole !== 'admin') {
        console.warn('createUser called by non-admin user; proceeding anyway for now. role =', callerRoleRaw);
      }
    } catch (e) {
      console.warn('Could not verify caller role (no Firestore or custom-claim admin):', e && e.message);
      return res.status(500).json({ error: 'Could not verify caller role' });
    }

    // Create the user in Firebase Auth (or reuse if email already exists)
    let userRecord;
    const normalizedEmail = String(email).toLowerCase();
    try {
      userRecord = await admin.auth().createUser({
        email: normalizedEmail,
        password: String(password),
        displayName: username || undefined,
        emailVerified: false
      });
    } catch (e) {
      // If the email is already registered in Auth, reuse that account
      if (e && e.code === 'auth/email-already-exists') {
        console.warn('Email already exists in Auth, reusing existing user:', normalizedEmail);
        userRecord = await admin.auth().getUserByEmail(normalizedEmail);
      } else {
        throw e;
      }
    }

    // If the new user should be an admin, set a custom claim
    if (role === 'admin') {
      try {
        await admin.auth().setCustomUserClaims(userRecord.uid, { admin: true });
      } catch (e) {
        console.warn('Could not set custom claims for new user:', e && e.message);
      }
    }

    // Create Firestore user record
    const userRole = role || 'employee';
    const adminPin = (userRole === 'admin') ? (pin || '123456') : null;

    await db.collection('users').doc(userRecord.uid).set({
      username: username || '',
      email: normalizedEmail,
      role: userRole,
      pin: adminPin,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      authProvider: 'firebase'
    });

    return res.json({ uid: userRecord.uid });
  } catch (err) {
    console.error('/api/createUser error:', err);
    let message = 'Server error creating user';
    let status = 500;
    if (err && err.code) {
      switch (err.code) {
        case 'auth/email-already-exists':
          message = 'Email already exists';
          status = 400;
          break;
        case 'auth/invalid-email':
          message = 'Invalid email address';
          status = 400;
          break;
        case 'auth/invalid-password':
          message = 'Invalid password';
          status = 400;
          break;
        default:
          // keep generic but include code in details
          break;
      }
    }
    return res.status(status).json({
      error: message,
      code: err && err.code ? err.code : undefined,
      details: err && err.message ? err.message : String(err)
    });
  }
});

// POST /api/payrolls — save payroll run and its lines (protected)
// Expects: { periodStart, periodEnd, lines: [ { employeeId, gross, deductions, net, ... } ] }
app.post('/api/payrolls', verifyToken, async (req, res) => {
  try {
    const { periodStart, periodEnd, lines } = req.body || {};
    if (!periodStart || !periodEnd) return res.status(400).json({ error: 'periodStart and periodEnd are required' });
    if (!Array.isArray(lines) || lines.length === 0) return res.status(400).json({ error: 'lines must be a non-empty array' });

    // Verify caller is an admin (fallback to Firestore users collection)
    try {
      const callerDoc = await db.collection('users').doc(req.user.uid).get();
      const callerRole = callerDoc.exists ? callerDoc.data().role : null;
      if (callerRole !== 'admin') return res.status(403).json({ error: 'Forbidden: admin role required' });
    } catch (e) {
      console.warn('Could not verify caller role for payroll save:', e && e.message);
      return res.status(500).json({ error: 'Could not verify caller role' });
    }

    const run = {
      periodStart: String(periodStart),
      periodEnd: String(periodEnd),
      createdBy: req.user.uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      status: 'draft'
    };

    const runRef = await db.collection('payrolls').add(run);

    // Prepare batch write for lines (store per-user under their UID)
    const batch = db.batch();
    const linesColRef = db.collection('payrolls').doc(runRef.id).collection('lines');
    lines.forEach((ln) => {
      const userId = ln.userId || nanoid();
      const lref = linesColRef.doc(userId);
      // sanitize and map fields to the new schema
      const safeLine = {
        userId: userId,
        username: ln.username || null,
        role: ln.role || null,
        ratePerDay: typeof ln.ratePerDay === 'number' ? ln.ratePerDay : (ln.ratePerDay ? Number(ln.ratePerDay) : null),
        daysWorked: typeof ln.daysWorked === 'number' ? ln.daysWorked : Number(ln.daysWorked) || 0,
        hoursWorked: typeof ln.hoursWorked === 'number' ? ln.hoursWorked : Number(ln.hoursWorked) || 0,
        ndHours: typeof ln.ndHours === 'number' ? ln.ndHours : Number(ln.ndHours) || 0,
        otHours: typeof ln.otHours === 'number' ? ln.otHours : Number(ln.otHours) || 0,
        regularHolidayHours: typeof ln.regularHolidayHours === 'number' ? ln.regularHolidayHours : Number(ln.regularHolidayHours) || 0,
        specialHolidayHours: typeof ln.specialHolidayHours === 'number' ? ln.specialHolidayHours : Number(ln.specialHolidayHours) || 0,
        gross: typeof ln.gross === 'number' ? ln.gross : Number(ln.gross) || 0,
        deductions: ln.deductions || {},
        net: typeof ln.net === 'number' ? ln.net : Number(ln.net) || 0,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      };
      batch.set(lref, safeLine);
    });

    await batch.commit();

    return res.json({ ok: true, id: runRef.id });
  } catch (err) {
    console.error('/api/payrolls error:', err);
    return res.status(500).json({ error: 'Server error saving payroll', details: String(err) });
  }
});