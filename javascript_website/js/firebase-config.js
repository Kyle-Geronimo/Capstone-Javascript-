const firebaseConfig = {
  apiKey: "AIzaSyBUiQSMj8QbBzOAHgCWH--_N5rPXgQRkUo",
  authDomain: "mariners-hotellink.firebaseapp.com",
  projectId: "mariners-hotellink",
  storageBucket: "mariners-hotellink.firebasestorage.app",
  messagingSenderId: "396146858365",
  appId: "1:396146858365:web:f3b00e40ee2a5ec4245414",
  measurementId: "G-4LGVNG134E"
};

if (typeof firebase === 'undefined') {
  throw new Error('Firebase SDK not found. Include compat scripts in your HTML before importing this module.');
}

if (!firebase.apps || !firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}

export const auth = firebase.auth();
export const db = firebase.firestore();

export async function getUserRole(uid) {
  const doc = await db.collection('users').doc(uid).get();
  return doc.exists ? doc.data().role : null;
}
