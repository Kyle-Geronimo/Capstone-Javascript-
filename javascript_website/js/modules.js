// modules.js
import { db, auth } from './firebase-config.js';
import { doc, getDoc, setDoc } from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js';

export async function toggleModule() {
  const user = auth.currentUser;
  if (!user) return;
  const moduleRef = doc(db, 'modules', 'mainModule');
  try {
    const snap = await getDoc(moduleRef);
    const status = snap.exists() ? !snap.data().enabled : true;
    await setDoc(moduleRef, { enabled: status });
    await loadModuleStatus();
  } catch (err) {
    console.error('toggleModule error', err);
  }
}

export async function loadModuleStatus() {
  const moduleRef = doc(db, 'modules', 'mainModule');
  try {
    const snap = await getDoc(moduleRef);
    document.getElementById('module-status').innerText =
      snap.exists() ? `Module enabled: ${snap.data().enabled}` : 'Module not set.';
  } catch (err) {
    console.error('loadModuleStatus error', err);
  }
}
