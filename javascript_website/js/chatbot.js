import { db } from './firebase-config.js';

export function loadChatbotData() {
  db.collection('chatbotData').get().then(snapshot => {
    let html = '';
    snapshot.forEach(doc => {
      html += `<div class="data-item">${JSON.stringify(doc.data())}</div>`;
    });
    document.getElementById('chatbot-data').innerHTML = html || "<em>No data yet.</em>";
  });
}
