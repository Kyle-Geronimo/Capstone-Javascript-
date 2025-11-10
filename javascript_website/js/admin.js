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
      const username = docData.username || docData.email || '—';
      const initials = getInitials(username);
      const avatarColor = getAvatarColor(initials);
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
              <span class="user-note">Note: ${escapeHtml(docData.note || 'No additional notes')}</span>
              <span class="user-date">Requested: ${new Date(docData.timestamp?.seconds * 1000).toLocaleDateString() || 'Unknown date'}</span>
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
}document.addEventListener('DOMContentLoaded', () => {
});

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
        <div class="user-main">
          <div class="user-name">${escapeHtml(u.username || '—')}</div>
          <div class="user-email">${escapeHtml(u.email || '—')}</div>
          <div class="user-meta">
            <span class="user-role-badge ${u.role === 'admin' ? 'admin-role' : ''}">${escapeHtml(u.role || 'employee')}</span>
            <span class="user-id">User ID: ${escapeHtml(u.id)}</span>
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
      
      // Update Firestore document
      await updateDoc(userRef, {
        username: newUsername,
        role: newRole,
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

// Watch archived users in realtime
export function watchArchivedAccountsRealtime() {
  const container = document.getElementById('archived-accounts');
  if (!container) return;
  
  // Create a query to get all archived users
  const archivedUsersCol = collection(db, 'archivedUsers');
  
  // Set up real-time listener
  return onSnapshot(archivedUsersCol, snap => {
    if (snap.empty) {
      container.innerHTML = '<em>No archived users found.</em>';
      return;
    }

    // Map the documents to user objects and sort them
    const users = snap.docs.map(d => ({ id: d.id, ...d.data().userData }));
    users.sort((a, b) => (a.email || '').localeCompare(b.email || ''));

    // Update the UI with the archived user data
    container.innerHTML = users.map(u => `
      <div class="user-item" data-id="${u.id}">
        <div class="user-avatar" style="background: ${getAvatarColor(getInitials(u.username || u.email))}">
          ${u.photoURL ? 
            `<img src="${escapeHtml(u.photoURL)}" alt="${escapeHtml(u.username || '')}'s photo">` : 
            getInitials(u.username || u.email)
          }
        </div>
        <div class="user-main">
          <div class="user-name">${escapeHtml(u.username || u.email || '—')}</div>
          <div class="user-email">${escapeHtml(u.email || '—')}</div>
          <div class="user-meta">
            <span class="user-role-badge">${escapeHtml(u.role || 'employee')}</span>
            <span class="user-id">ID: ${escapeHtml(u.id)}</span>
            <span class="archive-date">Archived: ${new Date(u.archivedAt?.seconds * 1000).toLocaleDateString()}</span>
          </div>
        </div>
        <div class="user-actions">
          <button class="view-details-btn action-btn">View Details</button>
        </div>
      </div>
    `).join('');

    // Add event listeners for the view details buttons
    container.querySelectorAll('.view-details-btn').forEach(b => 
      b.addEventListener('click', onViewArchivedDetails));
  }, err => container.innerHTML = `<em>Error: ${escapeHtml(err.message)}</em>`);
}

async function onViewArchivedDetails(e) {
  const id = e.target.closest('[data-id]').dataset.id;
  try {
    // Get archived user data
    const archivedDoc = await getDoc(doc(db, 'archivedUsers', id));
    if (!archivedDoc.exists()) {
      alert('Archived user data not found');
      return;
    }

    const data = archivedDoc.data();
    const userData = data.userData;
    const attendanceData = data.attendanceData || [];

    // Create modal HTML
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

    // Add modal to document
    const modalContainer = document.createElement('div');
    modalContainer.innerHTML = modalHtml;
    document.body.appendChild(modalContainer);

    // Handle close button and backdrop click
    const closeBtn = document.getElementById('closeArchiveDetails');
    const backdrop = document.querySelector('.profile-edit-backdrop');

    const closeModal = () => modalContainer.remove();
    closeBtn.addEventListener('click', closeModal);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closeModal();
    });

  } catch (err) {
    console.error('Error viewing archived details:', err);
    alert('Error viewing archived details: ' + err.message);
  }
}

export function watchAccountsRealtime() {
  const container = document.getElementById('accounts');
  if (!container) return;
  
  // Create a query to get all users
  const usersCol = collection(db, 'users');
  
  // Set up real-time listener
  return onSnapshot(usersCol, snap => {
    // Map the documents to user objects and sort them
    const users = snap.docs.map(d => ({ id: d.id, ...d.data() }));
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
        <div class="user-main">
          <div class="user-name">${escapeHtml(u.username || u.email || '—')}</div>
          <div class="user-email">${escapeHtml(u.email || '—')}</div>
          <div class="employee-id-text">Employee ID: ${escapeHtml(u.employeeId || 'Not assigned')}</div>
          <div class="user-meta">
            <span class="user-role-badge ${u.role === 'admin' ? 'admin-role' : ''}">${escapeHtml(u.role || 'employee')}</span>
            <span class="user-id">ID: ${escapeHtml(u.id)}</span>
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
  }, err => container.innerHTML = `<em>Error: ${escapeHtml(err.message)}</em>`);
}

window.addEventListener('DOMContentLoaded', () => {
  // Initialize admin page components if they exist
  if (document.getElementById('requests')) {
    watchRequestsRealtime();
  }
  if (document.getElementById('accounts')) {
    watchAccountsRealtime();
  }
  if (document.getElementById('archived-accounts')) {
    watchArchivedAccountsRealtime();
  }
});
