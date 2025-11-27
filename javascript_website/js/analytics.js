import { db, auth } from './firebase-config.js';
import { collection, addDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js';

// Simple visitor logging for public/customer pages
export async function logVisit(pageId = 'index', extra = {}) {
  try {
    const col = collection(db, 'visits');
    await addDoc(col, {
      pageId,
      path: window.location.pathname,
      ts: serverTimestamp(),
      userAgent: navigator.userAgent || '',
      uid: auth.currentUser ? auth.currentUser.uid : null,
      ...extra,
    });
  } catch (err) {
    console.warn('logVisit failed:', err);
  }
}
