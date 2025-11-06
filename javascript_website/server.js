import admin from 'firebase-admin';
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Initialize Admin SDK with your service account
admin.initializeApp({
  credential: admin.credential.cert(join(__dirname, 'mariners-hotellink-firebase-adminsdk-fbsvc-65bfc6c5b7.json'))
});

const app = express();
app.use(cors());
app.use(express.json());

// Improved error handling for delete endpoint
app.post('/api/deleteUser', async (req, res) => {
  try {
    const { uid } = req.body;
    
    if (!uid) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    // Delete from Auth first
    try {
      await admin.auth().deleteUser(uid);
    } catch (authError) {
      console.error('Auth deletion failed:', authError);
      // Continue to delete Firestore data even if Auth fails
    }

    // Delete from Firestore
    await admin.firestore().doc(`users/${uid}`).delete();
    
    res.json({ success: true, message: 'User deleted successfully' });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ 
      error: error.message,
      details: error.toString()
    });
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Admin server running on http://localhost:${PORT}`);
});