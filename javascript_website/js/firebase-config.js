// Modular Firebase config (browser ESM)
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js';
import { getFirestore, doc, getDoc } from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js';
import { getAnalytics } from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-analytics.js';
import { getStorage } from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-storage.js';

const firebaseConfig = {
  apiKey: "AIzaSyBYdtNZaDlhLd7m9sjhlXMQ_xMnMyDDWuQ",
  authDomain: "capstone-a773d.firebaseapp.com",
  projectId: "capstone-a773d",
  storageBucket: "capstone-a773d.firebasestorage.app",
  messagingSenderId: "190089180629",
  appId: "1:190089180629:web:8dddd02f202d483c26795c",
  measurementId: "G-YV905F3P88"
};

const app = initializeApp(firebaseConfig);
// analytics optional — only if you need it and allowed in your environment
let analytics;
try { analytics = getAnalytics(app); } catch (e) { /* ignore if not available in env */ }

export const auth = getAuth(app);
export const db = getFirestore(app);
// Initialize Storage
export const storage = getStorage(app);

export async function getUserRole(uid) {
  if (!uid) return null;
  const ref = doc(db, 'users', uid);
  const snap = await getDoc(ref);
  return snap.exists() ? snap.data().role : null;
}
