import { auth, db } from './firebase-config.js';

export async function signup(email, password, role = 'user') {
  const userCred = await auth.createUserWithEmailAndPassword(email, password);
  await db.collection('users').doc(userCred.user.uid).set({ email, role });
  return userCred;
}

export function login(email, password) {
  return auth.signInWithEmailAndPassword(email, password);
}

export function logout() {
  return auth.signOut();
}
