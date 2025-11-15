import { auth, db } from './firebase-config.js';
import {
  collection,
  onSnapshot,
  getDoc,
  doc,
  updateDoc
} from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js';

/* ==================================================
  SECTION: Helpers
  - Small utility functions shared by the archived users UI
  ================================================== */
// Helper: generate initials
function getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length > 1) return (parts[0][0] + parts[parts.length-1][0]).toUpperCase();
  return parts[0][0].toUpperCase();
}

// Helper: avatar gradient selection
function getAvatarColor(initials) {
  const colors = [
    'linear-gradient(135deg, #4f8cff 0%, #6ed6ff 100%)',
    'linear-gradient(135deg, #ff4f8c 0%, #ff6ed6 100%)',
    'linear-gradient(135deg, #4fff8c 0%, #6effd6 100%)',
    'linear-gradient(135deg, #8c4fff 0%, #d66eff 100%)',
    'linear-gradient(135deg, #ff8c4f 0%, #ffd66e 100%)'
  ];
  const index = initials.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) % colors.length;
  return colors[index];
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}

/* ==================================================
   SECTION: Archived User Details
   - Modal and QR loading for a single archived user
   ================================================== */
// Load QR code for archived user in modal popup
async function loadModalArchivedQR(uid) {
  try {
    const qrElement = document.getElementById(`modal-qr-${uid}`);
    if (!qrElement) return;
    const archivedDoc = await getDoc(doc(db, 'archivedUsers', uid));
    if (!archivedDoc.exists()) {
      qrElement.innerHTML = '<em>User data not found</em>';
      return;
    }
    const archiveData = archivedDoc.data();
    const userData = archiveData.userData || {};

    // Request QR generation from backend
    const response = await fetch('/api/generateQR', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid: uid })
    });

    if (!response.ok) {
      qrElement.innerHTML = '<em>Failed to generate QR</em>';
      return;
    }

    const result = await response.json();
    const qrDataURI = result.qrDataURI;

    qrElement.innerHTML = `<img src="${escapeHtml(qrDataURI)}" alt="QR Code" style="width: 140px; height: 140px; border: 1px solid #ddd; border-radius: 4px;">`;

    // Persist QR in archived document for faster future loads
    userData.qrDataURI = qrDataURI;
    await updateDoc(doc(db, 'archivedUsers', uid), { userData: userData });
  } catch (err) {
    console.error('Error loading modal QR:', err);
    const qrElement = document.getElementById(`modal-qr-${uid}`);
    if (qrElement) qrElement.innerHTML = '<em>Error loading QR</em>';
  }
}

async function onViewArchivedDetails(e) {
  const id = e.target.closest('[data-id]').dataset.id;
  try {
    const archivedDoc = await getDoc(doc(db, 'archivedUsers', id));
    if (!archivedDoc.exists()) { alert('Archived user data not found'); return; }

    const data = archivedDoc.data();
    const userData = data.userData || {};
    const attendanceData = data.attendanceData || [];

    const modalHtml = `
      <div class="profile-edit-backdrop">
        <div class="profile-edit-modal archive-details-modal">
          <h3>Archived User Details</h3>
          <div class="archive-details">
            <h4>User Information</h4>
            <div class="details-section">
              <p><strong>Username:</strong> ${escapeHtml(userData.username || '—')}</p>
              <p><strong>Email:</strong> ${escapeHtml(userData.email || '—')}</p>
              <p><strong>Role:</strong> ${escapeHtml(userData.role || '—')}</p>
              <p><strong>Archived Date:</strong> ${new Date(data.archivedAt?.seconds * 1000).toLocaleDateString()}</p>
            </div>

            <h4>QR Code</h4>
            <div class="details-section" style="display: flex; justify-content: center; align-items: center;">
              <div id="modal-qr-${id}" style="display: flex; justify-content: center; align-items: center; min-height: 150px;">
                ${userData.qrDataURI ? `<img src="${escapeHtml(userData.qrDataURI)}" alt="QR Code" style="width: 140px; height: 140px; border: 1px solid #ddd; border-radius: 4px;">` : '<em>Loading QR code...</em>'}
              </div>
            </div>

            <h4>Attendance Records</h4>
            <div class="details-section scrollable">
              ${attendanceData.length ? attendanceData.map(record => `
                <div class="record-item">
                  <p><strong>Date:</strong> ${new Date(record.date?.seconds * 1000).toLocaleDateString()}</p>
                  <p><strong>Time In:</strong> ${record.timeIn ? new Date(record.timeIn?.seconds * 1000).toLocaleTimeString() : '—'}</p>
                  <p><strong>Time Out:</strong> ${record.timeOut ? new Date(record.timeOut?.seconds * 1000).toLocaleTimeString() : '—'}</p>
                </div>
              `).join('') : '<p>No attendance records found</p>'}
            </div>
          </div>
          <div class="modal-actions">
            <button type="button" class="action-btn secondary" id="closeArchiveDetails">Close</button>
          </div>
        </div>
      </div>
    `;

    const modalContainer = document.createElement('div');
    modalContainer.innerHTML = modalHtml;
    document.body.appendChild(modalContainer);

    if (!userData.qrDataURI) loadModalArchivedQR(id);

    const closeBtn = document.getElementById('closeArchiveDetails');
    const backdrop = document.querySelector('.profile-edit-backdrop');
    const closeModal = () => modalContainer.remove();
    closeBtn.addEventListener('click', closeModal);
    backdrop.addEventListener('click', (ev) => { if (ev.target === backdrop) closeModal(); });

  } catch (err) {
    console.error('Error viewing archived details:', err);
    alert('Error viewing archived details: ' + err.message);
  }
}

/* ==================================================
  SECTION: Archived Users List
  - Realtime watcher for archived users and list rendering
  ================================================== */
export function watchArchivedAccountsRealtime() {
  const container = document.getElementById('archived-accounts');
  if (!container) return;
  const archivedUsersCol = collection(db, 'archivedUsers');
  return onSnapshot(archivedUsersCol, snap => {
    if (snap.empty) { container.innerHTML = '<em>No archived users found.</em>'; return; }
    const users = snap.docs.map(d => ({ id: d.id, ...d.data().userData }));
    users.sort((a, b) => (a.email || '').localeCompare(b.email || ''));
    container.innerHTML = users.map(u => `
      <div class="user-item" data-id="${u.id}">
        <div class="user-avatar" style="background: ${getAvatarColor(getInitials(u.username || u.email))}">
          ${u.photoURL ? `<img src="${escapeHtml(u.photoURL)}" alt="${escapeHtml(u.username || '')}'s photo">` : getInitials(u.username || u.email)}
        </div>
        <div class="user-main">
          <div class="user-name">${escapeHtml(u.username || u.email || '—')}</div>
          <div class="user-email">${escapeHtml(u.email || '—')}</div>
          <div class="user-meta">
            <span class="user-role-badge">${escapeHtml(u.role || 'employee')}</span>
            <span class="user-id">ID: ${escapeHtml(u.id)}</span>
          </div>
        </div>
        <div class="user-actions">
          <button class="view-details-btn action-btn">View Details</button>
        </div>
      </div>
    `).join('');

    container.querySelectorAll('.view-details-btn').forEach(b => b.addEventListener('click', onViewArchivedDetails));
  }, err => container.innerHTML = `<em>Error: ${escapeHtml(err.message)}</em>`);
}

// Initialize when on archives page
window.addEventListener('DOMContentLoaded', () => {
  if (document.getElementById('archived-accounts')) {
    watchArchivedAccountsRealtime();
  }
});
