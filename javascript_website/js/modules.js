import { db, auth } from './firebase-config.js';

export function toggleModule() {
  const user = auth.currentUser;
  if (!user) return;
  const moduleRef = db.collection('modules').doc('mainModule');
  moduleRef.get().then(doc => {
    const status = doc.exists ? !doc.data().enabled : true;
    moduleRef.set({ enabled: status });
    loadModuleStatus();
  });
}

export function loadModuleStatus() {
  db.collection('modules').doc('mainModule').get().then(doc => {
    document.getElementById('module-status').innerText =
      doc.exists ? `Module enabled: ${doc.data().enabled}` : 'Module not set.';
  });
}
