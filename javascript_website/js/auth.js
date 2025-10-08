import { auth, db } from './firebase-config.js';

export function signup(email, password, role) {
  return auth.createUserWithEmailAndPassword(email, password)
    .then(user => db.collection('users').doc(user.user.uid).set({ email, role }));
}

export function login(email, password) {
  return auth.signInWithEmailAndPassword(email, password);
}

export function logout() {
  return auth.signOut();
}
