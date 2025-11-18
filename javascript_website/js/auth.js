import { auth, db, getUserRole } from './firebase-config.js';
import { collection, addDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js';
import { signInWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js';
import { updateNavVisibility } from './nav-control.js';

// Start auth state listener
document.addEventListener('DOMContentLoaded', () => {
    initializeAuthState();
});

// Handle auth state changes
function initializeAuthState() {
    auth.onAuthStateChanged(async (user) => {
        
        if (user) {
            // User is logged in
            const role = await getUserRole(user.uid);
            console.log('User role:', role);
            
            // Show restricted content
            document.querySelectorAll('.restricted').forEach(el => {
                el.style.display = role === 'admin' || !el.classList.contains('admin-only') ? 'block' : 'none';
            });
            
            // Hide public-only content
            document.querySelectorAll('.public-only').forEach(el => {
                el.style.display = 'none';
            });
            
            // Update auth container if exists
            const authContainer = document.getElementById('auth-container');
            const authButtons = document.getElementById('auth-buttons');
            if (authContainer && authButtons) {
                authButtons.style.display = 'none';
            }
            
            // If on login page, redirect to home
            if (window.location.pathname.includes('login.html')) {
                window.location.href = '../index.html';
            }
        } else {
            // User is logged out
            console.log('No user logged in');
            
            // Hide restricted content
            document.querySelectorAll('.restricted').forEach(el => {
                el.style.display = 'none';
            });
            
            // Show public-only content
            document.querySelectorAll('.public-only').forEach(el => {
                el.style.display = 'block';
            });
            
            // Update auth container if exists
            const authContainer = document.getElementById('auth-container');
            const authButtons = document.getElementById('auth-buttons');
            if (authContainer && authButtons) {
                authButtons.style.display = 'flex';
            }
            
                        // If on restricted page, redirect to login — but allow unauthenticated
                        // users to remain on the public home page (root or index.html)
                        const currentPath = window.location.pathname;
                        const isPublicPage = currentPath.endsWith('index.html') ||
                            currentPath.includes('login.html') || 
                            currentPath.includes('signup.html') ||
                            currentPath.includes('reset-password.html');
                        
                        if (!isPublicPage) {
                            // Get the correct relative path to login page
                            const isInPagesDir = currentPath.includes('/pages/');
                            window.location.href = isInPagesDir ? 'login.html' : 'pages/login.html';
                        }
        }
        
        // Update navigation
        await updateNavVisibility();
    });
}

// Create new account request
export async function signup(email, password, role = 'employee', username = '') {
    try {
        // Store request in Firestore
        const reqRef = await addDoc(collection(db, 'accountRequests'), {
            email,
            password, // warning: store securely in production
            role,
            username: username || email.split('@')[0],
            status: 'pending',
            createdAt: serverTimestamp()
        });
        
        alert('Account request submitted. An admin will review your request.');
        return reqRef;
    } catch (err) {
        console.error('Signup request failed:', err);
        throw err;
    }
}

// User login
export async function login(email, password) {
    try {
        const userCredential = await signInWithEmailAndPassword(auth, email, password);
        console.log('Login successful:', userCredential.user.uid);
        return userCredential;
    } catch (error) {
        console.error('Login failed:', error);
        throw error;
    }
}

// User logout
export async function logout() {
    try {
        await signOut(auth);
        console.log('Logout successful');
        // Redirect to home page - auth state change will update nav visibility
        window.location.href = '/';
    } catch (error) {
        console.error('Logout failed:', error);
        throw error;
    }
}

// Auth state is initialized on DOMContentLoaded above
