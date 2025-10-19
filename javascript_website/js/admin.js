import { db } from './firebase-config.js';

// replace loadRequests/get-based polling with realtime watcher
export function watchRequestsRealtime() {
  const container = document.getElementById('requests');
  if (!container) return;

  // subscribe to pending requests in realtime
  return db.collection('accountRequests')
    .where('status', '==', 'pending')
    .onSnapshot(snapshot => {
      if (snapshot.empty) {
        container.innerHTML = '<em>No requests.</em>';
        return;
      }
      container.innerHTML = snapshot.docs.map(doc => {
        const d = doc.data();
        return `
          <div class="request-item" data-id="${doc.id}">
            <div><strong>${escapeHtml(d.username || '—')}</strong> (${escapeHtml(d.email || '—')})</div>
            <div class="request-meta">${escapeHtml(d.note || '')}</div>
            <div class="request-actions">
              <button class="approve-btn action-btn">Approve</button>
              <button class="reject-btn action-btn">Reject</button>
            </div>
          </div>
        `;
      }).join('');
      // re-attach handlers after render
      container.querySelectorAll('.approve-btn').forEach(b => b.addEventListener('click', onApprove));
      container.querySelectorAll('.reject-btn').forEach(b => b.addEventListener('click', onReject));
    }, err => {
      container.innerHTML = `<em>Error: ${escapeHtml(err.message)}</em>`;
    });
}

// new: load accounts (admins and employees shown in same list, admins first)
export async function loadAccounts() {
  const container = document.getElementById('accounts');
  if (!container) return;
  try {
    const snapshot = await db.collection('users').get();
    if (snapshot.empty) {
      container.innerHTML = '<em>No accounts found.</em>';
      return;
    }
    const users = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    // sort: admins first, then others
    users.sort((a, b) => {
      if (a.role === b.role) return (a.email || '').localeCompare(b.email || '');
      if (a.role === 'admin') return -1;
      if (b.role === 'admin') return 1;
      return (a.role || '').localeCompare(b.role || '');
    });

    container.innerHTML = users.map(u => `
      <div class="user-item" data-id="${u.id}">
        <div class="user-main">
          <div class="user-name">${escapeHtml(u.username || u.email || '—')}</div>
          <div class="user-email">${escapeHtml(u.email || '—')}</div>
        </div>
        <div class="user-meta">
          <span class="user-role-badge">${escapeHtml(u.role || 'employee')}</span>
          <div class="user-actions">
            <button class="edit-btn action-btn">Edit</button>
            <button class="delete-btn action-btn">Delete</button>
          </div>
        </div>
      </div>
    `).join('');

    container.querySelectorAll('.edit-btn').forEach(b => b.addEventListener('click', onEditUser));
    container.querySelectorAll('.delete-btn').forEach(b => b.addEventListener('click', onDeleteUser));
  } catch (err) {
    container.innerHTML = `<em>Error loading accounts: ${escapeHtml(err.message)}</em>`;
  }
}

async function onApprove(e) {
  const id = e.target.closest('[data-id]').dataset.id;
  try {
    const reqRef = db.collection('accountRequests').doc(id);
    const reqSnap = await reqRef.get();
    if (!reqSnap.exists) { alert('Request not found'); return; }
    const reqData = reqSnap.data();

    // create user record in 'users' collection (does NOT create Firebase Auth user)
    const userData = {
      email: reqData.email || null,
      username: reqData.username || null,
      role: reqData.role || 'employee',
      createdAt: new Date()
    };
    await db.collection('users').doc(id).set(userData); // use same id or choose new id

    // mark request approved
    await reqRef.update({ status: 'approved', approvedAt: new Date() });

    // refresh UI
    await loadRequests();
    await loadAccounts();
  } catch (err) {
    alert('Error approving request: ' + err.message);
  }
}

async function onReject(e) {
  const id = e.target.closest('[data-id]').dataset.id;
  try {
    await db.collection('accountRequests').doc(id).update({ status: 'rejected', rejectedAt: new Date() });
    await loadRequests();
  } catch (err) {
    alert('Error rejecting request: ' + err.message);
  }
}

async function onEditUser(e) {
  const id = e.target.closest('[data-id]').dataset.id;
  try {
    const doc = await db.collection('users').doc(id).get();
    if (!doc.exists) { alert('User not found'); return; }
    const data = doc.data();
    const newEmail = prompt('Edit email:', data.email || '') || data.email;
    const newRole = prompt('Edit role (admin / employee / user):', data.role || 'employee') || data.role;
    await db.collection('users').doc(id).update({ email: newEmail, role: newRole });
    await loadAccounts();
  } catch (err) {
    alert('Error editing user: ' + err.message);
  }
}

async function onDeleteUser(e) {
  const id = e.target.closest('[data-id]').dataset.id;
  if (!confirm('Delete this account? This cannot be undone.')) return;
  try {
    await db.collection('users').doc(id).delete();
    await loadAccounts();
  } catch (err) {
    alert('Error deleting user: ' + err.message);
  }
}

// utility
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}

// real-time updates for accounts
export function watchAccountsRealtime() {
  const container = document.getElementById('accounts');
  if (!container) return;
  db.collection('users').onSnapshot(snap => {
    const users = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    // sort admins first
    users.sort((a,b)=> (a.role===b.role)?(a.email||'').localeCompare(b.email||''):(a.role==='admin'?-1:1));
    container.innerHTML = users.map(u=>`
      <div class="user-item" data-id="${u.id}">
        <div class="user-main">
          <div class="user-name">${escapeHtml(u.username || u.email || '—')}</div>
          <div class="user-email">${escapeHtml(u.email || '—')}</div>
        </div>
        <div class="user-meta">
          <span class="user-role-badge">${escapeHtml(u.role || 'employee')}</span>
          <div class="user-actions">
            <button class="edit-btn action-btn">Edit</button>
            <button class="delete-btn action-btn">Delete</button>
          </div>
        </div>
      </div>
    `).join('');
  }, err => container.innerHTML = `<em>Error: ${err.message}</em>`);
}

// init — use realtime watchers for both requests and accounts
window.addEventListener('DOMContentLoaded', () => {
  // start realtime watchers (they auto-update the UI)
  watchRequestsRealtime();
  watchAccountsRealtime();
});