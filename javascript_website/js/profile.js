// profile.js
import { auth, db } from './firebase-config.js';
import { doc, getDoc, updateDoc } from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js';
import { signOut } from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js';

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}

// Get initials from username/full name
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

// Generate a consistent color based on initials
function getAvatarColor(initials) {
  const colors = [
    'linear-gradient(135deg, #4f8cff 0%, #6ed6ff 100%)',  // blue (default)
    'linear-gradient(135deg, #ff4f8c 0%, #ff6ed6 100%)',  // pink
    'linear-gradient(135deg, #4fff8c 0%, #6effd6 100%)',  // green
    'linear-gradient(135deg, #8c4fff 0%, #d66eff 100%)',  // purple
    'linear-gradient(135deg, #ff8c4f 0%, #ffd66e 100%)'   // orange
  ];
  
  // Generate consistent index based on initials
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
        <div class="profile-avatar" style="background: ${avatarColor}">
          ${data.photoURL ? `<img src="${escapeHtml(data.photoURL)}" alt="${escapeHtml(username)}'s avatar">` : initials}
        </div>
        <div class="profile-details">
          <div class="profile-row"><strong>Name:</strong> <span id="profile-username">${escapeHtml(username)}</span></div>
          <div class="profile-row"><strong>Email:</strong> <span>${escapeHtml(email)}</span></div>
          <div class="profile-row"><strong>Role:</strong> <span>${escapeHtml(role)}</span></div>
          <div class="profile-actions">
            <button id="edit-profile-btn" class="action-btn primary">Edit</button>
            <button id="logout-btn-card" class="action-btn secondary">Logout</button>
          </div>
        </div>
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
        showEditModal({ 
          username: data.username,
          photoURL: data.photoURL 
        }, async (newName, newPhotoURL) => {
          try {
            const updates = {};
            if (newName) updates.username = newName;
            if (typeof newPhotoURL !== 'undefined') {
              updates.photoURL = newPhotoURL;
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
      showEditModal({ 
        username: data.username,
        photoURL: data.photoURL 
      }, async (newName, newPhotoURL) => {
        try {
          const updates = {};
          if (newName) updates.username = newName;
          // Explicitly set photoURL to null when removed
          updates.photoURL = newPhotoURL;

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

function showEditModal(currentData, onSave) {
  const modal = document.createElement('div');
  modal.innerHTML = `
    <div class="profile-edit-backdrop"></div>
    <div class="profile-edit-modal">
      <form class="profile-edit-form">
        <h3>Edit Profile</h3>
        <label>
          Name
          <input type="text" id="edit-name" value="${escapeHtml(currentData.username || '')}" placeholder="Your name">
        </label>
        <div class="profile-photo-section">
          <div class="current-photo">
            ${currentData.photoURL ? `
              <img src="${escapeHtml(currentData.photoURL)}" alt="Current profile picture" style="width:100px;height:100px;border-radius:50%;object-fit:cover;">
              <button type="button" class="action-btn remove-photo" id="remove-photo">Remove Profile Picture</button>
            ` : '<p>No profile picture set</p>'}
          </div>
          <label class="file-upload-btn" for="photo-url">
            <span>Enter Image URL</span>
            <input type="url" id="photo-url" value="${escapeHtml(currentData.photoURL || '')}" placeholder="Enter image URL">
          </label>
        </div>
        <div class="modal-actions">
          <button type="button" class="action-btn secondary" id="cancel-edit">Cancel</button>
          <button type="submit" class="action-btn primary">Save Changes</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(modal);

  const form = modal.querySelector('form');
  const photoUrlInput = form.querySelector('#photo-url');
  const removePhotoBtn = form.querySelector('#remove-photo');

  // Handle remove photo button
  if (removePhotoBtn) {
    removePhotoBtn.addEventListener('click', () => {
      photoUrlInput.value = ''; // Clear the URL input
      const currentPhoto = modal.querySelector('.current-photo');
      currentPhoto.innerHTML = '<p>No profile picture set</p>';
      removePhotoBtn.style.display = 'none';
    });
  }

  form.onsubmit = async (e) => {
    e.preventDefault();
    const newName = form['edit-name'].value.trim();
    const newPhotoURL = form['photo-url'].value.trim();
    
    // Check if anything changed
    if (newName === currentData.username && newPhotoURL === currentData.photoURL) {
      modal.remove();
      return;
    }

    // Add confirmation prompt
    if (!confirm('Are you sure you want to save these changes?')) {
      return;
    }

    try {
      await onSave(newName, newPhotoURL);
      modal.remove();
    } catch (err) {
      console.error('Save error:', err);
      alert('Error saving profile: ' + err.message);
    }
  };

  modal.querySelector('#cancel-edit').onclick = () => modal.remove();
}
