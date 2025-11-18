import { auth, getUserRole } from './firebase-config.js';

export async function updateNavVisibility() {
  const nav = document.querySelector('nav');
  if (!nav) return;

  try {
    const user = auth.currentUser;
    console.log('Current user:', user?.uid); // Debug

    // Select navigation sections
    const authNav = nav.querySelector('.auth-nav');
    const userNav = nav.querySelector('.user-nav');

    if (!user) {
      // User is logged out - show auth nav, hide user nav
      if (authNav) authNav.style.display = 'inline-flex';
      if (userNav) userNav.style.display = 'none';
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
    if (authNav) authNav.style.display = 'none';
    if (userNav) userNav.style.display = 'inline-flex';
    
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

export function highlightActiveNavBtn() {
  const nav = document.querySelector('nav');
  if (!nav) return;

  // Get current page filename
  const currentPath = window.location.pathname;
  const currentFile = currentPath.split('/').pop() || 'index.html';

  // Remove active class from all nav buttons
  nav.querySelectorAll('.nav-btn').forEach(btn => {
    btn.classList.remove('active');
  });

  // Add active class to matching nav button
  nav.querySelectorAll('.nav-btn').forEach(btn => {
    const href = btn.getAttribute('href');
    if (!href) return;

    const hrefFile = href.split('/').pop();
    if (hrefFile === currentFile || (currentFile === '' && hrefFile === 'index.html')) {
      btn.classList.add('active');
    }
  });
}
