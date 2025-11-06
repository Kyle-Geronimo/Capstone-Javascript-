import { auth, db } from './firebase-config.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js';
import { recordAttendance } from './payroll.js';

// Attendance UI initialization
let scanningType = '';

export function initializeAttendanceUI() {
    const checkinBtn = document.getElementById('checkinBtn');
    const checkoutBtn = document.getElementById('checkoutBtn');
    const scannerContainer = document.getElementById('scannerContainer');
    const video = document.getElementById('video');
    const scannerStatus = document.getElementById('scannerStatus');
    const attendanceCard = document.querySelector('.attendance-card');
    const authButtons = document.getElementById('auth-buttons');

    // Check authentication state
    auth.onAuthStateChanged((user) => {
        if (user) {
            // User is signed in
            if (attendanceCard) attendanceCard.style.display = 'block';
            if (authButtons) authButtons.style.display = 'none';
        } else {
            // No user is signed in
            if (attendanceCard) attendanceCard.style.display = 'none';
            if (authButtons) authButtons.style.display = 'flex';
        }
    });

    async function startScanning(type) {
        // Require signed-in user
        const user = auth.currentUser;
        if (!user) {
            alert('You must be signed in to record attendance.');
            return;
        }
        
        // -- Attempt limiter / cooldown settings --
        const ATTEMPT_KEY = `attendance_attempts_${user.uid}`;
        const MAX_ATTEMPTS = 3; // allowed failed attempts before cooldown
        const COOLDOWN_MS = 60 * 1000; // 60 seconds cooldown

        function readAttempts() {
            try {
                const raw = localStorage.getItem(ATTEMPT_KEY);
                return raw ? JSON.parse(raw) : { count: 0, firstTs: null, lockedUntil: null };
            } catch (e) {
                return { count: 0, firstTs: null, lockedUntil: null };
            }
        }

        function writeAttempts(obj) {
            try { localStorage.setItem(ATTEMPT_KEY, JSON.stringify(obj)); } catch (e) { /* ignore */ }
        }

        function clearAttempts() { localStorage.removeItem(ATTEMPT_KEY); }

        const attempts = readAttempts();
        const now = Date.now();
        if (attempts.lockedUntil && now < attempts.lockedUntil) {
            const remaining = Math.ceil((attempts.lockedUntil - now) / 1000);
            alert(`Too many failed attempts. Please wait ${remaining}s before trying again.`);
            return;
        }

        // Prompt the user to enter their employee ID and verify it matches their profile
        const enteredId = (prompt('Please enter your Employee ID:') || '').trim();
        if (!enteredId) return; // user cancelled or empty

        try {
            const userRef = doc(db, 'users', user.uid);
            const userSnap = await getDoc(userRef);
            if (!userSnap.exists()) {
                alert('Your profile was not found. Please contact an administrator.');
                return;
            }
            const profile = userSnap.data();
            const assignedId = (profile.employeeId || '').toString();
            if (!assignedId) {
                alert('No Employee ID is assigned to your account. Please contact an administrator.');
                return;
            }
            if (assignedId !== enteredId) {
                // failed attempt — increment
                let a = attempts;
                if (!a.firstTs) a.firstTs = now;
                a.count = (a.count || 0) + 1;
                if (a.count >= MAX_ATTEMPTS) {
                    a.lockedUntil = now + COOLDOWN_MS;
                    a.count = 0; // reset count after locking
                    writeAttempts(a);
                    alert(`Entered Employee ID does not match your account. Too many failed attempts. Please wait ${COOLDOWN_MS/1000}s before retrying.`);
                    return;
                }
                writeAttempts(a);
                const remaining = MAX_ATTEMPTS - a.count;
                alert(`Entered Employee ID does not match your account. You have ${remaining} attempt(s) left before a short cooldown.`);
                return;
            }

            // IDs match — clear attempts and record attendance using the user's uid
            clearAttempts();
            const result = await recordAttendance(user.uid, type);
            alert(result.message);
        } catch (err) {
            console.error('Attendance error:', err);
            alert('Error recording attendance.');
        }
    }

    if (checkinBtn) checkinBtn.addEventListener('click', () => startScanning('checkin'));
    if (checkoutBtn) checkoutBtn.addEventListener('click', () => startScanning('checkout'));
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', initializeAttendanceUI);