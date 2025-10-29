import admin from 'firebase-admin';
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Initialize Admin SDK with your service account
admin.initializeApp({
  credential: admin.credential.cert(join(__dirname, 'capstone-a773d-firebase-adminsdk-fbsvc-9f63ee4596.json'))
});

const app = express();
app.use(cors()); // Allow cross-origin requests during development
app.use(express.json());

// Endpoint to delete user from both Auth and Firestore
app.post('/api/deleteUser', async (req, res) => {
  try {
    const { uid } = req.body;
    
    // Delete from Auth first
    await admin.auth().deleteUser(uid);
    
    // Then delete from Firestore
    await admin.firestore().doc(`users/${uid}`).delete();
    
    res.json({ success: true });
  } catch (error) {
    console.error('Delete failed:', error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Admin server running on http://localhost:${PORT}`);
});