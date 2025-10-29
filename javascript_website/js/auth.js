import { auth, db } from './firebase-config.js';
import { collection, addDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js';
import { signInWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js';

// Change signup to create request only (no Auth user yet)
export async function signup(email, password, role = 'employee', username = '') {
  try {
    // Store request in Firestore
    const reqRef = await addDoc(collection(db, 'accountRequests'), {
      email,
      password, // warning: store securely in production
      role,
      username: username || email.split('@')[0],
      status: 'pending',
      createdAt: serverTimestamp()
    });
    
    alert('Account request submitted. An admin will review your request.');
    return reqRef;
  } catch (err) {
    console.error('Signup request failed:', err);
    throw err;
  }
}

// Keep existing login/logout functions
export function login(email, password) {
  return signInWithEmailAndPassword(auth, email, password);
}

export function logout() {
  return signOut(auth);
}
