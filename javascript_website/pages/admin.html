<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>HotelLink - Admin</title>
  <link rel="stylesheet" href="../css/styles.css">

  <!-- Firebase SDKs -->
  <script src="https://www.gstatic.com/firebasejs/12.4.0/firebase-app-compat.js"></script>
  <script src="https://www.gstatic.com/firebasejs/12.4.0/firebase-auth-compat.js"></script>
  <script src="https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore-compat.js"></script>
  <script type="module" src="../js/auth.js"></script>
</head>
<body>
  <header>
    <div class="container">
      <h1>HotelLink</h1>
      <nav>
        <a href="../index.html" class="nav-btn">Home</a>
        <a href="chatbot.html" class="nav-btn restricted">Chatbot Data</a>
        <a href="admin.html" class="nav-btn restricted admin-only">Admin</a>
        <a href="profile.html" class="nav-btn restricted">Profile</a>
      </nav>
    </div>
  </header>

  <main>
    <section class="form-container chatbot-data-container admin-dashboard">
      <h2>Admin Dashboard</h2>

      <!-- Account Requests Section -->
      <div class="admin-section">
        <h3>Account Requests</h3>
        <div class="requests-panel">
          <div id="requests" class="request-list">
            <em>Loading requests…</em>
          </div>
        </div>
      </div>

      <!-- User Management Section -->
      <div class="admin-section">
        <div class="section-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
          <h3>User Management</h3>
          <a href="archives.html" class="action-btn" style="text-decoration: none;">Archives</a>
        </div>
        <div class="accounts-panel">
          <div id="accounts" class="accounts-list">
            <em>Loading accounts…</em>
          </div>
        </div>
      </div>

      <!-- Payroll Management Section -->
      <div class="admin-section">
        <h3>Payroll Management</h3>
        <div class="filters">
            <h3 style="color: #1f4ea6; margin-bottom: 1rem;">Pay Period Selection</h3>
              <div class="form-group flex gap-3 mb-3">
                <div class="flex-1">
                  <label for="monthSelect" class="form-label">Month</label>
                  <select id="monthSelect" class="form-control"></select>
                </div>
                <div class="flex-1">
                  <label for="periodSelect" class="form-label">Period</label>
                  <select id="periodSelect" class="form-control">
                    <option value="1-15">1 - 15</option>
                    <option value="16-end">16 - end</option>
                  </select>
                </div>
              </div>
              <div class="button-group" style="margin: 1.5rem 0; padding: 0 1rem;">
                <button id="loadFromFirestore" class="action-btn primary">Load Employees & DTR</button>
                <button id="computePayroll" class="action-btn primary">Compute Payroll</button>
                <button id="savePayroll" class="action-btn primary">Save Payroll</button>
                <button id="exportCsv" class="action-btn secondary">Export CSV</button>
              </div>
            </div>

            <div id="resultsArea" class="table-responsive">
              <table id="payrollTable" class="data-table">
                <thead>
                  <tr>
                    <th style="width: 40px;">#</th>
                    <th style="width: 200px;">Name</th>
                    <th style="width: 80px;">Rate</th>
                    <th style="width: 60px;">Days</th>
                    <th style="width: 100px;">Basic</th>
                    <th style="width: 80px;">Night Hrs</th>
                    <th style="width: 100px;">Night Amount</th>
                    <th style="width: 80px;">OT Hrs</th>
                    <th style="width: 100px;">OT Amount</th>
                    <th style="width: 80px;">Reg Hol Hrs</th>
                    <th style="width: 100px;">Reg Hol Amount</th>
                    <th style="width: 100px;">Gross</th>
                    <th style="width: 100px;">SSS (Emp)</th>
                    <th style="width: 100px;">SSS (Er)</th>
                    <th style="width: 120px;">Other Deductions</th>
                    <th style="width: 100px;">Net</th>
                  </tr>
                </thead>
                <tbody></tbody>
              </table>
            </div>
          </div>
        </div>

      </section>
    </div>
  </main>

  <footer>
    <div class="container">
      <p>&copy; 2025 D' Mariners Inn Hotel. All rights reserved.</p>
    </div>
  </footer>
  
  <script type="module">
    import { auth } from '../js/firebase-config.js';
    import { updateNavVisibility } from '../js/nav-control.js';
    import { watchRequestsRealtime, loadAccounts } from '../js/admin.js';

    // Update nav immediately and on auth state changes
    updateNavVisibility();
    
    auth.onAuthStateChanged((user) => {
      updateNavVisibility();
      if (user) {
        // Initialize account management features
        watchRequestsRealtime(); // Start watching for account requests
        loadAccounts(); // Load existing accounts
      }
    });
  </script>
</body>
</html>
