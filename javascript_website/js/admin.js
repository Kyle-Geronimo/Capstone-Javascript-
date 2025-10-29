// admin.js (MODULAR - replace existing file)
import { auth, db } from './firebase-config.js';
import {
  collection, query, where, onSnapshot,
  updateDoc, doc, getDocs, getDoc, setDoc, deleteDoc,
  serverTimestamp  // add this import
} from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js';
import { 
  createUserWithEmailAndPassword, 
  getIdToken, 
  updateEmail, deleteUser 
} from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js';

// quick sanity log if SDK import didn't bind deleteDoc
if (typeof deleteDoc === 'undefined') {
  console.warn('firebase-firestore deleteDoc is not defined — check the import URL and network.');
}

export function watchRequestsRealtime() {
  const container = document.getElementById('requests');
  if (!container) return;
  // Remove where('status', '==', 'pending') to show all requests
  const q = collection(db, 'accountRequests');
  return onSnapshot(q, snapshot => {
    if (snapshot.empty) {
      container.innerHTML = '<em>No requests.</em>';
      return;
    }
    container.innerHTML = snapshot.docs.map(d => {
      const docData = d.data();
      return `
        <div class="request-item" data-id="${d.id}">
          <div><strong>${escapeHtml(docData.username || '—')}</strong> (${escapeHtml(docData.email || '—')})</div>
          <div class="request-meta">${escapeHtml(docData.note || '')}</div>
          <div class="request-actions">
            <button class="approve-btn action-btn">Approve</button>
            <button class="reject-btn action-btn">Reject</button>
          </div>
        </div>
      `;
    }).join('');
    container.querySelectorAll('.approve-btn').forEach(b => b.addEventListener('click', onApprove));
    container.querySelectorAll('.reject-btn').forEach(b => b.addEventListener('click', onReject));
  }, err => {
    container.innerHTML = `<em>Error: ${escapeHtml(err.message)}</em>`;
  });
}

export async function loadAccounts() {
  const container = document.getElementById('accounts');
  if (!container) return;
  try {
    const snap = await getDocs(collection(db, 'users'));
    if (snap.empty) {
      container.innerHTML = '<em>No accounts found.</em>';
      return;
    }
    const users = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    // Simple email sort instead of role-based
    users.sort((a, b) => (a.email || '').localeCompare(b.email || ''));

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
    // Get request data
    const reqRef = doc(db, 'accountRequests', id);
    const reqSnap = await getDoc(reqRef);
    if (!reqSnap.exists()) { alert('Request not found'); return; }
    const reqData = reqSnap.data();

    // Create Auth user
    const userCred = await createUserWithEmailAndPassword(auth, reqData.email, reqData.password);
    
    // Create users document
    await setDoc(doc(db, 'users', userCred.user.uid), {
      email: reqData.email,
      username: reqData.username,
      role: reqData.role || 'employee',
      createdAt: new Date()
    });

    // Delete the request
    await deleteDoc(reqRef);
    
    // UI will update automatically via realtime listener
  } catch (err) {
    console.error('Approval failed:', err);
    alert('Error approving request: ' + err.message);
  }
}

async function onReject(e) {
  const id = e.target.closest('[data-id]').dataset.id;
  try {
    const reqRef = doc(db, 'accountRequests', id);
    // Delete the request document instead of updating status
    await deleteDoc(reqRef);
    // UI will update automatically via realtime listener
  } catch (err) {
    console.error('Rejection failed:', err);
    alert('Error rejecting request: ' + err.message);
  }
}

async function onEditUser(e) {
  const id = e.target.closest('[data-id]').dataset.id;
  try {
    // Get current user data
    const userRef = doc(db, 'users', id);
    const docSnap = await getDoc(userRef);
    if (!docSnap.exists()) { 
      alert('User not found'); 
      return; 
    }
    const data = docSnap.data();
    
    // Get new username only
    const newUsername = prompt('Edit username:', data.username || '') || data.username;
    
    // Update Firestore document with just username
    await updateDoc(userRef, { 
      username: newUsername
    });
    
    await loadAccounts();
  } catch (err) {
    console.error('Edit failed:', err);
    alert('Error editing user: ' + err.message);
  }
}

async function onDeleteUser(e) {
  const id = e.target.closest('[data-id]').dataset.id;
  if (!confirm('Delete this account? This cannot be undone.')) return;
  
  try {
    const response = await fetch('http://localhost:3000/api/deleteUser', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ uid: id })
    });
    
    if (!response.ok) {
      throw new Error('Server returned ' + response.status);
    }
    
    await loadAccounts();
  } catch (err) {
    console.error('Delete failed:', err);
    alert('Error deleting user: ' + err.message);
  }
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}

export function watchAccountsRealtime() {
  const container = document.getElementById('accounts');
  if (!container) return;
  const usersCol = collection(db, 'users');
  return onSnapshot(usersCol, snap => {
    const users = snap.docs.map(d => ({ id: d.id, ...d.data() }));
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

    // attach handlers to the newly-rendered buttons
    container.querySelectorAll('.edit-btn').forEach(b => b.addEventListener('click', onEditUser));
    container.querySelectorAll('.delete-btn').forEach(b => b.addEventListener('click', onDeleteUser));
  }, err => container.innerHTML = `<em>Error: ${escapeHtml(err.message)}</em>`);
}

window.addEventListener('DOMContentLoaded', () => {
  watchRequestsRealtime();
  watchAccountsRealtime();
});

// Also update Firestore rules to allow all authenticated users to perform actions
// In Firebase Console → Firestore → Rules:
/*
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if request.auth != null;
    }
  }
}
*/
