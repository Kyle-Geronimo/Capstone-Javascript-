import admin from 'firebase-admin';
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import QRCode from 'qrcode';
import { nanoid } from 'nanoid';

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
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
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

// Firestore collections and settings
const USERS_COL = 'users';
const ATT_COL = 'attendance';
const CHECK_DUPLICATE_SECONDS = 15;

// POST /api/employee — create or attach QR to a user (protected)
// This endpoint stores QR data on `users/{uid}` documents instead of a separate employees collection.
app.post('/api/employee', verifyToken, async (req, res) => {
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
app.post('/api/generateQR', verifyToken, async (req, res) => {
  try {
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

    await uRef.set({
      username: name || (uSnap.exists ? uSnap.data().username : null),
      role: role || (uSnap.exists ? uSnap.data().role : 'employee'),
      department: department || (uSnap.exists ? uSnap.data().department : null),
      shift: shift || (uSnap.exists ? uSnap.data().shift : null),
      qrValue: targetId,
      qrDataURI,
      qrAssignedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    return res.json({ id: targetId, qrDataURI, existing: false });
  } catch (err) {
    console.error('/api/generateQR error:', err);
    return res.status(500).json({ error: 'Server error generating QR', details: String(err) });
  }
});

// POST /api/check — record attendance (protected)
app.post('/api/check', verifyToken, async (req, res) => {
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
        // update existing: set timeIn if missing
        if (attData.timeIn) {
          // prevent duplicate within cooldown
          const lastTime = attData.timeIn && attData.timeIn.toDate ? attData.timeIn.toDate().getTime() : 0;
          const secondsSince = Math.round((Date.now() - lastTime) / 1000);
          if (secondsSince < CHECK_DUPLICATE_SECONDS) {
            return res.json({ ok: false, error: `duplicate: last in was ${secondsSince}s ago` });
          }
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
        // update existing: set timeOut
        if (attData.timeOut) {
          const lastTime = attData.timeOut && attData.timeOut.toDate ? attData.timeOut.toDate().getTime() : 0;
          const secondsSince = Math.round((Date.now() - lastTime) / 1000);
          if (secondsSince < CHECK_DUPLICATE_SECONDS) {
            return res.json({ ok: false, error: `duplicate: last out was ${secondsSince}s ago` });
          }
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
    const snaps = await db.collection(EMP_COL).orderBy('createdAt', 'asc').get();
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

// Lightweight healthcheck
app.get('/health', (req, res) => res.json({ ok: true, time: Date.now() }));

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

// POST /api/createUser — create Firebase Auth user and Firestore record (protected)
// This endpoint intentionally does NOT enforce any "age"/expiration on the
// account request document: an admin may approve requests regardless of how
// long they've been pending.
app.post('/api/createUser', verifyToken, async (req, res) => {
  try {
    const { email, password, username, role } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });

    // Require that the caller is an admin in Firestore users collection
    // (protects this endpoint from non-admin authenticated users)
    try {
      const callerDoc = await db.collection('users').doc(req.user.uid).get();
      const callerRole = callerDoc.exists ? callerDoc.data().role : null;
      if (callerRole !== 'admin') return res.status(403).json({ error: 'Forbidden: admin role required' });
    } catch (e) {
      console.warn('Could not verify caller role:', e && e.message);
      return res.status(500).json({ error: 'Could not verify caller role' });
    }

    // Create the user in Firebase Auth
    const userRecord = await admin.auth().createUser({
      email: String(email).toLowerCase(),
      password: String(password),
      displayName: username || undefined,
      emailVerified: false
    });

    // If the new user should be an admin, set a custom claim
    if (role === 'admin') {
      try {
        await admin.auth().setCustomUserClaims(userRecord.uid, { admin: true });
      } catch (e) {
        console.warn('Could not set custom claims for new user:', e && e.message);
      }
    }

    // Create Firestore user record
    await db.collection('users').doc(userRecord.uid).set({
      username: username || '',
      email: String(email).toLowerCase(),
      role: role || 'employee',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      authProvider: 'firebase'
    });

    return res.json({ uid: userRecord.uid });
  } catch (err) {
    console.error('/api/createUser error:', err);
    return res.status(500).json({ error: 'Server error creating user', details: String(err) });
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