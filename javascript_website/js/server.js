// ...new file...
import express from 'express';
import admin from 'firebase-admin';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const serviceAccount = JSON.parse(
  // load your service account JSON securely; using a file for dev:
  // fs.readFileSync(path.join(__dirname, 'config', 'serviceAccountKey.json'), 'utf8')
  // For demo, require the path below to exist.
  await (await import('fs/promises')).readFile(path.join(__dirname, 'config', 'serviceAccountKey.json'), 'utf8')
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const app = express();

app.use(express.json());

app.get('/api/accountRequests', async (req, res) => {
  try {
    const snapshot = await db.collection('accountRequests').get();
    const requests = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json(requests);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/accountRequests/:id/approve', async (req, res) => {
  try {
    const id = req.params.id;
    await db.collection('accountRequests').doc(id).update({ status: 'approved', approvedAt: admin.firestore.FieldValue.serverTimestamp() });
    // optionally create user record or notify user here
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(3000, () => console.log('Server listening on http://localhost:3000'));
// ...new file...