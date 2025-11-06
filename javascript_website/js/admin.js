import { auth, db } from './firebase-config.js';
import {
  collection, query, where, onSnapshot,
  updateDoc, doc, getDocs, getDoc, setDoc, deleteDoc,
  serverTimestamp, addDoc
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
      return `
        <div class="user-item request-item" data-id="${d.id}">
          <div class="user-avatar" style="background: ${getAvatarColor(getInitials(docData.username || docData.email))}">
            ${getInitials(docData.username || docData.email)}
          </div>
          <div class="user-main">
            <div class="user-name">${escapeHtml(docData.username || docData.email || '—')}</div>
            <div class="user-email">${escapeHtml(docData.email || '—')}</div>
            <div class="user-meta">
              <span class="user-role-badge">Pending</span>
              <span class="request-note">${escapeHtml(docData.note || 'No additional notes')}</span>
              <span class="request-date">Requested: ${new Date(docData.timestamp?.seconds * 1000).toLocaleDateString() || 'Unknown date'}</span>
            </div>
          </div>
          <div class="user-actions request-actions">
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

// Calculate and save payroll data
async function computeAndStorePayroll(month, period) {
    try {
        const year = new Date().getFullYear();
        const startDay = period === '1-15' ? 1 : 16;
        const endDay = period === '1-15' ? 15 : new Date(year, month, 0).getDate();
        const startDate = new Date(year, month - 1, startDay).toISOString().split('T')[0];
        const endDate = new Date(year, month - 1, endDay).toISOString().split('T')[0];

        // Get all employees
        const usersSnap = await getDocs(collection(db, 'users'));
        const employees = usersSnap.docs
            .filter(doc => doc.data().role !== 'admin')
            .map(doc => ({
                id: doc.id,
                ...doc.data()
            }));

        // Get attendance records for the period
        const attendanceRef = collection(db, 'attendance');
        const attendanceQuery = query(attendanceRef, 
            where('date', '>=', startDate),
            where('date', '<=', endDate)
        );
        const attendanceSnap = await getDocs(attendanceQuery);
        const attendanceRecords = attendanceSnap.docs.map(doc => doc.data());

        // Process each employee's payroll
        const payrollRecords = [];
        for (const employee of employees) {
            const employeeAttendance = attendanceRecords.filter(record => 
                record.userId === employee.id
            );

            // Calculate totals
            let totalDays = 0;
            let totalOTHours = 0;
            let totalNightHours = 0;
            let totalRegHolHours = 0;

            employeeAttendance.forEach(record => {
                // Calculate regular days
                if (record.checkinTime && record.checkoutTime) {
                    totalDays++;
                }

                // Add overtime hours
                totalOTHours += record.otHours || 0;

                // Add night differential hours (10 PM to 6 AM)
                const nightHours = calculateNightHours(record.checkinTime, record.checkoutTime);
                totalNightHours += nightHours;

                // Add regular holiday hours if applicable
                totalRegHolHours += record.regHolHours || 0;
            });

            // Calculate pay
            const rate = Number(employee.rate || 0);
            const basic = rate * totalDays;
            const nightAmount = rate * 0.1 * (totalNightHours / 8); // Night differential is 10%
            const otAmount = (rate / 8) * 1.25 * totalOTHours; // OT is 1.25x
            const regHolAmount = (rate / 8) * totalRegHolHours;
            const gross = basic + nightAmount + otAmount + regHolAmount;

            // Deductions
            const sssEmployee = Math.round((gross * 0.05) * 100) / 100; // 5%
            const sssEmployer = Math.round((gross * 0.10) * 100) / 100; // 10%
            const otherDeductions = 0;
            const net = gross - sssEmployee - otherDeductions;

            // Create payroll record
            const payrollRecord = {
                employeeId: employee.id,
                employeeName: employee.username || employee.email,
                period: `${year}-${month.toString().padStart(2, '0')}-${period}`,
                rate,
                daysWorked: totalDays,
                basic,
                nightHours: totalNightHours,
                nightAmount,
                otHours: totalOTHours,
                otAmount,
                regHolHours: totalRegHolHours,
                regHolAmount,
                gross,
                sssEmployee,
                sssEmployer,
                otherDeductions,
                net,
                computedAt: new Date().toISOString(),
                status: 'pending' // pending, approved, paid
            };

            payrollRecords.push(payrollRecord);
        }

        // Store in Firestore
        const payrollRef = collection(db, 'payroll');
        const batchId = `${year}-${month.toString().padStart(2, '0')}-${period}`;
        
        // Store batch info
        await setDoc(doc(db, 'payrollBatches', batchId), {
            year,
            month,
            period,
            computedAt: new Date().toISOString(),
            totalEmployees: payrollRecords.length,
            totalNet: payrollRecords.reduce((sum, record) => sum + record.net, 0),
            status: 'pending'
        });

        // Store individual records
        for (const record of payrollRecords) {
            await addDoc(payrollRef, {
                ...record,
                batchId
            });
        }

        // Update the payroll table
        updatePayrollTable(payrollRecords);

        return { success: true, message: `Computed and stored payroll for ${payrollRecords.length} employees` };
    } catch (error) {
        console.error('Error computing payroll:', error);
        return { success: false, message: 'Error computing payroll: ' + error.message };
    }
}

// Calculate night shift hours
function calculateNightHours(checkinTime, checkoutTime) {
    if (!checkinTime || !checkoutTime) return 0;

    const checkin = new Date(checkinTime);
    const checkout = new Date(checkoutTime);
    
    // Night hours are from 10 PM (22:00) to 6 AM (06:00)
    let nightHours = 0;
    
    // Set time ranges for night differential
    const nightStart = new Date(checkin);
    nightStart.setHours(22, 0, 0);
    const nightEnd = new Date(checkin);
    nightEnd.setHours(29, 0, 0); // 29 hours means 5 AM next day

    // Calculate overlap with night hours
    const start = Math.max(checkin.getTime(), nightStart.getTime());
    const end = Math.min(checkout.getTime(), nightEnd.getTime());
    
    if (end > start) {
        nightHours = (end - start) / (1000 * 60 * 60);
    }

    return Math.round(nightHours * 100) / 100;
}

// Display payroll data in table
function updatePayrollTable(records) {
    const tbody = document.querySelector('#payrollTable tbody');
    if (!tbody) return;

    tbody.innerHTML = records.map((record, index) => `
        <tr>
            <td>${index + 1}</td>
            <td>${escapeHtml(record.employeeName)}</td>
            <td>${record.rate.toFixed(2)}</td>
            <td>${record.daysWorked}</td>
            <td>${record.basic.toFixed(2)}</td>
            <td>${record.nightHours.toFixed(2)}</td>
            <td>${record.nightAmount.toFixed(2)}</td>
            <td>${record.otHours.toFixed(2)}</td>
            <td>${record.otAmount.toFixed(2)}</td>
            <td>${record.regHolHours.toFixed(2)}</td>
            <td>${record.regHolAmount.toFixed(2)}</td>
            <td>${record.gross.toFixed(2)}</td>
            <td>${record.sssEmployee.toFixed(2)}</td>
            <td>${record.sssEmployer.toFixed(2)}</td>
            <td>${record.otherDeductions.toFixed(2)}</td>
            <td>${record.net.toFixed(2)}</td>
        </tr>
    `).join('');
}

// Function to generate random time between two times
function randomTime(start, end) {
  const startTime = start.getTime();
  const endTime = end.getTime();
  const randomTime = startTime + Math.random() * (endTime - startTime);
  return new Date(randomTime);
}

// NOTE: The sample data generation feature and its UI button were removed per request.
// The helper utilities used for generating test data remain if needed elsewhere.

// Initialize event listeners
document.addEventListener('DOMContentLoaded', () => {
    // Initialize month select
    const monthSelect = document.getElementById('monthSelect');
    if (monthSelect) {
        const months = ['January', 'February', 'March', 'April', 'May', 'June', 
                       'July', 'August', 'September', 'October', 'November', 'December'];
        monthSelect.innerHTML = months.map((month, index) => 
            `<option value="${index + 1}">${month}</option>`
        ).join('');
        monthSelect.value = new Date().getMonth() + 1;
    }

  // NOTE: Removed sample data generation button/event hookup as feature was removed.

    // Compute payroll button
    const computePayrollBtn = document.getElementById('computePayroll');
    if (computePayrollBtn) {
        computePayrollBtn.addEventListener('click', async () => {
            const month = parseInt(monthSelect.value);
            const period = document.getElementById('periodSelect').value;

            computePayrollBtn.disabled = true;
            computePayrollBtn.textContent = 'Computing...';

            try {
                const result = await computeAndStorePayroll(month, period);
                alert(result.message);
            } catch (error) {
                console.error('Error:', error);
                alert('Error computing payroll: ' + error.message);
            } finally {
                computePayrollBtn.disabled = false;
                computePayrollBtn.textContent = 'Compute Payroll';
            }
        });
    }
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
          <div class="employee-id-text">Employee ID: ${escapeHtml(u.employeeId || 'Not assigned')}</div>
          <div class="user-meta">
            <span class="user-role-badge ${u.role === 'admin' ? 'admin-role' : ''}">${escapeHtml(u.role || 'employee')}</span>
            <span class="user-id">ID: ${escapeHtml(u.id)}</span>
          </div>
        </div>
        <div class="user-actions">
          <button class="edit-btn action-btn">Edit</button>
          <button class="delete-btn action-btn">Delete</button>
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
    
    // Generate unique employee ID (XXX-XXX format)
    const generateEmployeeId = () => {
      const nums = Array.from({ length: 6 }, () => Math.floor(Math.random() * 10));
      return `${nums.slice(0, 3).join('')}-${nums.slice(3).join('')}`;
    };
    const employeeId = generateEmployeeId();

    // Create users document with employee ID
    await setDoc(doc(db, 'users', userCred.user.uid), {
      email: reqData.email,
      username: reqData.username,
      role: reqData.role || 'employee',
      createdAt: new Date(),
      employeeId: employeeId
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

async function onDeleteUser(e) {
  const id = e.target.closest('[data-id]').dataset.id;
  if (!confirm('Delete this account? This cannot be undone.')) return;
  
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

    // Get payroll records
    const payrollRef = collection(db, 'payroll');
    const payrollQuery = query(payrollRef, where('userId', '==', id));
    const payrollSnap = await getDocs(payrollQuery);
    const payrollData = payrollSnap.docs.map(doc => doc.data());

    // Create archive document with all user data
    const archiveData = {
      userData: userData,
      attendanceData: attendanceData,
      payrollData: payrollData,
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

    // Remove payroll records
    for (const doc of payrollSnap.docs) {
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
          <div class="employee-id-text">Employee ID: ${escapeHtml(u.employeeId || 'Not assigned')}</div>
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


