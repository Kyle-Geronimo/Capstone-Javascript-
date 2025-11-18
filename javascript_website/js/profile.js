import { auth, db } from './firebase-config.js';
import { doc, getDoc, updateDoc } from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js';
import { signOut } from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js';

// Escape HTML characters
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}

// Generate user initials
function getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length > 1) {
    // Use first letter of first and last name
    return (parts[0][0] + parts[parts.length-1][0]).toUpperCase();
  }
  // Single word - use first letter
  return parts[0][0].toUpperCase();
}

// Generate avatar color
function getAvatarColor(initials) {
  const colors = [
    'linear-gradient(135deg, #4f8cff 0%, #6ed6ff 100%)',  // blue (default)
    'linear-gradient(135deg, #ff4f8c 0%, #ff6ed6 100%)',  // pink
    'linear-gradient(135deg, #4fff8c 0%, #6effd6 100%)',  // green
    'linear-gradient(135deg, #8c4fff 0%, #d66eff 100%)',  // purple
    'linear-gradient(135deg, #ff8c4f 0%, #ffd66e 100%)'   // orange
  ];
  
    const index = initials.split('')
    .reduce((acc, char) => acc + char.charCodeAt(0), 0) % colors.length;
  
  return colors[index];
}

function formatTimestamp(ts) {
  if (!ts) return '—';
  try {
    const d = (typeof ts.toDate === 'function') ? ts.toDate() : new Date(ts);
    return d.toLocaleString();
  } catch {
    return String(ts);
  }
}

export async function loadProfile(uid) {
  const container = document.getElementById('profile-info');
  if (!container) {
    console.error('Profile container not found');
    return;
  }

  try {
    const ref = doc(db, 'users', uid);
    const snap = await getDoc(ref);
    
    if (!snap.exists()) {
      container.innerHTML = '<div class="profile-card"><em>Profile not found</em></div>';
      return;
    }

    const data = snap.data();
    const email = data.email || '';
    const username = data.username || email.split('@')[0];
    const role = data.role || 'user';

    const initials = getInitials(username);
    const avatarColor = getAvatarColor(initials);

    container.innerHTML = `
      <div class="profile-card">
        <div class="id-header">
          <h2>Employee Profile</h2>
          <p>D' Mariners Inn Hotel</p>
        </div>
        
        <div class="profile-avatar id-photo" style="background: ${avatarColor}">
          ${data.photoURL ? `<img src="${escapeHtml(data.photoURL)}" alt="${escapeHtml(username)}'s photo">` : initials}
        </div>

        <div class="info-group">
          <div class="info-label">Name:</div>
          <h3 id="profile-username">${escapeHtml(username)}</h3>
        </div>

        <div class="id-info">
          <div class="info-group">
            <div class="info-label">Role:</div>
            <div class="id-value">${escapeHtml(role)}</div>
          </div>

          <!-- Employee ID section removed -->

          <div class="info-group">
            <div class="info-label">Joined:</div>
            <div class="id-value">${formatTimestamp(data.createdAt || new Date())}</div>
          </div>
        </div>

        <div class="profile-actions">
          <button id="edit-profile-btn" class="action-btn primary">Edit Profile</button>
          <button id="logout-btn-card" class="action-btn secondary">Logout</button>
        </div>
      </div>
      
      <div class="email-section">
        <p class="email-label">Contact Email:</p>
        <p class="email-value">${escapeHtml(email)}</p>
      </div>
    `;

    // Get button references AFTER adding them to DOM
    const editBtn = document.getElementById('edit-profile-btn');
    const logoutBtn = document.getElementById('logout-btn-card');

    // Attach event handlers
    if (logoutBtn) {
      logoutBtn.addEventListener('click', async () => {
        try {
          await signOut(auth);
          window.location.href = '../index.html';
        } catch (err) {
          console.error('Logout failed:', err);
          alert('Logout failed: ' + err.message);
        }
      });
    }
    if (editBtn) {
      editBtn.addEventListener('click', () => {
        openEditModal({
          username: data.username,
          photoURL: data.photoURL
        }, async (newName, newPhotoURL) => {
          try {
            const updates = {};
            if (newName) updates.username = newName;
            if (typeof newPhotoURL !== 'undefined') {
              updates.photoURL = newPhotoURL || null;
            }

            await updateDoc(ref, updates);
            // Reload profile to show updates
            await loadProfile(uid);
          } catch (err) {
            console.error('Update failed:', err);
            alert('Unable to update profile: ' + err.message);
          }
        });
      });
    }

  } catch (err) {
    console.error('Profile load error:', err);
    container.innerHTML = `<div class="profile-card"><em>Error loading profile: ${escapeHtml(err.message)}</em></div>`;
  }
}

// Attach profile event handlers
function attachEventHandlers(data, ref) {
  // Attach logout handler
  const logoutBtnCard = document.getElementById('logout-btn-card');
  if (logoutBtnCard) {
    logoutBtnCard.addEventListener('click', async () => {
      try {
        await signOut(auth);
        window.location.href = '../index.html';
      } catch (err) {
        console.error('Logout failed:', err);
        alert('Logout failed: ' + err.message);
      }
    });
  }

  // Attach edit handler
  const editBtn = document.getElementById('edit-profile-btn');
  const current = auth.currentUser;
  if (!current || current.uid !== ref.id) {
    if (editBtn) editBtn.style.display = 'none';
  } else {
    editBtn.addEventListener('click', () => {
      openEditModal({
        username: data.username,
        photoURL: data.photoURL
      }, async (newName, newPhotoURL) => {
        try {
          const updates = {};
          if (newName) updates.username = newName;
          updates.photoURL = newPhotoURL || null;

          await updateDoc(ref, updates);

          // Update UI
          if (newName) {
            document.getElementById('profile-username').textContent = escapeHtml(newName);
          }

          // Update avatar display
          const avatar = document.querySelector('.profile-avatar');
          if (avatar) {
            avatar.style.background = getAvatarColor(getInitials(newName));
            const img = avatar.querySelector('img');
            if (img) {
              img.src = escapeHtml(newPhotoURL);
              img.alt = `${escapeHtml(newName)}'s avatar`;
            }
          }
        } catch (err) {
          console.error('Update error:', err);
          alert('Error updating profile: ' + err.message);
        }
      });
    });
  }
}

function openEditModal(currentData, onSave) {
  const root = document.getElementById('profile-edit-root');
  if (!root) {
    console.error('Edit modal root not found in DOM');
    return;
  }

  // Show root and modal
  root.style.display = 'block';
  const modal = root.querySelector('.profile-edit-modal');
  modal.removeAttribute('hidden');

  // Get form and inputs; replace form to avoid duplicate listeners
  const formOld = root.querySelector('#profile-edit-form');
  const form = formOld.cloneNode(true);
  form.id = 'profile-edit-form';
  formOld.parentNode.replaceChild(form, formOld);

  const nameInput = form.querySelector('#edit-name');
  const photoUrlInput = form.querySelector('#photo-url');
  const currentPhotoArea = form.querySelector('#current-photo-area') || root.querySelector('#current-photo-area');
  const removePhotoBtn = form.querySelector('#remove-photo');
  const cancelBtn = form.querySelector('#cancel-edit');

  // Populate values
  if (nameInput) nameInput.value = currentData.username || '';
  if (photoUrlInput) photoUrlInput.value = currentData.photoURL || '';

  // Populate current photo area
  if (currentPhotoArea) {
    if (currentData.photoURL) {
      currentPhotoArea.innerHTML = `<img src="${escapeHtml(currentData.photoURL)}" alt="Current profile picture">`;
      if (removePhotoBtn) removePhotoBtn.style.display = '';
    } else {
      currentPhotoArea.innerHTML = '<p id="no-photo-text">No profile picture set</p>';
      if (removePhotoBtn) removePhotoBtn.style.display = 'none';
    }
  }

  // Remove photo handler
  if (removePhotoBtn) {
    removePhotoBtn.addEventListener('click', () => {
      photoUrlInput.value = '';
      if (currentPhotoArea) currentPhotoArea.innerHTML = '<p id="no-photo-text">No profile picture set</p>';
      removePhotoBtn.style.display = 'none';
    });
  }

  // Cancel handler
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      modal.setAttribute('hidden', '');
      root.style.display = 'none';
    });
  }

  form.onsubmit = async (e) => {
    e.preventDefault();
    const newName = (form.querySelector('#edit-name') || {value: ''}).value.trim();
    const newPhotoURL = (form.querySelector('#photo-url') || {value: ''}).value.trim();

    if (newName === currentData.username && newPhotoURL === (currentData.photoURL || '')) {
      modal.setAttribute('hidden', '');
      root.style.display = 'none';
      return;
    }

    if (!confirm('Are you sure you want to save these changes?')) return;

    try {
      await onSave(newName, newPhotoURL);
      modal.setAttribute('hidden', '');
      root.style.display = 'none';
    } catch (err) {
      console.error('Save error:', err);
      alert('Error saving profile: ' + err.message);
    }
  };

  // Also allow clicking backdrop to close
  const backdrop = root.querySelector('.profile-edit-backdrop');
  if (backdrop) {
    backdrop.onclick = () => {
      modal.setAttribute('hidden', '');
      root.style.display = 'none';
    };
  }
}

// Load user's QR code
export async function loadUserQR(uid) {
  const qrContainer = document.getElementById('userQrCode');
  const downloadBtn = document.getElementById('downloadUserQr');
  const printBtn = document.getElementById('printUserQr');
  
  if (!qrContainer) return;
  
  try {
    // Fetch user data from Firestore
    const userRef = doc(db, 'users', uid);
    const userDoc = await getDoc(userRef);
    
    if (!userDoc.exists()) {
      qrContainer.innerHTML = '<p style="color: #b91c1c;">User not found</p>';
      return;
    }
    
    const userData = userDoc.data();
    
    // Check if QR already exists in user's record
    if (userData.qrDataURI) {
      qrContainer.innerHTML = `<img src="${userData.qrDataURI}" alt="User QR Code" style="width: 250px; height: 250px; border: 1px solid #e8ecf5; border-radius: 8px;" />`;
      downloadBtn.style.display = 'inline-block';
      printBtn.style.display = 'inline-block';
      
      // Store for download/print
      window.__userQR = {
        id: uid,
        name: userData.username || userData.email || 'User',
        dataURI: userData.qrDataURI
      };
    } else {
      // Generate QR code if not exists
        try {
          // Use the API base so frontend static server doesn't intercept the request
          const API_BASE = (window.API_BASE && window.API_BASE.replace(/\/$/, '')) || 'http://localhost:3000';
          const token = auth.currentUser ? await auth.currentUser.getIdToken(true).catch(e=>{ console.error('getIdToken failed', e); return null; }) : null;
          if (!token) throw new Error('Not signed in');

          const res = await fetch(`${API_BASE}/api/generateQR`, {
            method: 'POST',
            headers: {'Content-Type':'application/json', 'Authorization': 'Bearer ' + token},
            body: JSON.stringify({
              id: uid,
              name: userData.username || userData.email || 'User',
              role: userData.role || '',
              rate: userData.rate || ''
            })
          });

          const text = await res.text();
          const qrData = JSON.parse(text);

          if (qrData.qrDataURI) {
            // Display QR
            qrContainer.innerHTML = `<img src="${qrData.qrDataURI}" alt="User QR Code" style="width: 250px; height: 250px; border: 1px solid #e8ecf5; border-radius: 8px;" />`;
            downloadBtn.style.display = 'inline-block';
            printBtn.style.display = 'inline-block';

            // Save to user record
            await updateDoc(userRef, {
              qrDataURI: qrData.qrDataURI
            });

            // Store for download/print
            window.__userQR = {
              id: uid,
              name: userData.username || userData.email || 'User',
              dataURI: qrData.qrDataURI
            };
          }
      } catch (err) {
        console.error('Error generating QR:', err);
        qrContainer.innerHTML = '<p style="color: #b91c1c;">Error generating QR code</p>';
      }
    }
  } catch (err) {
    console.error('Error loading user QR:', err);
    qrContainer.innerHTML = '<p style="color: #b91c1c;">Error loading QR code</p>';
  }
}

// Download user QR
export function downloadUserQR() {
  const qr = window.__userQR;
  if (!qr) return alert('QR not available');
  const a = document.createElement('a');
  a.href = qr.dataURI;
  a.download = `${qr.id}-qr.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// Print user QR
export function printUserQR() {
  const qr = window.__userQR;
  if (!qr) return alert('QR not available');
  const w = window.open('', '_blank');
  w.document.write('<html><head><title>Print QR</title></head><body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;">');
  w.document.write(`<div style="text-align:center"><h2>${qr.name}</h2><img src="${qr.dataURI}" style="width:300px;height:300px"/><div style="color:#666;margin-top:1rem;">${qr.id}</div></div>`);
  w.document.write('</body></html>');
  w.document.close();
  w.focus();
  setTimeout(()=>{ w.print(); }, 400);
}

