# Chatbot Workplace

A web-based workplace dashboard for managing chatbot modules, user profiles, authentication, and admin account approvals using Firebase.

## Features

- **User Authentication:** Sign up, log in, log out, and password reset with Firebase Auth
- **Profile Management:** 
  - View and edit user profile information
  - Upload or change profile pictures
  - Customizable profile avatars with initials
- **Chatbot Data:** Access and display chatbot-related data
- **Admin Panel:** 
  - View and approve/reject account creation requests
  - Manage existing user accounts
- **Attendance Tracking:** Track and manage employee attendance
- **Payroll Management:** Handle employee payroll information
- **Payroll Management (improved):** Front-end editable payroll table with CSV import/export, cents-safe payroll math (`js/payroll-utils.js`), attendance auto-fill, and server-side persistence of payroll runs (`POST /api/payrolls`). The payroll page includes a QR Dashboard quick link for admin workflows.
- **Weather Information:** Display weather updates and forecasts
- **Responsive Design:** Modern UI with gradient themes and interactive elements

## Folder Structure

```
javascript_website/
├── .firebaserc
├── .gitignore
├── css/
│   └── styles.css
├── firebase.json
├── firestore.indexes.json
├── firestore.rules
├── functions/
│   └── index.js
├── image/
│   └── logo/
│       ├── Bicotels Hotel.jpg
│       ├── DMariners Inn Hotel.jpg
│       └── Wennrod Hotel.jpg
├── index.html
├── js/
│   ├── admin.js
│   ├── archives.js
│   ├── auth.js
│   ├── chatbot.js
│   ├── firebase-config.js
│   ├── main.js
│   ├── nav-control.js
│   ├── node.js
│   ├── payroll-utils.js
│   ├── payroll.js
│   ├── profile.js
│   ├── qr.js
│   ├── show-password.js
│   ├── sss-table.js
│   └── weather.js
├── launch.json
├── adminsdk
├── node_modules/
├── package-lock.json
├── package.json
├── pages/
│   ├── admin.html
│   ├── archives.html
│   ├── chatbot.html
│   ├── login.html
│   ├── payroll.html
│   ├── profile.html
│   ├── qr-dashboard.html
│   ├── reset-password.html
│   └── signup.html
├── public/
│   ├── assets/
│   └── vendor/
│       └── html5-qrcode.min.js
├── server.js
└── vendor/
  └── html5-qrcode.min.js
```

## Setup Instructions

1. **Clone the repository** and open the folder in VS Code

2. **Install Dependencies:**
  ```bash
  cd javascript_website
  # If starting a new project
  npm init -y
  npm install firebase firebase-admin express cors

  # If the repo already contains a `package.json`, simply install dependencies
  npm install
  ```

  Optional: install Firebase CLI globally (required for rule deploys and other firebase tasks):
  ```powershell
  npm install -g firebase-tools
  # then login interactively
  firebase login
  ```

   Note: This will create a `node_modules` folder with all required dependencies. Do not commit this folder to version control.

3. **Add to .gitignore:**
   Create or update `.gitignore` file:
   ```plaintext
   node_modules/
   serviceAccountKey.json
   ```

4. **Firebase Admin SDK Setup:**
   ```bash
   # Install Firebase Admin SDK if not already installed
   npm install firebase-admin
   ```
   
   Ensure `server.js` exists in your project root (this repo already includes `server.js`).

   Add this to your package.json if using ES module syntax:
   ```json
   {
     "type": "module"
   }
   ```

  Start the admin server (from your project root). In PowerShell run:
  ```powershell
  cd C:\Users\chaos\a\Version9\javascript_website
  node server.js
  ```

5. **Get Admin SDK Credentials:**
   - Go to Firebase Console → Project Settings → Service Accounts
   - Click "Generate New Private Key"
   - Save the JSON file as `serviceAccountKey.json` (or your provider-named JSON, e.g. `adminsdk.json`) in your project root
   - Add the credentials file to `.gitignore` (example names below):
     ```
     serviceAccountKey.json
     adminsdk.json
     node_modules/
     ```

6. **Firebase Console Setup:**
   - Create a new Firebase project at [Firebase Console](https://console.firebase.google.com)
   - Enable Authentication with Email/Password sign-in method
   - Create a Cloud Firestore database
   - Get your Firebase configuration:
     - Go to Project Settings → General
     - Scroll to "Your apps" section
     - Click the web icon (</>)
     - Register your app and copy the config object

7. **Configure Firebase in your project:**
   - Update `js/firebase-config.js` with your Firebase configuration
   - Download your service account key:
     - Go to Project Settings → Service accounts
     - Click "Generate new private key"
     - Save as `serviceAccountKey.json` (or a name you choose) in your project root
     - Add it to `.gitignore`

  Important: change the default config values so the app connects to *your* Firebase project. Steps and examples below.

  - Replace the web app config in `js/firebase-config.js`:

    1. In Firebase Console go to Project Settings → General → Your apps → choose your web app or register a new one.
    2. Copy the config object and paste it into `js/firebase-config.js`, replacing the existing `firebaseConfig` object. Example placeholder:

    ```javascript
    // js/firebase-config.js
    const firebaseConfig = {
      apiKey: "YOUR_API_KEY",
      authDomain: "your-project-id.firebaseapp.com",
      projectId: "your-project-id",
      storageBucket: "your-project-id.appspot.com",
      messagingSenderId: "SENDER_ID",
      appId: "APP_ID",
      measurementId: "G-XXXXXXXX"
    };
    ```

    - Make sure `projectId` and `storageBucket` match the values shown in your Firebase Project settings.

  - Add or rename your Admin SDK JSON key for the server:

    1. Download the service account JSON from Firebase Console → Project Settings → Service accounts → Generate new private key.
    2. Place the downloaded file in the project root. Rename it to one of these recommended names (your choice): `serviceAccountKey.json` or `mariners-hotellink-firebase-adminsdk.json`.
    3. Add that filename to `.gitignore` (already recommended above).

    Example PowerShell commands to move and ignore the key (run from project root):

    ```powershell
    # move downloaded key from Downloads to project root (adjust filename as needed)
    Move-Item -Path $env:USERPROFILE\Downloads\mariners-hotellink-firebase-adminsdk-*.json -Destination .\serviceAccountKey.json

    # append to .gitignore (if not already present)
    Add-Content -Path .gitignore -Value "serviceAccountKey.json"
    ```

  - Update `server.js` to point to your key name (if you renamed it):

    - `server.js` contains a line similar to:
      ```js
      const saPath = join(__dirname, 'mariners-hotellink-firebase-adminsdk-fbsvc-65bfc6c5b7.json');
      ```
    - Change that filename to match the key you placed in the project root, for example:
      ```js
      const saPath = join(__dirname, 'serviceAccountKey.json');
      ```

    Quick PowerShell replace (runs a simple text replace in `server.js` — review after running):

    ```powershell
    (Get-Content server.js) -replace "mariners-hotellink-firebase-adminsdk-[^']+", 'serviceAccountKey.json' | Set-Content server.js
    ```

  - If you prefer environment variables instead of committing a filename, you can modify `server.js` to read a `SERVICE_ACCOUNT_FILE` env var and fall back to the existing filename. Example snippet to add near the top of `server.js`:

    ```js
    const saFile = process.env.SERVICE_ACCOUNT_FILE || 'serviceAccountKey.json';
    const saPath = join(__dirname, saFile);
    ```

  - Final checks:
    - Ensure `js/firebase-config.js` contains your web config and the file is saved.
    - Ensure your service account JSON file exists in the project root and is ignored by git.
    - Restart the admin server after changes:

    ```powershell
    cd C:\Users\chaos\a\Version9\javascript_website
    node server.js
    ```

  - Troubleshooting tips:
    - If the app fails to connect to Firestore or Auth, open browser console and check for network errors and config values.
    - For server-side errors (service account or Admin SDK), check the terminal where `node server.js` is running; it will log missing/parse errors for the service account JSON.
    - If you change projectId or other fields, also verify Firebase Console settings (Auth, Firestore, Storage) are enabled for that project.

8. **Set up Firestore Rules:**
   - Go to Firestore Database → Rules
   - Replace with these rules (paste into the Firestore Rules editor or deploy from `firestore.rules`):
   ```
    rules_version = '2';
    service cloud.firestore {
    match /databases/{database}/documents {

    // -----------------------
    // Helper functions
    // -----------------------
    function isSignedIn() {
      return request.auth != null;
    }

    function isAdmin() {
      return isSignedIn() &&
        (request.auth.token.admin == true ||
         get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'admin');
    }

    function isEmployee() {
      return isSignedIn() &&
        get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'employee';
    }

    // -----------------------
    // Payroll runs + lines
    // -----------------------
    match /payrolls/{payrollId} {
      allow create: if isAdmin();
      allow read:   if isAdmin() || (resource.data.createdBy == request.auth.uid);
      allow update, delete: if isAdmin();

      match /lines/{lineId} {
        // lineId is the employee UID in your existing design
        allow read: if isAdmin() || (isSignedIn() && request.auth.uid == lineId);
        allow create, update, delete: if isAdmin();
      }
    }

    // -----------------------
    // Payroll View Requests
    // -----------------------
    match /payrollViewRequests/{reqId} {
      // Create: signed-in user can create a request for themselves
      allow create: if isSignedIn()
                    && request.resource.data.userId == request.auth.uid
                    && request.resource.data.username is string
                    && request.resource.data.status == 'pending';

      // Read: admins can list/read all; user can read their own requests
      allow get, list: if isSignedIn() && (isAdmin() || resource.data.userId == request.auth.uid);

      // Update/Delete: only admins
      // Prevent changing userId on updates by checking it stays the same
      allow update, delete: if isSignedIn() && isAdmin()
                            && request.resource.data.userId == resource.data.userId;
    }

    // -----------------------
    // Payroll settings (holidays)
    // -----------------------
    // Path: payroll_settings/holidays (and other payroll_settings docs)
    match /payroll_settings/{docId} {
      allow read: if isSignedIn();
      allow write: if isSignedIn() && isAdmin();
    }

    // -----------------------
    // SSS Contribution Table (config)
    // -----------------------
    match /config/sssContributionTable {
      allow read: if isSignedIn();
      allow write: if isSignedIn() && isAdmin();
    }

    match /config/sssContributionTable/history/{docId} {
      allow read: if isSignedIn() && isAdmin();
      allow write: if false;
    }

    // -----------------------
    // Account Requests
    // -----------------------
    match /accountRequests/{requestId} {
      allow create: if isSignedIn();
      allow read, update, delete: if isSignedIn() && isAdmin();
    }

    // -----------------------
    // Users
    // -----------------------
    match /users/{userId} {
      allow read: if isSignedIn();
      allow create: if isSignedIn() && request.auth.uid == userId;
      allow update, delete: if isSignedIn() && (request.auth.uid == userId || isAdmin());
    }

    // -----------------------
    // Archived Users
    // -----------------------
    match /archivedUsers/{docId} {
      allow read, write: if isSignedIn() && isAdmin();
    }

    // -----------------------
    // Attendance
    // -----------------------
    match /attendance/{docId} {
      allow read: if isSignedIn();
      allow create: if isSignedIn() && (request.auth.uid == request.resource.data.userId || isAdmin());
      allow update: if isSignedIn() && (request.auth.uid == resource.data.userId || isAdmin());
      allow delete: if isSignedIn() && isAdmin();
    }

    // -----------------------
    // Payroll Batches
    // -----------------------
    match /payrollBatches/{batchId} {
      allow read, write, delete: if isSignedIn() && isAdmin();
    }

    // -----------------------
    // Chatbot Inquiries
    // -----------------------
    match /chatbot/{docId} {
      allow create: if isSignedIn();
      allow read: if isSignedIn() && (isAdmin() || isEmployee());
      allow update, delete: if isSignedIn() && isAdmin();
    }

    // -----------------------
    // Hotels
    // -----------------------
    match /hotel/{docId} {
      allow read: if true;
      allow write: if isSignedIn() && (isAdmin() || isEmployee());
    }

    // -----------------------
    // Default deny everything else
    // -----------------------
    match /{document=**} {
      allow read, write: if false;
    }
    }
    }
    ``` 

9. **Add Authorized Domains:**
   - Go to Authentication → Settings → Authorized domains
   - Add: `localhost` and `127.0.0.1`

  **Firestore Schema**

  - **`users` collection:** User profiles and roles. Pages: `signup.html`, `login.html`, `profile.html`, `admin.html`, `archives.html`.
    - `username`: string
    - `email`: string
    - `role`: string (e.g., `admin`, `employee`, `user`)
    - `photoURL`: string (URL)
    - `createdAt`: timestamp
    - `approved`: boolean
    - `meta`: map (freeform additional metadata)

  - **`accountRequests` collection:** Signup requests awaiting admin approval. Pages: `signup.html`, `admin.html`.
    - `username`: string
    - `email`: string
    - `requestedRole`: string
    - `reason`: string
    - `status`: string (`pending`, `approved`, `rejected`)
    - `createdAt`: timestamp

  - **`archivedUsers` collection:** Archived/removed user snapshots. Pages: `archives.html`, `admin.html`.
    - (same fields as `users`) plus:
    - `archivedAt`: timestamp
    - `archivedBy`: string (admin UID)
    - `archiveReason`: string

  - **`attendance` collection:** Employee attendance records. Pages: `payroll.html`, `profile.html`, `admin.html`.
    - `userId`: string (UID)
    - `date`: timestamp or string (ISO date)
    - `checkIn`: timestamp
    - `checkOut`: timestamp
    - `status`: string (`present`, `absent`, `on_leave`)
    - `location`: string (optional)
    - `notes`: string (optional)

  - **`payrolls` collection:** Payroll runs. Pages: `payroll.html`, `admin.html`, `qr-dashboard.html`.
    - `createdBy`: string (admin UID)
    - `createdAt`: timestamp
    - `periodStart`: timestamp
    - `periodEnd`: timestamp
    - `totalAmount`: number (cents recommended integer)
    - `status`: string (`draft`, `posted`, `completed`)
    - `meta`: map
    - Subcollection `lines` (per payroll):
      - document id = `lineId` (typically employee UID)
      - `username`: string
      - `grossPay`: number
      - `netPay`: number
      - `deductions`: map (name: number)
      - `daysWorked`: number

  - **`payrollBatches` collection:** Grouped payroll runs for batch operations. Pages: `payroll.html`, `admin.html`.
    - `batchName`: string
    - `payrollIds`: array of strings
    - `createdAt`: timestamp
    - `createdBy`: string

  - **`payrollViewRequests` collection:** Employee requests to view payrolls. Pages: `payroll.html`, `admin.html`.
    - `userId`: string
    - `username`: string
    - `status`: string (`pending`, `approved`, `denied`)
    - `createdAt`: timestamp

  - **`config/sssContributionTable` document:** SSS contribution lookup table. Pages: `payroll.html`.
    - `salaryMin`: number
    - `salaryMax`: number
    - `employeeShare`: number
    - `employerShare`: number
    - `total`: number

  - **`chatbot` collection:** Chatbot inquiries and responses. Pages: `chatbot.html`, `admin.html`.
    - `userId`: string
    - `question`: string
    - `response`: string
    - `createdAt`: timestamp
    - `status`: string (`new`, `in_progress`, `resolved`)
    - `meta`: map

  - **`hotel` collection:** Hotel records used by various pages. Pages: `admin.html`, `profile.html`, general listing pages.
    - `name`: string
    - `address`: string
    - `images`: array of strings (URLs)
    - `rating`: number
    - `createdBy`: string

## Usage

- **Home:** Landing page with authentication options
- **Login/Sign Up:** 
  - Create new account requests
  - Login with approved credentials
- **Profile:** 
  - View and edit user information
  - Change profile picture or use initial avatars
  - Manage account settings
- **Modules:** Control chatbot modules
- **Chatbot Data:** Access chatbot information
- **Admin:** 
  - Review and manage account requests
  - View all user accounts
  - Approve/reject new registrations

## Customization

- **Styling:** 
  - Main styles in `css/styles.css`
  - Theme colors: #4f8cff (primary), #6ed6ff (secondary)
- **Components:**
  - Profile components in `js/profile.js`
  - Admin features in `js/admin.js`
  - Authentication in `js/auth.js`

## Dependencies

- Firebase JS SDK 
- Firebase Admin SDK
- Express.js (for Admin features)
- Modern browsers with ES6+ support

## License

MIT License

---

**Made for Capstone Project 2025**
