import { auth, db } from './firebase-config.js';
import {
  collection, query, where, onSnapshot,
  updateDoc, doc, getDocs, getDoc, setDoc, deleteDoc,
  serverTimestamp
} from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js';
// Generate user initials
function getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length > 1) {
    return (parts[0][0] + parts[parts.length-1][0]).toUpperCase();
  }
  return parts[0][0].toUpperCase();
}

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
import { getIdToken, signInWithEmailAndPassword } from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js';

// quick sanity log if SDK import didn't bind deleteDoc
if (typeof deleteDoc === 'undefined') {
  console.warn('firebase-firestore deleteDoc is not defined — check the import URL and network.');
}

// API base URL - set `window.API_BASE` on the page if you run the admin API on a different host/port.
const API_BASE = (window.API_BASE && window.API_BASE.replace(/\/$/, '')) || 'http://localhost:3000';

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
      const username = docData.username || docData.email || '—';
      const initials = getInitials(username);
      const avatarColor = getAvatarColor(initials);
      // determine created/posted timestamp (supports `createdAt` or `timestamp` fields)
      const created = docData.createdAt || docData.timestamp || docData.createdAtMillis || null;
      function formatTimestamp(v) {
        if (!v) return 'Unknown date';
        // Firestore Timestamp
        if (v.seconds !== undefined) return new Date(v.seconds * 1000).toLocaleString();
        // milliseconds number
        if (typeof v === 'number') return new Date(v).toLocaleString();
        // ISO string
        if (typeof v === 'string') return new Date(v).toLocaleString();
        // Date object
        if (v instanceof Date) return v.toLocaleString();
        return 'Unknown date';
      }
      const createdStr = formatTimestamp(created);

      return `
        <div class="user-item request-item" data-id="${d.id}">
          <div class="user-avatar" style="background: ${avatarColor}">
            ${initials}
          </div>
          <div class="user-main">
            <div class="user-name">${escapeHtml(username)}</div>
            <div class="user-email">${escapeHtml(docData.email || '—')}</div>
            <div class="user-meta">
              <span class="user-role-badge pending-role">${docData.role || 'employee'} (Pending)</span>
              <span class="user-note"><strong>Note:</strong> ${escapeHtml(docData.note || 'No additional notes')}</span>
              <span class="user-date"><strong>Requested:</strong> ${escapeHtml(createdStr)}</span>
            </div>
          </div>
          <div class="user-actions">
            <button class="approve-btn action-btn primary">Approve</button>
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

// Function to generate random time between two times
function randomTime(start, end) {
    const startTime = start.getTime();
    const endTime = end.getTime();
    const randomTime = startTime + Math.random() * (endTime - startTime);
    return new Date(randomTime);
}

/* ==================================================
  SECTION: User Account (Account Requests)
  - Functions that operate on incoming account requests
  - Approve / Reject flows live here
  ================================================== */


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
    // Sort by role first (admins first), then by email
    users.sort((a, b) => {
      if (a.role === b.role) return (a.email || '').localeCompare(b.email || '');
      return a.role === 'admin' ? -1 : 1;
    });

    container.innerHTML = users.map(u => `
      <div class="user-item ${u.role === 'admin' ? 'admin-user' : ''}" data-id="${u.id}">
        <div class="user-avatar" style="background: ${getAvatarColor(getInitials(u.username || u.email))}">
          ${u.photoURL ? 
            `<img src="${escapeHtml(u.photoURL)}" alt="${escapeHtml(u.username || '')}'s photo">` : 
            getInitials(u.username || u.email)
          }
        </div>
        <div class="user-qr-display">
          ${u.qrDataURI
            ? `<img src="${escapeHtml(u.qrDataURI)}" data-qr="${escapeHtml(u.qrDataURI)}" alt="QR for ${escapeHtml(u.username || u.email || '')}" class="user-qr-thumb clickable" />`
            : `<div class="user-qr-thumb user-qr-placeholder">QR</div>`}
        </div>
        <div class="user-main">
          <div class="user-name">${escapeHtml(u.username || '—')}</div>
          <div class="user-email">${escapeHtml(u.email || '—')}</div>
          <div class="user-meta">
            <span class="user-role-badge ${u.role === 'admin' ? 'admin-role' : ''}">${escapeHtml(u.role || 'employee')}</span>
            <span class="user-id"><strong>User ID:</strong> ${escapeHtml(u.id)}</span>
          </div>
        </div>
        <div class="user-actions">
          <button class="edit-btn action-btn">Edit</button>
          <button class="archive-btn action-btn">Archive</button>
        </div>
      </div>
    `).join('');



    container.querySelectorAll('.edit-btn').forEach(b => b.addEventListener('click', onEditUser));
    container.querySelectorAll('.archive-btn').forEach(b => b.addEventListener('click', onArchiveUser));
    // Attach QR thumbnail click handlers (open larger modal)
    container.querySelectorAll('.user-qr-thumb.clickable').forEach(img => {
      img.addEventListener('click', (e) => {
        const src = e.currentTarget.dataset.qr;
        if (src) showImageModal(src);
      });
    });
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

    // Validate email format before creating user
    const email = (reqData.email || '').trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      alert('Invalid email format: ' + email);
      return;
    }

    // Call backend API to create user as an admin action.
    // Use the current admin's ID token in the Authorization header so
    // the server can perform creation using the Admin SDK and NOT
    // return any session/auth tokens that would sign the client in.
    let currentUser = auth.currentUser;
    // If there's no signed-in admin, prompt for credentials so the approver
    // can sign in without leaving the page. This allows approving requests
    // even when the admin session expired.
    if (!currentUser) {
      const adminEmail = prompt('You must sign in as an admin to approve requests. Enter admin email:');
      if (!adminEmail) return;
      const adminPass = prompt('Enter admin password:');
      if (!adminPass) return;
      try {
        await signInWithEmailAndPassword(auth, adminEmail.trim(), adminPass);
        // give auth state a moment to settle
        currentUser = auth.currentUser;
      } catch (e) {
        console.error('Admin sign-in failed:', e);
        alert('Sign-in failed: ' + (e.message || e));
        return;
      }
    }
    const token = await getIdToken(currentUser, true);

    const response = await fetch(`${API_BASE}/api/createUser`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        email: email,
        password: reqData.password,
        username: reqData.username,
        role: reqData.role || 'employee'
      })
    });

    if (!response.ok) {
      // Attempt to read error message or body for debugging
      let errMsg = `Failed to create user (status ${response.status})`;
      try {
        const text = await response.text();
        // try parse json
        try { const errData = JSON.parse(text); errMsg = errData.error || errData.message || errMsg; }
        catch { if (text) errMsg = `${errMsg}: ${text}`; }
      } catch (_) {}
      console.error('createUser response not OK:', response.status, response.statusText);
      throw new Error(errMsg);
    }

    // Delete the request from Firestore
    await deleteDoc(reqRef);
    
    // Refresh the requests list
    watchRequestsRealtime();
    // confirm admin session didn't change
    const afterUid = auth.currentUser?.uid;
    if (afterUid !== currentUser.uid) {
      console.warn('Auth session changed after approval. before:', currentUser.uid, 'after:', afterUid);
      alert('Account created but your session changed unexpectedly. Please sign in again as admin.');
    } else {
      alert('Account approved successfully!');
    }
  } catch (err) {
    console.error('Approval failed:', err);
    alert('Error approving request: ' + err.message);
  }
}

/* ==================================================
   SECTION: User Management
   - Loading, editing, archiving active accounts
   ================================================== */

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
    
    // Create a modal for editing user details
    const modalHtml = `
      <div class="profile-edit-backdrop">
        <div class="profile-edit-modal">
          <h3>Edit User</h3>
          <form class="profile-edit-form" id="editUserForm">
            <div class="form-group">
              <label for="editUsername" class="form-label">Username</label>
              <input type="text" id="editUsername" class="form-control" value="${escapeHtml(data.username || '')}" placeholder="Enter username">
            </div>

            <div class="form-group">
              <label for="editRole" class="form-label">Role</label>
              <select id="editRole" class="form-control">
                <option value="employee" ${data.role === 'employee' ? 'selected' : ''}>Employee</option>
                <option value="admin" ${data.role === 'admin' ? 'selected' : ''}>Admin</option>
              </select>
            </div>

            <!-- NEW: Department -->
            <div class="form-group">
              <label for="editDepartment" class="form-label">Department</label>
              <select id="editDepartment" class="form-control">
                <option value="">— select department —</option>
                <option value="Bicotels Hotel" ${data.department === 'Bicotels Hotel' ? 'selected' : ''}>Bicotels Hotel</option>
                <option value="D'Mariners Inn Hotel" ${data.department === "D'Mariners Inn Hotel" ? 'selected' : ''}>D'Mariners Inn Hotel</option>
                <option value="Wennrod Hotel" ${data.department === 'Wennrod Hotel' ? 'selected' : ''}>Wennrod Hotel</option>
              </select>
            </div>

            <!-- NEW: Shift -->
            <div class="form-group">
              <label for="editShift" class="form-label">Shift</label>
              <select id="editShift" class="form-control">
                <option value="">— select shift —</option>
                <option value="morning" ${data.shift === 'morning' ? 'selected' : ''}>Morning (06:00—13:59)</option>
                <option value="mid" ${data.shift === 'mid' ? 'selected' : ''}>Mid (14:00—21:59)</option>
                <option value="night" ${data.shift === 'night' ? 'selected' : ''}>Night (22:00—05:59)</option>
              </select>
            </div>

            <div class="modal-actions">
              <button type="button" class="action-btn secondary" id="cancelEdit">Cancel</button>
              <button type="submit" class="action-btn primary">Save Changes</button>
            </div>
          </form>
        </div>
      </div>
    `;
    
    // Add modal to document
    const modalContainer = document.createElement('div');
    modalContainer.innerHTML = modalHtml;
    document.body.appendChild(modalContainer);
    
    // Handle form submission
    const form = document.getElementById('editUserForm');
    const backdrop = document.querySelector('.profile-edit-backdrop');
    const cancelBtn = document.getElementById('cancelEdit');
    
    // Close modal function
    const closeModal = () => {
      modalContainer.remove();
    };
    
    // Handle cancel
    cancelBtn.addEventListener('click', closeModal);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closeModal();
    });
    
    // Handle form submission
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const newUsername = document.getElementById('editUsername').value.trim();
      const newRole = document.getElementById('editRole').value;
      
      if (!newUsername) {
        alert('Username cannot be empty');
        return;
      }
      
      // Start update process
      console.log('Updating user with new role:', newRole);

      const newDepartment = document.getElementById('editDepartment').value || '';
      const newShift = document.getElementById('editShift').value || '';

      // Update Firestore document (include department + shift)
      await updateDoc(userRef, {
        username: newUsername,
        role: newRole,
        department: newDepartment,
        shift: newShift,
        updatedAt: serverTimestamp()
      });

      console.log('User update successful');
      closeModal();
    });
    
  } catch (err) {
    console.error('Edit failed:', err);
    alert('Error editing user: ' + err.message);
  }
}

async function onArchiveUser(e) {
  const id = e.target.closest('[data-id]').dataset.id;
  if (!confirm('Archive this account? The account will be deactivated and all its data will be moved to the archives. This action cannot be undone.')) return;
  
  try {
    // First delete the user document from Firestore
    // Get user data before archiving
    const userDoc = await getDoc(doc(db, 'users', id));
    const userData = userDoc.data();

    // Get attendance records
    const attendanceRef = collection(db, 'attendance');
    const attendanceQuery = query(attendanceRef, where('userId', '==', id));
    const attendanceSnap = await getDocs(attendanceQuery);
    const attendanceData = attendanceSnap.docs.map(doc => doc.data());

    // Create archive document with all user data
    const archiveData = {
      userData: userData,
      attendanceData: attendanceData,
      archivedAt: serverTimestamp(),
      archivedBy: auth.currentUser.uid
    };

    // Add to archived users collection
    await setDoc(doc(db, 'archivedUsers', id), archiveData);

    // Remove user from active collections
    await deleteDoc(doc(db, 'users', id));
    
    // Remove attendance records
    for (const doc of attendanceSnap.docs) {
      await deleteDoc(doc.ref);
    }

    // Disable the user account in Firebase Auth
    const currentUser = auth.currentUser;
    if (!currentUser) throw new Error('Not authenticated');
    const token = await getIdToken(currentUser, true);
    
    const response = await fetch('https://us-central1-mariners-hotellink.cloudfunctions.net/disableUser', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ uid: id })
    });
    
    if (!response.ok) {
      throw new Error('Failed to disable user authentication');
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
  
  // Create a query to get all users
  const usersCol = collection(db, 'users');
  
  // Set up real-time listener
  return onSnapshot(usersCol, snap => {
    // Map the documents to user objects and sort them
    const users = snap.docs.map(d => {
      const data = d.data() || {};
      return {
        id: d.id,
        username: data.username || '',
        email: data.email || '',
        role: data.role || '',
        department: data.department || '',
        shift: data.shift || '',
        qrDataURI: data.qrDataURI || '',
        employeeId: data.employeeId || '',
        photoURL: data.photoURL || ''
      };
    });
    users.sort((a, b) => {
      if (a.role === b.role) {
        return (a.email || '').localeCompare(b.email || '');
      }
      return a.role === 'admin' ? -1 : 1;
    });

    // Update the UI with the latest user data
    container.innerHTML = users.map(u => `
      <div class="user-item ${u.role === 'admin' ? 'admin-user' : ''}" data-id="${u.id}">
        <div class="user-avatar" style="background: ${getAvatarColor(getInitials(u.username || u.email))}">
          ${u.photoURL ? 
            `<img src="${escapeHtml(u.photoURL)}" alt="${escapeHtml(u.username || '')}'s photo">` : 
            getInitials(u.username || u.email)
          }
        </div>
        <div class="user-qr-display">
          ${u.qrDataURI
            ? `<img src="${escapeHtml(u.qrDataURI)}" alt="QR for ${escapeHtml(u.username || u.email || '')}" class="user-qr-thumb" />`
            : `<div class="user-qr-thumb user-qr-placeholder">QR</div>`}
        </div>
        <div class="user-main">
          <div class="user-name">${escapeHtml(u.username || u.email || '—')}</div>
          <div class="user-email">${escapeHtml(u.email || '—')}</div>
          <div class="employee-id-text"><strong>Employee ID:</strong> ${escapeHtml(u.employeeId || 'Not assigned')}</div>

          <!-- NEW: show department and shift -->
          <div class="user-extra">
            <span class="user-dept"><strong>Dept:</strong> ${escapeHtml(u.department || '—')}</span>
            <span class="user-shift"><strong>Shift:</strong> ${escapeHtml(u.shift || '—')}</span>
          </div>

          <div class="user-meta">
            <span class="user-role-badge ${u.role === 'admin' ? 'admin-role' : ''}">${escapeHtml(u.role || 'employee')}</span>
            <span class="user-id"><strong>ID:</strong> ${escapeHtml(u.id)}</span>
          </div>
        </div>
        <div class="user-actions">
          <button class="edit-btn action-btn">Edit</button>
          <button class="archive-btn action-btn">Archive</button>
        </div>
      </div>
    `).join('');
    // Reattach event listeners to the buttons
    container.querySelectorAll('.edit-btn').forEach(b => b.addEventListener('click', onEditUser));
    container.querySelectorAll('.archive-btn').forEach(b => b.addEventListener('click', onArchiveUser));
    // Attach QR thumbnail click handlers (open larger modal)
    container.querySelectorAll('.user-qr-thumb.clickable').forEach(img => {
      img.addEventListener('click', (e) => {
        const src = e.currentTarget.dataset.qr;
        if (src) showImageModal(src);
      });
    });
  }, err => container.innerHTML = `<em>Error: ${escapeHtml(err.message)}</em>`);
}

// Initialize admin page components when DOM is ready
window.addEventListener('DOMContentLoaded', () => {
  if (document.getElementById('requests')) {
    watchRequestsRealtime();
  }
  if (document.getElementById('accounts')) {
    watchAccountsRealtime();
  }
});

// -------------------- Image Modal Helper --------------------
function showImageModal(src) {
  const backdrop = document.createElement('div');
  backdrop.className = 'image-modal-backdrop';
  backdrop.innerHTML = `
    <div class="image-modal-content">
      <button class="image-modal-close" aria-label="Close">✕</button>
      <img src="${escapeHtml(src)}" alt="QR image" />
    </div>
  `;
  document.body.appendChild(backdrop);

  function remove() { backdrop.remove(); window.removeEventListener('keydown', onKey); }
  function onKey(e) { if (e.key === 'Escape') remove(); }

  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) remove(); });
  backdrop.querySelector('.image-modal-close').addEventListener('click', remove);
  window.addEventListener('keydown', onKey);
}
