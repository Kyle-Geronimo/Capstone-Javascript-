// Firebase initialization
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js';
import { getFirestore, doc, getDoc } from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js';
import { getAnalytics } from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-analytics.js';
import { getStorage } from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-storage.js';

const firebaseConfig = {
  apiKey: "AIzaSyBUiQSMj8QbBzOAHgCWH--_N5rPXgQRkUo",
  authDomain: "mariners-hotellink.firebaseapp.com",
  projectId: "mariners-hotellink",
  storageBucket: "mariners-hotellink.firebasestorage.app",
  messagingSenderId: "396146858365",
  appId: "1:396146858365:web:f3b00e40ee2a5ec4245414",
  measurementId: "G-4LGVNG134E"
};

const app = initializeApp(firebaseConfig);
// analytics optional — only if you need it and allowed in your environment
let analytics;
try { analytics = getAnalytics(app); } catch (e) { /* ignore if not available in env */ }

export const auth = getAuth(app);
export const db = getFirestore(app);
// Initialize Storage
export const storage = getStorage(app);

// Get user's role from database
export async function getUserRole(uid) {
  if (!uid) return null;
  try {
    const userDoc = await getDoc(doc(db, 'users', uid));
    const role = userDoc.exists() ? userDoc.data().role : null;
    console.log('User role:', role); // Debug log
    return role;
  } catch (err) {
    console.error('Error getting user role:', err);
    return null;
  }
}

// --- ADD: expose auth/db/storage as legacy globals for pages that poll window.auth/window.db ---
if (typeof window !== 'undefined') {
  try {
    window.auth = auth;
    window.db = db;
    window.storage = storage;
    // small helper to detect firebase ready from non-module scripts
    window.__firebase_ready = true;
    console.log('firebase-config: exposed auth, db, storage on window');
  } catch (e) {
    console.warn('firebase-config: could not expose globals', e);
  }
}
