import { db } from './firebase-config.js';

export function loadProfile(uid) {
  db.collection('users').doc(uid).get().then(doc => {
    if (doc.exists) {
      document.getElementById('profile-info').innerHTML = `
        <strong>Email:</strong> ${doc.data().email}<br>
        <strong>Role:</strong> ${doc.data().role}
      `;
    }
  });
}
