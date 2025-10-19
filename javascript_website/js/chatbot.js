import { db } from './firebase-config.js';

export function loadChatbotData() {
  const container = document.getElementById('chatbot-data');
  if (!container) return;
  db.collection('chatbotData').get()
    .then(snapshot => {
      if (snapshot.empty) {
        container.innerHTML = "<em>No data yet.</em>";
        return;
      }
      const html = snapshot.docs.map(doc => {
        const data = doc.data();
        return `<div class="data-item"><pre>${escapeHtml(JSON.stringify(data, null, 2))}</pre></div>`;
      }).join('');
      container.innerHTML = html;
    })
    .catch(err => {
      container.innerHTML = `<em>Error loading data: ${escapeHtml(err.message)}</em>`;
    });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}
