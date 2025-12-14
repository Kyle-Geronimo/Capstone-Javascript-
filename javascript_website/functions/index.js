import express from 'express';
import admin from 'firebase-admin';
import * as functions from 'firebase-functions';
import nodemailer from 'nodemailer';

admin.initializeApp();

// Create the deleteUser function
export const deleteUser = functions.https.onRequest(async (req, res) => {
  try {
    // Verify the request is a POST
    if (req.method !== 'POST') {
      return res.status(405).send('Method not allowed');
    }

    // Get the authorization token
    const idToken = req.headers.authorization?.split('Bearer ')[1];
    if (!idToken) {
      return res.status(401).send('Unauthorized');
    }

    // Verify the token and get the caller's info
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    
    // Check if the caller is an admin
    const callerDoc = await admin.firestore().doc(`users/${decodedToken.uid}`).get();
    if (!callerDoc.exists || callerDoc.data().role !== 'admin') {
      return res.status(403).send('Forbidden: Admin access required');
    }

    // Get the user ID to delete
    const { uid } = req.body;
    if (!uid) {
      return res.status(400).send('Missing user ID');
    }

    // Delete the user from Firebase Auth
    await admin.auth().deleteUser(uid);
    
    res.status(200).send({ message: 'User deleted successfully' });
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).send({ error: error.message });
  }
});
const db = admin.firestore();

// --- Email transporter for QR verification codes ---
const qrMailUser = functions.config().qrmail?.user;
const qrMailPass = functions.config().qrmail?.pass;

const qrTransporter = (qrMailUser && qrMailPass)
  ? nodemailer.createTransport({
      service: 'gmail',
      auth: { user: qrMailUser, pass: qrMailPass }
    })
  : null;

function generateSixDigitCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// Callable: sendQrVerificationCode
export const sendQrVerificationCode = functions.https.onCall(async (data, context) => {
  const uid = context.auth?.uid;
  if (!uid) {
    throw new functions.https.HttpsError('unauthenticated', 'Not signed in');
  }

  if (!qrTransporter) {
    throw new functions.https.HttpsError('failed-precondition', 'Email transport not configured');
  }

  // Ensure caller is admin
  const userDoc = await db.doc(`users/${uid}`).get();
  const userData = userDoc.exists ? userDoc.data() : {};
  if (userData.role !== 'admin') {
    throw new functions.https.HttpsError('permission-denied', 'Only admins can request verification codes');
  }

  // Get auth user to read email
  const userRecord = await admin.auth().getUser(uid);
  const email = userRecord.email;
  if (!email) {
    throw new functions.https.HttpsError('failed-precondition', 'Account has no email');
  }

  const code = generateSixDigitCode();
  const expiresAt = admin.firestore.Timestamp.fromDate(
    new Date(Date.now() + 5 * 60 * 1000)
  );

  await db.doc(`email_verification_codes/${uid}`).set({
    uid,
    email,
    code,
    expiresAt,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const mailOptions = {
    from: `HotelLink QR Security <${qrMailUser}>`,
    to: email,
    subject: 'Your QR Dashboard Verification Code',
    text: `Your verification code is: ${code}\n\nThis code will expire in 5 minutes.`,
    html: `
      <p>Hi,</p>
      <p>Your verification code for the QR Dashboard is:</p>
      <p style="font-size:24px;font-weight:700;letter-spacing:0.32em;">${code}</p>
      <p>This code will expire in 5 minutes.</p>
      <p>If you did not request this, you can ignore this email.</p>
    `,
  };

  await qrTransporter.sendMail(mailOptions);
  return { ok: true };
});

// Callable: verifyQrVerificationCode
export const verifyQrVerificationCode = functions.https.onCall(async (data, context) => {
  const uid = context.auth?.uid;
  const code = String(data?.code || '').trim();

  if (!uid) {
    throw new functions.https.HttpsError('unauthenticated', 'Not signed in');
  }
  if (!/^\d{6}$/.test(code)) {
    throw new functions.https.HttpsError('invalid-argument', 'Code must be 6 digits');
  }

  const docRef = db.doc(`email_verification_codes/${uid}`);
  const snap = await docRef.get();
  if (!snap.exists) {
    throw new functions.https.HttpsError('not-found', 'No verification code found');
  }

  const { code: storedCode, expiresAt } = snap.data();
  if (!storedCode || !expiresAt) {
    throw new functions.https.HttpsError('failed-precondition', 'Verification record invalid');
  }

  if (expiresAt.toDate() < new Date()) {
    await docRef.delete().catch(() => {});
    throw new functions.https.HttpsError('deadline-exceeded', 'Code expired');
  }

  if (storedCode !== code) {
    throw new functions.https.HttpsError('permission-denied', 'Incorrect code');
  }

  await docRef.delete().catch(() => {});
  return { ok: true };
});

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
    const newRole = reqData.role || 'employee';
    const adminPin = (newRole === 'admin') ? (reqData.pin || '123456') : null;

    await db.doc(`users/${userRecord.uid}`).set({
      email: reqData.email,
      username: reqData.username || null,
      role: newRole,
      pin: adminPin,
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
