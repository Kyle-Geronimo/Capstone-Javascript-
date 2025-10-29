// chatbot.js
import { db } from './firebase-config.js';
import { collection, getDocs } from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js';

export async function loadChatbotData() {
  const container = document.getElementById('chatbot-data');
  if (!container) return;
  try {
    const snap = await getDocs(collection(db, 'chatbotData'));
    if (snap.empty) { container.innerHTML = "<em>No data yet.</em>"; return; }
    container.innerHTML = snap.docs.map(d => `<div class="data-item"><pre>${escapeHtml(JSON.stringify(d.data(), null, 2))}</pre></div>`).join('');
  } catch (err) {
    container.innerHTML = `<em>Error loading data: ${escapeHtml(err.message)}</em>`;
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}
