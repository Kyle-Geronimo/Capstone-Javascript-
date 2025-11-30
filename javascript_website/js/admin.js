import { auth, db } from './firebase-config.js';
import {
  collection, query, where, onSnapshot, orderBy,
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
const API_BASE = (window.API_BASE && window.API_BASE.replace(/\/$/, '')) || 'https://mariners-hotellink.com';

export function watchRequestsRealtime() {
  const container = document.getElementById('requests');
  if (!container) return;

  // make admin lists scrollable and styled
  container.classList.add('admin-list');

  const q = collection(db, 'accountRequests');

  return onSnapshot(q, snapshot => {
    if (snapshot.empty) {
      container.innerHTML = '<em>No requests.</em>';
      return;
    }

    // helper to format timestamp values
    function formatTimestamp(v) {
      if (!v) return 'Unknown date';
      if (v.seconds !== undefined) return new Date(v.seconds * 1000).toLocaleString();
      if (typeof v === 'number') return new Date(v).toLocaleString();
      if (typeof v === 'string') return new Date(v).toLocaleString();
      if (v instanceof Date) return v.toLocaleString();
      return 'Unknown date';
    }

    container.innerHTML = snapshot.docs.map(d => {
      const docData = d.data();
      const username = docData.username || docData.email || 'Unknown';
      const initials = getInitials(username);
      const avatarColor = getAvatarColor(initials);

      const created = docData.createdAt || docData.timestamp || null;
      const createdStr = formatTimestamp(created);

      return `
        <div class="request-card" data-id="${d.id}">
          <div class="request-avatar" style="background:${avatarColor}">
            ${initials}
          </div>

          <div class="request-main">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
              <div>
                <div style="font-weight:700;">${escapeHtml(username)}</div>
                <div style="font-size:0.9rem;color:#4b5b7a;">${escapeHtml(docData.email || '')}</div>
              </div>

              <div style="text-align:right;">
                <div style="font-size:0.85rem;color:#7a889f;">Requested</div>
                <div style="font-weight:600;color:#123a80;">${escapeHtml(createdStr)}</div>
              </div>
            </div>

            <div class="request-meta">
              <span><strong>Role:</strong> ${escapeHtml(docData.role || 'employee')}</span>
              <span><strong>Dept:</strong> ${escapeHtml(docData.department || docData.dept || '—')}</span>
              <span><strong>Shift:</strong> ${escapeHtml(docData.shift || '—')}</span>
            </div>
          </div>

          <div class="request-actions">
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
    // Build users array correctly and include department & shift in UI
    const users = snap.docs.map(d => {
      const data = d.data() || {};
      return {
        id: d.id,
        username: data.username || data.displayName || data.email || '',
        email: data.email || '',
        role: data.role || 'employee',
        photoURL: data.photoURL || '',
        department: data.department || '',
        shift: data.shift || '',
        qrDataURI: data.qrDataURI || ''
      };
    });

    users.sort((a, b) => {
      if (a.role === b.role) return (a.email || '').localeCompare(b.email || '');
      return a.role === 'admin' ? -1 : 1;
    });

    // Render users list and include department & shift
    container.innerHTML = users.map(u => `
      <div class="user-item ${u.role === 'admin' ? 'admin-user' : ''}" data-id="${u.id}">
        <div class="user-left">
          <div class="user-avatar" style="background:${getAvatarColor(getInitials(u.username || u.email))}">
            ${u.photoURL ? `<img src="${escapeHtml(u.photoURL)}" alt="avatar" style="width:100%;height:100%;object-fit:cover;border-radius:8px" />` : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-weight:700;color:#fff">${getInitials(escapeHtml(u.username || u.email))}</div>`}
          </div>

          <div class="user-main">
            <div class="user-name">${escapeHtml(u.username || '—')}</div>
            <div class="user-email">${escapeHtml(u.email || '—')}</div>
            <div class="user-meta" style="font-size:12px;color:#666;margin-top:6px">
              <span class="user-role-badge ${u.role === 'admin' ? 'admin-role' : ''}">${escapeHtml(u.role || 'employee')}</span>
              <span style="margin-left:8px"><strong>Dept:</strong> ${escapeHtml(u.department || '—')}</span>
              <span style="margin-left:8px"><strong>Shift:</strong> ${escapeHtml(u.shift || '—')}</span>
            </div>
          </div>
        </div>

        <div style="display:flex;align-items:center;gap:12px">
          <div class="user-qr-display">
            ${u.qrDataURI ? `<img src="${escapeHtml(u.qrDataURI)}" alt="QR" class="user-qr-thumb clickable" data-qr="${escapeHtml(u.qrDataURI)}" />` : `<div class="user-qr-placeholder">No QR</div>`}
          </div>
          <div class="user-actions">
            <button class="edit-btn action-btn">Edit</button>
            <button class="archive-btn action-btn">Archive</button>
          </div>
        </div>
      </div>
    `).join('');



    container.querySelectorAll('.edit-btn').forEach(b => b.addEventListener('click', onEditUser));
    container.querySelectorAll('.archive-btn').forEach(b => b.addEventListener('click', onArchiveUser));
    // Attach QR thumbnail click handlers (open larger modal)
    container.querySelectorAll('.user-qr-thumb.clickable').forEach(img => {
      img.addEventListener('click', (e) => {
        const src = e.currentTarget.dataset.qr || e.currentTarget.src;
        if (src) showImageModal(src);
      });
    });
  } catch (err) {
    container.innerHTML = `<em>Error loading accounts: ${escapeHtml(err.message)}</em>`;
  }
}

// --- Add payroll view requests watcher + admin approve/deny handlers ---
export function watchPayrollViewRequests() {
  // ensure UI container exists (create right-column panel if not present)
  let panel = document.getElementById('payroll-requests-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'payroll-requests-panel';
    panel.className = 'requests-panel profile-card';
    panel.style.width = '360px';
    panel.style.marginLeft = '12px';
    panel.style.maxHeight = '80vh';
    panel.style.overflow = 'auto';
    const accountRequestsPanel = document.getElementById('account-requests-panel') || document.getElementById('requests-panel');
    if (accountRequestsPanel && accountRequestsPanel.parentNode) {
      accountRequestsPanel.parentNode.insertBefore(panel, accountRequestsPanel.nextSibling);
    } else {
      const main = document.querySelector('.content-container') || document.body;
      main.appendChild(panel);
    }
  }

  panel.innerHTML = `<h3>Payroll View Requests</h3><div id="payrollRequestsList">Loading...</div>`;

  const noticeEl = document.getElementById('adminPayrollNotice');
  const showPayrollAdminNotice = (message, tone = 'info') => {
    if (!noticeEl) return;
    noticeEl.textContent = message;
    noticeEl.className = `payroll-status payroll-status-${tone}`;
    noticeEl.style.display = message ? 'block' : 'none';
  };

  // only show pending requests to admins (approved/denied are not listed)
  // Query only by status (no orderBy) to avoid requiring a composite index while it builds.
  const q = query(
    collection(db, 'payrollViewRequests'),
    where('status', '==', 'pending')
  );
  const unsub = onSnapshot(q, snap => {
    const container = document.getElementById('payrollRequestsList');
    if (!container) return;
    if (snap.empty) {
      container.innerHTML = '<div class="request-item">No pending payroll view requests.</div>';
      return;
    }

    // Sort documents client-side by createdAt desc (handles Timestamp or number)
    const docs = snap.docs.slice().sort((a, b) => {
      const A = (a.data() && a.data().createdAt) ? (a.data().createdAt.toMillis ? a.data().createdAt.toMillis() : Number(a.data().createdAt)) : 0;
      const B = (b.data() && b.data().createdAt) ? (b.data().createdAt.toMillis ? b.data().createdAt.toMillis() : Number(b.data().createdAt)) : 0;
      return B - A;
    });

    container.innerHTML = docs.map(d => {
      const r = d.data() || {};
      const status = (r.status || 'pending');
      return `
        <div class="request-item" data-id="${d.id}" style="display:flex;align-items:center;justify-content:space-between;padding:8px;border-bottom:1px solid #eee">
          <div style="flex:1;min-width:0">
            <div style="font-weight:600">${escapeHtml(r.username || r.userId)}</div>
            <div style="font-size:12px;color:#666">${escapeHtml(r.department || '')} • ${escapeHtml(status)}</div>
          </div>
          <div style="display:flex;gap:6px;margin-left:8px">
            <button class="approve-request-btn action-btn small" data-id="${d.id}" data-uid="${escapeHtml(r.userId)}" data-username="${escapeHtml(r.username || r.userId)}" ${status==='approved' ? 'disabled' : ''}>Approve</button>
            <button class="deny-request-btn action-btn small" data-id="${d.id}" data-username="${escapeHtml(r.username || r.userId)}" ${status==='denied' ? 'disabled' : ''}>Deny</button>
          </div>
        </div>
      `;
    }).join('');

    container.querySelectorAll('.approve-request-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const requestId = btn.dataset.id;
        const uid = btn.dataset.uid;
        const username = btn.dataset.username || uid || 'this account';
        try {
          const reqRef = doc(db, 'payrollViewRequests', requestId);
          await updateDoc(reqRef, { status: 'approved', approvedBy: auth.currentUser.uid, approvedAt: serverTimestamp() });
          const userRef = doc(db, 'users', uid);
          await updateDoc(userRef, { payrollViewAllowed: true, payrollViewAllowedAt: serverTimestamp() });
          showPayrollAdminNotice(`Payroll view request approved for ${username}. They can now view their most recent payroll.`, 'success');
        } catch (err) {
          console.error('Approve failed', err);
          showPayrollAdminNotice('Failed to approve payroll request: ' + (err.message || err), 'error');
        }
      });
    });

    container.querySelectorAll('.deny-request-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const requestId = btn.dataset.id;
        const username = btn.dataset.username || 'this account';
        try {
          const reqRef = doc(db, 'payrollViewRequests', requestId);
          await updateDoc(reqRef, { status: 'denied', deniedBy: auth.currentUser.uid, deniedAt: serverTimestamp() });
          showPayrollAdminNotice(`Payroll view request denied for ${username}.`, 'error');
        } catch (err) {
          console.error('Deny failed', err);
          showPayrollAdminNotice('Failed to deny payroll request: ' + (err.message || err), 'error');
        }
      });
    });
  }, err => {
    console.error('payrollViewRequests listener failed', err);
    const container = document.getElementById('payrollRequestsList');
    if (container) {
      // If Firestore requires an index it typically includes a console URL in the error message.
      const msg = err && err.message ? String(err.message) : 'Failed to load requests';
      // extract first URL if present
      const urlMatch = msg.match(/https?:\/\/[^\s)]+/i);
      let html = `<div class="request-item">Failed to load requests: ${escapeHtml(msg)}</div>`;
      if (urlMatch && urlMatch[0]) {
        const link = urlMatch[0];
        html += `<div style="margin-top:8px;font-size:0.9rem;"><a href="${escapeHtml(link)}" target="_blank">Create required Firestore index</a></div>`;
      }
      container.innerHTML = html;
    }
  });

  return unsub;
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

    let adminPin = null;
    if ((reqData.role || 'employee') === 'admin') {
      function showAdminPinOverlayForApproval() {
        return new Promise((resolve, reject) => {
          const overlay = document.createElement('div');
          overlay.className = 'profile-edit-backdrop';

          overlay.innerHTML = `
            <div class="profile-edit-modal" style="max-width:360px;">
              <h3>Set Admin PIN</h3>
              <p style="margin-top:4px;margin-bottom:12px;font-size:0.9rem;color:#4b5563;">Enter a 6-digit PIN for this admin. This PIN will be used to unlock the QR Dashboard.</p>
              <div class="form-group" style="margin-bottom:12px;">
                <label for="approveAdminPin" class="form-label">Admin PIN</label>
                <input id="approveAdminPin" type="password" maxlength="6" inputmode="numeric" autocomplete="off" class="form-control" style="font-size:1.3rem;letter-spacing:0.4em;text-align:center;" />
                <div id="approveAdminPinError" style="min-height:18px;margin-top:6px;font-size:0.8rem;color:#b91c1c;"></div>
              </div>
              <div class="modal-actions">
                <button type="button" class="action-btn secondary" id="approveAdminPinCancel">Cancel</button>
                <button type="button" class="action-btn primary" id="approveAdminPinSubmit">Save PIN</button>
              </div>
            </div>
          `;

          document.body.appendChild(overlay);
          const input = document.getElementById('approveAdminPin');
          const errEl = document.getElementById('approveAdminPinError');
          const btnCancel = document.getElementById('approveAdminPinCancel');
          const btnSubmit = document.getElementById('approveAdminPinSubmit');

          function cleanup(value) {
            overlay.remove();
            if (value === null) reject(new Error('PIN entry cancelled')); else resolve(value);
          }

          function trySubmit() {
            let val = String(input.value || '').trim();
            if (!/^\d{6}$/.test(val)) {
              errEl.textContent = 'PIN must be exactly 6 digits (numbers only).';
              return;
            }
            cleanup(val);
          }

          btnCancel.addEventListener('click', () => cleanup(null));
          btnSubmit.addEventListener('click', trySubmit);
          overlay.addEventListener('click', (evt) => {
            if (evt.target === overlay) {
              cleanup(null);
            }
          });
          input.addEventListener('keydown', (evt) => {
            if (evt.key === 'Enter') {
              evt.preventDefault();
              trySubmit();
            }
          });

          setTimeout(() => { input.focus(); }, 30);
        });
      }

      try {
        adminPin = await showAdminPinOverlayForApproval();
      } catch (_) {
        alert('Admin PIN is required for admin accounts.');
        return;
      }
    }

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
        role: reqData.role || 'employee',
        pin: adminPin
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

// --- Initialize payroll requests watcher once globals are ready ---
(function initPayrollRequestsListener() {
  function waitForGlobals(names, timeout = 10000, interval = 100) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      (function poll() {
        const ok = names.every(n => window[n]);
        if (ok) return resolve();
        if (Date.now() - start >= timeout) return reject(new Error('globals not ready: ' + names.join(',')));
        setTimeout(poll, interval);
      })();
    });
  }

  (async () => {
    try {
      await waitForGlobals(['auth', 'db'], 10000, 150);
      // call the admin panel watcher if available
      if (typeof watchPayrollViewRequests === 'function') {
        watchPayrollViewRequests();
      } else {
        console.warn('watchPayrollViewRequests() not found in admin.js — make sure function exists and is exported/defined.');
      }
    } catch (err) {
      console.warn('Could not initialize payroll requests panel:', err);
    }
  })();
})();

// ---------- REPLACE old bootstrap block with this improved admin bootstrap ----------
(function bootstrapPayrollRequestsPanel_v2() {
  // create panel DOM immediately so admin sees something while we wait for firebase
  function ensurePanelDom() {
    let panel = document.getElementById('payroll-requests-panel');
    if (panel) return panel;

    const accountPanel = document.getElementById('account-requests-panel') || document.getElementById('requests-panel');
    panel = document.createElement('div');
    panel.id = 'payroll-requests-panel';
    panel.className = 'requests-panel profile-card';
    panel.style.width = '360px';
    panel.style.minWidth = '280px';
    panel.style.maxHeight = '78vh';
    panel.style.overflow = 'auto';
    panel.style.padding = '12px';
    panel.innerHTML = `<h3 style="margin:0 0 8px 0;">Payroll View Requests</h3><div id="payrollRequestsList">Waiting for admin auth...</div>`;

    if (accountPanel && accountPanel.parentNode) {
      accountPanel.parentNode.insertBefore(panel, accountPanel.nextSibling);
      console.log('Inserted payroll requests panel next to account-requests panel.');
    } else {
      const main = document.querySelector('.content-container') || document.querySelector('main') || document.body;
      main.appendChild(panel);
      console.log('Appended payroll requests panel to main container (fallback).');
    }
    return panel;
  }

  // short helper to wait for a window global, with small interval loop
  function waitForGlobal(name, timeout = 10000, interval = 150) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      (function poll() {
        if (window[name]) return resolve(window[name]);
        if (Date.now() - start >= timeout) return reject(new Error(`${name} not ready after ${timeout}ms`));
        setTimeout(poll, interval);
      })();
    });
  }

  (function init() {
    const panel = ensurePanelDom();
    const listEl = document.getElementById('payrollRequestsList');

    // If auth is not yet defined, use onAuthStateChanged (this will fire as soon as firebase-auth finishes initializing)
    // If auth is already present, we still use onAuthStateChanged to get reliable sign-in state.
    // If auth never becomes available, we fallback after 12s with a visible error message.
    const authReadyTimeout = 12000;
    let authReadyTimer = setTimeout(() => {
      console.warn('Auth not ready within timeout; payroll panel will display a message.');
      if (listEl) listEl.innerText = 'Unable to initialize payroll panel (auth not available).';
    }, authReadyTimeout);

    // Use whichever auth global exists (or wait until it appears)
    (function attachAuthListener() {
      // If auth exists now, attach listener
      if (window.auth && typeof window.auth.onAuthStateChanged === 'function') {
        clearTimeout(authReadyTimer);
        window.auth.onAuthStateChanged(async (user) => {
          try {
            if (!user) {
              // user not signed-in; show message but keep panel visible
              if (listEl) listEl.innerText = 'Sign in as admin to review payroll view requests.';
              console.log('Admin not signed-in; waiting for admin sign-in to load payroll requests.');
              return;
            }

            // user is signed-in; ensure db exists (short wait)
            let db = window.db;
            if (!db) {
              try {
                db = await waitForGlobal('db', 8000, 150); // wait up to 8s for db
              } catch (err) {
                console.error('Database (db) not available after sign-in:', err);
                if (listEl) listEl.innerText = 'Signed in but database not ready. Please reload or try again in a moment.';
                return;
              }
            }

            // At this point auth and db should be available; start the watcher
            if (typeof watchPayrollViewRequests === 'function') {
              // clear any placeholder text
              if (listEl) listEl.innerText = 'Loading payroll view requests...';
              try {
                watchPayrollViewRequests();
                console.log('watchPayrollViewRequests() started after auth sign-in.');
              } catch (err) {
                console.error('Error starting watchPayrollViewRequests():', err);
                if (listEl) listEl.innerText = 'Error starting payroll watcher. Check console for details.';
              }
            } else {
              // Try dynamic import fallback if the watch function is exported in a module file
              try {
                // Adjust the path below if your admin watcher is in a different module file
                const mod = await import('/path/to/admin.js');
                if (typeof mod.watchPayrollViewRequests === 'function') {
                  if (listEl) listEl.innerText = 'Loading payroll view requests...';
                  mod.watchPayrollViewRequests();
                  console.log('watchPayrollViewRequests() started via dynamic import.');
                } else {
                  console.warn('watchPayrollViewRequests() not found in module import.');
                  if (listEl) listEl.innerText = 'Payroll watcher not available (function missing).';
                }
              } catch (impErr) {
                console.error('Dynamic import fallback failed for admin.js:', impErr);
                if (listEl) listEl.innerText = 'Failed to start payroll watcher (import error).';
              }
            }
          } finally {
            // no-op
          }
        });
        return;
      }

      // If auth global doesn't exist yet, poll briefly for it (but we already have a timeout)
      waitForGlobal('auth', authReadyTimeout, 200).then(() => {
        clearTimeout(authReadyTimer);
        attachAuthListener(); // recursive: will attach now that auth exists
      }).catch(() => {
        // handled by outer timeout
      });
    })();
  })();
})();

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
