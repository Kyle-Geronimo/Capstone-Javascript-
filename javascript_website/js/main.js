import { auth } from './firebase-config.js';
import { loadProfile } from './profile.js';
import { loadChatbotData } from './chatbot.js';
import { loadModuleStatus } from './modules.js';

auth.onAuthStateChanged(user => {
  const logoutBtn = document.getElementById('logout-btn');
  if (user) {
    logoutBtn.style.display = '';
    loadProfile(user.uid);
    loadChatbotData();
    loadModuleStatus();
  } else {
    logoutBtn.style.display = 'none';
  }
});
