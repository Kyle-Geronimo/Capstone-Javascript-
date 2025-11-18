// js/sss-table.js
import { db } from './firebase-config.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js';

/** getSssTable()
 * returns { table: [...], fetchedAt, checksum } or null
 */
export async function getSssTable() {
  const docRef = doc(db, 'config', 'sssContributionTable');
  const snap = await getDoc(docRef);
  if (!snap.exists()) return null;
  const data = snap.data();
  return {
    table: data.table || [],
    fetchedAt: data.fetchedAt || data.uploadedAt || null,
    checksum: data.checksum || null
  };
}

/** lookupSssContribution(monthlySalary)
 * returns { employee, employer, total } in PHP (numbers) or null
 */
export async function lookupSssContribution(monthlySalary) {
  const payload = await getSssTable();
  if (!payload || !payload.table) return null;
  const t = payload.table;
  const ms = Number(monthlySalary || 0);
  let match = t.find(b => (typeof b.min === 'number' && typeof b.max === 'number') && ms >= b.min && ms <= b.max);
  if (!match) {
    match = t.reduce((best, b) => {
      if (!b.min) return best;
      if (best === null) return b;
      if (b.min <= ms && b.min > best.min) return b;
      return best;
    }, null);
  }
  if (!match) return null;
  return { employee: Number(match.employee || 0), employer: Number(match.employer || 0), total: Number(match.total || 0) };
}
