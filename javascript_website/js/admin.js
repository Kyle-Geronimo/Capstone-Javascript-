import { db } from './firebase-config.js';

// Load pending account requests
function loadRequests() {
  db.collection('accountRequests').where('status', '==', 'pending').get()
    .then(snapshot => {
      let html = '';
      snapshot.forEach(doc => {
        const data = doc.data();
        html += `
          <div class="request-item">
            <strong>${data.username}</strong> (${data.email})
            <button onclick="approveRequest('${doc.id}')">Approve</button>
          </div>
        `;
      });
      document.getElementById('requests').innerHTML = html || "<em>No requests.</em>";
    });
}

// Approve a request
window.approveRequest = function(requestId) {
  db.collection('accountRequests').doc(requestId).update({ status: 'approved' })
    .then(() => {
      alert('Request approved!');
      loadRequests();
    });
};

// Initial load
loadRequests();