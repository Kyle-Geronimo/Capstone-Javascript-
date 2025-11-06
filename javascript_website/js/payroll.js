import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js';
import { getFirestore, collection, getDocs, addDoc, query, where, doc, updateDoc, getDoc } from 'https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js';

let app = null;
let db = null;
let auth = null;

// Setup Firebase for payroll
export async function initializePayrollSystem(firebaseConfig) {
    try {
        app = initializeApp(firebaseConfig);
        db = getFirestore(app);
        auth = getAuth(app);
        return true;
    } catch(e) {
        console.error('Failed to initialize Firebase:', e);
        return false;
    }
}

// Barcode generation/scan features removed or moved; attendance uses user UID now

// Record employee attendance
export async function recordAttendance(employeeId, type) {
    try {
        // Try to resolve employeeId as a user document ID first (allow passing uid)
        let user = null;
        try {
            const docSnap = await getDoc(doc(db, 'users', employeeId));
            if (docSnap.exists()) {
                user = { id: docSnap.id, data: () => docSnap.data() };
            }
        } catch (e) {
            // ignore and fallback to lookup by employeeId field
        }

        if (!user) {
            // Verify that this is a valid employeeId assigned to a user (field lookup)
            const usersRef = collection(db, 'users');
            const q = query(usersRef, where('employeeId', '==', employeeId));
            const querySnapshot = await getDocs(q);
            if (querySnapshot.empty) {
                return { success: false, message: 'Invalid Employee ID' };
            }
            user = querySnapshot.docs[0];
        }
        const today = new Date().toISOString().split('T')[0];

        // Check if there's already an attendance record for today
        const attendanceRef = collection(db, 'attendance');
        const todayQuery = query(attendanceRef, 
            where('userId', '==', user.id),
            where('date', '==', today)
        );
        const todayAttendance = await getDocs(todayQuery);

        if (type === 'checkout' && todayAttendance.empty) {
            return { success: false, message: 'No check-in record found for today' };
        }

        if (type === 'checkin' && !todayAttendance.empty) {
            return { success: false, message: 'Already checked in for today' };
        }

        if (type === 'checkout' && !todayAttendance.empty) {
            // Update existing record with checkout time
            const attendanceDoc = todayAttendance.docs[0];
            await updateDoc(doc(db, 'attendance', attendanceDoc.id), {
                checkoutTime: new Date().toISOString(),
                updated: new Date().toISOString()
            });
        } else {
            // Create new check-in record
            await addDoc(collection(db, 'attendance'), {
                userId: user.id,
                userName: user.data().name || '',
                date: today,
                checkinTime: new Date().toISOString(),
                created: new Date().toISOString()
            });
        }

        return { success: true, message: `${type === 'checkin' ? 'Check-in' : 'Check-out'} successful` };
    } catch (error) {
        console.error('Attendance recording error:', error);
        return { success: false, message: 'Error recording attendance' };
    }
}

// Calculate payroll for date range
export function computeForPeriod(employees, dtrRows, month, period) {
    const startDay = (period === '1-15') ? 1 : 16;
    const endDay = (period === '1-15') ? 15 : 31;
    const year = new Date().getFullYear();

    const byEmp = {};
    for (const e of employees) {
        byEmp[e.name] = {
            employee: e,
            days: 0,
            nightDays: 0,
            nightHours: 0,
            otHours: 0,
            regHolHours: 0,
            basicRate: e.rate || 0
        };
    }

    for (const r of dtrRows) {
        try {
            const d = new Date(r.date);
            if ((d.getMonth() + 1) != Number(month) || d.getFullYear() != year) continue;
            const day = d.getDate();
            if (day < startDay || day > endDay) continue;
            const name = r.name;
            if (!byEmp[name]) byEmp[name] = {
                employee: { name },
                days: 0,
                nightDays: 0,
                nightHours: 0,
                otHours: 0,
                regHolHours: 0,
                basicRate: r.rate || 0
            };
            // accumulate
            byEmp[name].days += (r.daysCount || 1);
            byEmp[name].nightHours += (r.nightHours || 0);
            byEmp[name].nightDays += ((r.nightHours || 0) / 8);
            byEmp[name].otHours += (r.otHours || 0);
            byEmp[name].regHolHours += (r.regHolHours || 0);
        } catch (e) {
            console.warn('bad row', r, e)
        }
    }

    return computePayrollRows(byEmp);
}

function computePayrollRows(byEmp) {
    const rows = [];
    let i = 1;
    for (const name in byEmp) {
        const b = byEmp[name];
        const rate = Number(b.basicRate || 0);
        const days = Number((Math.round((b.days + Number.EPSILON) * 100) / 100) || 0);
        const basic = rate * days;
        const nightAmount = rate * 0.1 * (b.nightDays || 0);
        const otAmount = (rate / 8) * 1.25 * (b.otHours || 0);
        const regHolAmount = (rate / 8) * 1.00 * (b.regHolHours || 0);
        const gross = basic + (nightAmount || 0) + (otAmount || 0) + (regHolAmount || 0);

        const sssEmployee = roundNumber(gross * 0.05, 2);
        const sssEmployer = roundNumber(gross * 0.10, 2);
        const ec = 10;

        const otherDeductions = 0;
        const net = roundNumber(gross - sssEmployee - otherDeductions, 2);

        rows.push({
            index: i++,
            name,
            rate,
            days,
            basic: roundNumber(basic, 2),
            nightHours: roundNumber(b.nightHours, 2),
            nightAmount: roundNumber(nightAmount, 2),
            otHours: roundNumber(b.otHours, 2),
            otAmount: roundNumber(otAmount, 2),
            regHolHours: roundNumber(b.regHolHours, 2),
            regHolAmount: roundNumber(regHolAmount, 2),
            gross: roundNumber(gross, 2),
            sssEmployee,
            sssEmployer,
            otherDeductions,
            net
        });
    }
    return rows;
}

function roundNumber(v, dec = 2) {
    return Math.round((v + Number.EPSILON) * Math.pow(10, dec)) / Math.pow(10, dec);
}

export function toCSV(rows) {
    const keys = ['index', 'name', 'rate', 'days', 'basic', 'nightHours', 'nightAmount', 'otHours', 'otAmount', 'regHolHours', 'regHolAmount', 'gross', 'sssEmployee', 'sssEmployer', 'otherDeductions', 'net'];
    const lines = [keys.join(',')];
    for (const r of rows) {
        lines.push(keys.map(k => JSON.stringify(r[k] || '')).join(','));
    }
    return lines.join('\n');
}