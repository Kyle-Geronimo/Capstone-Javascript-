import admin from 'firebase-admin';
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import QRCode from 'qrcode';
import { nanoid } from 'nanoid';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Initialize Admin SDK with your service account
admin.initializeApp({
  credential: admin.credential.cert(join(__dirname, 'mariners-hotellink-firebase-adminsdk-fbsvc-65bfc6c5b7.json'))
});

const db = admin.firestore();
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
const EMP_COL = 'employees';
const ATT_COL = 'attendance';
const CHECK_DUPLICATE_SECONDS = 15;

// POST /api/employee — create employee (protected)
app.post('/api/employee', verifyToken, async (req, res) => {
  try {
    const { name, role, rate } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });

    const id = nanoid(8);
    const employeeDoc = {
      id,
      name,
      role: role || '',
      rate: rate != null ? Number(rate) : null,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection(EMP_COL).doc(id).set(employeeDoc);

    const payload = JSON.stringify({ id });
    const dataURI = await QRCode.toDataURL(payload, { margin: 2 });

    // Save a PNG to public/assets (best-effort)
    try {
      const base64 = dataURI.split(',')[1];
      const outDir = join(__dirname, 'public', 'assets');
      await fs.promises.mkdir(outDir, { recursive: true });
      await fs.promises.writeFile(join(outDir, `${id}.png`), base64, 'base64');
    } catch (e) {
      console.warn('Could not write QR image file:', e && e.message);
    }

    return res.json({ id, name, qrDataURI: dataURI });
  } catch (err) {
    console.error('POST /api/employee error:', err);
    return res.status(500).json({ error: 'Server error creating employee', details: String(err) });
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
      // fallback: check employees collection
      const empRef = db.collection(EMP_COL).doc(id);
      const empSnap = await empRef.get();
      if (!empSnap.exists) return res.status(404).json({ error: 'User/Employee not found' });
      const ed = empSnap.data();
      username = ed.name || null;
      // if employees have a linked userId field, use it
      if (ed.userId) userId = ed.userId;
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