import express from 'express';
import admin from 'firebase-admin';

admin.initializeApp();
const db = admin.firestore();
const app = express();
app.use(express.json());

// Secure this endpoint! Validate caller via Firebase ID token in Authorization header.
app.post('/approveRequest', async (req, res) => {
  try {
    const idToken = req.headers.authorization?.split('Bearer ')[1];
    if (!idToken) return res.status(401).send('Unauthorized');

    // Verify caller token and ensure caller is allowed (optional: check role in Firestore)
    const decoded = await admin.auth().verifyIdToken(idToken);
    const callerUid = decoded.uid;

    const { requestId } = req.body;
    if (!requestId) return res.status(400).send('Missing requestId');

    const reqRef = db.doc(`accountRequests/${requestId}`);
    const reqSnap = await reqRef.get();
    if (!reqSnap.exists) return res.status(404).send('Request not found');

    const reqData = reqSnap.data();

    // Create Auth user
    const userRecord = await admin.auth().createUser({
      email: reqData.email,
      password: reqData.password,     // avoid plain text in production: better to generate invite link
      displayName: reqData.username || undefined,
    });

    // Create users document keyed by UID
    await db.doc(`users/${userRecord.uid}`).set({
      email: reqData.email,
      username: reqData.username || null,
      role: reqData.role || 'employee',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Update the request doc to record approved UID (or delete the request)
    await reqRef.update({
      status: 'approved',
      approvedUid: userRecord.uid,
      approvedBy: callerUid,
      approvedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    // optionally: await reqRef.delete();

    res.json({ uid: userRecord.uid });
  } catch (err) {
    console.error(err);
    res.status(500).send(err.message || 'Error');
  }
});

export default app;