import { auth, getUserRole } from './firebase-config.js';

export async function updateNavVisibility() {
  const nav = document.querySelector('nav');
  if (!nav) return;

  try {
    const user = auth.currentUser;
    console.log('Current user:', user?.uid); // Debug

    if (!user) {
      // User is logged out - show only public links
      nav.querySelectorAll('.restricted, .admin-only').forEach(link => {
        link.style.display = 'none';
      });
      nav.querySelectorAll('.public-only').forEach(link => {
        link.style.display = 'inline-block';
      });
      return;
    }

    // User is logged in - fetch role
    const role = await getUserRole(user.uid);
    console.log('User role:', role); // Debug

    // Update visibility based on role
    nav.querySelectorAll('.nav-btn').forEach(link => {
      if (link.classList.contains('public-only')) {
        // Hide login/signup for logged in users
        link.style.display = 'none';
      } else if (link.classList.contains('admin-only')) {
        // Show admin links only to admins
        link.style.display = role === 'admin' ? 'inline-block' : 'none';
      } else if (link.classList.contains('restricted')) {
        // Show restricted links to all logged in users
        link.style.display = 'inline-block';
      }
    });

  } catch (err) {
    console.error('Navigation visibility error:', err);
  }
}