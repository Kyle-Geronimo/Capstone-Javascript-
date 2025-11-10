import { auth } from './firebase-config.js';

// Simplified attendance UI initialization
export function initializeAttendanceUI() {
    const attendanceCard = document.querySelector('.attendance-card');
    const authButtons = document.getElementById('auth-buttons');

    // Check authentication state
    auth.onAuthStateChanged((user) => {
        if (user) {
            // User is signed in
            if (attendanceCard) attendanceCard.style.display = 'none'; // Hide attendance card for now
            if (authButtons) authButtons.style.display = 'none';
        } else {
            // No user is signed in
            if (attendanceCard) attendanceCard.style.display = 'none';
            if (authButtons) authButtons.style.display = 'flex';
        }
    });
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', initializeAttendanceUI);
