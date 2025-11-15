// payroll.js
import * as XLSX from "xlsx";
import { initializeApp } from "firebase/app";
import { getFirestore, doc, setDoc } from "firebase/firestore";
import fs from "fs";

// 2️⃣ --- READ EXCEL FILE ---
const workbook = XLSX.readFile("Payroll WHotel 2025.xlsx");
const sheet = workbook.Sheets[workbook.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

// 3️⃣ --- PARSE ROWS ---
const payrollPeriod = "March_1_15_2025";
let employees = [];

rows.forEach((row) => {
  if (!row["NAMES"]) return; // Skip empty rows

  const employee = {
    name: row["NAMES"],
    rate: Number(row["RATE"]) || 0,
    days: Number(row["DAYS"]) || 0,
    nightDiff: Number(row["NIGHT (PER HR COUNT)"]) || 0,
    regHoliday: Number(row["REGULAR HOLIDAY (IN HOURS)"]) || 0,
    spHoliday: Number(row["SPECIAL NON-WORKING HOLIDAY (IN HOURS)"]) || 0,
    grossSalary: Number(row["GROSS SALARY"]) || 0,
    utLate: Number(row["UT/LATE"]) || 0,
    ot: Number(row["OT"]) || 0,
    deductions: {
      sss: Number(row["SSS"]) || 0,
      philhealth: Number(row["PHILHEALTH"]) || 0,
      pagibig: Number(row["PAG-IBIG"]) || 0,
      cashAdvance: Number(row["CASH ADVANCE / CREDIT"]) || 0,
    },
    totalDeduction: Number(row["TOTAL DEDUCTION"]) || 0,
    totalNet: Number(row["TOTAL NET"]) || 0,
  };

  employees.push(employee);
});

// 4️⃣ --- UPLOAD TO FIRESTORE ---
async function uploadToFirestore() {
  for (const emp of employees) {
    const ref = doc(db, "payrolls", payrollPeriod, "employees", emp.name);
    await setDoc(ref, emp);
    console.log(`✅ Uploaded: ${emp.name}`);
  }

  // Summary document
  const totalGross = employees.reduce((sum, e) => sum + e.grossSalary, 0);
  const summaryRef = doc(db, "payrolls", payrollPeriod, "summary", "totals");
  await setDoc(summaryRef, {
    totalEmployees: employees.length,
    totalGross,
    uploadedAt: new Date().toISOString(),
  });

  console.log("🎉 Payroll uploaded successfully!");
}

uploadToFirestore().catch(console.error);