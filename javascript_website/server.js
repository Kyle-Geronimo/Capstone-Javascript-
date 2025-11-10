// --- Imports ---
import admin from 'firebase-admin';
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import QRCode from 'qrcode';
import { nanoid } from 'nanoid';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Initialize Firebase Admin SDK ---
admin.initializeApp({
  credential: admin.credential.cert(
    join(__dirname, 'mariners-hotellink-firebase-adminsdk-fbsvc-65bfc6c5b7.json')
  )
});

const db = admin.firestore();
const app = express();
app.use(cors());
app.use(express.json());

// --- Simple Request Logger ---
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} -- body:`, req.body || {});
  next();
});

// --- Firestore Collections ---
const EMP_COL = 'employees';
const ATT_COL = 'attendance';
const CHECK_DUPLICATE_SECONDS = 15;

/* ===========================================================
   API ROUTES
   =========================================================== */

// POST /api/employee → Create employee + generate QR
app.post('/api/employee', async (req, res) => {
  try {
    const { name, role, rate } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });

    const id = nanoid(8);
    const employeeDoc = {
      id,
      name,
      role: role || '',
      rate: rate ? Number(rate) : null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await db.collection(EMP_COL).doc(id).set(employeeDoc);

    const payload = JSON.stringify({ id });
    const dataURI = await QRCode.toDataURL(payload, { margin: 2 });

    // Save a PNG in public/assets
    try {
      const base64Data = dataURI.split(',')[1];
      const outDir = join(__dirname, 'public', 'assets');
      await fs.promises.mkdir(outDir, { recursive: true });
      await fs.promises.writeFile(join(outDir, `${id}.png`), base64Data, 'base64');
    } catch (e) {
      console.warn('⚠️ Could not write QR image file:', e?.message || e);
    }

    return res.json({ id, name, qrDataURI: dataURI });
  } catch (err) {
    console.error('❌ POST /api/employee error:', err);
    return res.status(500).json({ error: 'Server error creating employee', details: String(err) });
  }
});

// POST /api/check → Check in/out via QR scan
app.post('/api/check', async (req, res) => {
  try {
    const { id, action } = req.body;
    if (!id || !action) return res.status(400).json({ error: 'Missing id or action' });
    if (!['in', 'out'].includes(action)) return res.status(400).json({ error: 'Invalid action' });

    const empRef = db.collection(EMP_COL).doc(id);
    const empSnap = await empRef.get();
    if (!empSnap.exists) return res.status(404).json({ error: 'Employee not found' });

    // prevent duplicate spam
    const lastQuery = await db.collection(ATT_COL)
      .where('employeeId', '==', id)
      .orderBy('time', 'desc')
      .limit(1)
      .get();

    if (!lastQuery.empty) {
      const lastDoc = lastQuery.docs[0].data();
      const lastAction = lastDoc.action;
      const lastTime = lastDoc.time ? lastDoc.time.toDate().getTime() : 0;
      const now = Date.now();
      const secondsSince = Math.round((now - lastTime) / 1000);
      if (lastAction === action && secondsSince < CHECK_DUPLICATE_SECONDS) {
        return res.json({ ok: false, error: `duplicate: last ${action} was ${secondsSince}s ago` });
      }
    }

    const event = {
      employeeId: id,
      action,
      time: admin.firestore.FieldValue.serverTimestamp(),
      source: req.ip || null,
    };

    const attRef = await db.collection(ATT_COL).add(event);
    return res.json({
      ok: true,
      event: { id: attRef.id, employeeId: id, action, time: new Date().toISOString() },
    });
  } catch (err) {
    console.error('❌ POST /api/check error:', err);
    return res.status(500).json({ error: 'Server error saving attendance', details: String(err) });
  }
});

// GET /api/employees → list all employees
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
        createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : null,
      };
    });
    res.json(employees);
  } catch (err) {
    console.error('❌ GET /api/employees error:', err);
    res.status(500).json({ error: 'Server error reading employees' });
  }
});

// GET /api/events → list recent attendance logs
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
        time: data.time ? data.time.toDate().toISOString() : null,
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
    console.error('❌ GET /api/events error:', err);
    res.status(500).json({ error: 'Server error reading events' });
  }
});

// POST /api/deleteUser → delete from Firebase Auth + Firestore
app.post('/api/deleteUser', async (req, res) => {
  try {
    const { uid } = req.body;
    if (!uid) return res.status(400).json({ error: 'User ID is required' });

    try {
      await admin.auth().deleteUser(uid);
    } catch (authError) {
      console.warn('⚠️ Auth deletion failed:', authError.message);
    }

    await admin.firestore().doc(`users/${uid}`).delete();
    res.json({ success: true, message: 'User deleted successfully' });
  } catch (err) {
    console.error('❌ /api/deleteUser error:', err);
    res.status(500).json({ error: err.message, details: err.toString() });
  }
});

/* ===========================================================
   STATIC FILE SERVING (after API routes!)
   =========================================================== */

const PUBLIC_DIR = join(__dirname, 'public');
if (fs.existsSync(PUBLIC_DIR)) app.use(express.static(PUBLIC_DIR));

// serve everything else from the root
app.use(express.static(__dirname));

// Serve index.html from root
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'index.html'));
});

/* ===========================================================
   ERROR HANDLER
   =========================================================== */
app.use((err, req, res, next) => {
  console.error('🔥 Unhandled error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'internal_server_error', message: String(err) });
});

/* ===========================================================
   START SERVER
   =========================================================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});
