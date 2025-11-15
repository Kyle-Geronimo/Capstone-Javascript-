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
- **Weather Information:** Display weather updates and forecasts
- **Responsive Design:** Modern UI with gradient themes and interactive elements

## Folder Structure

```
javascript_website/
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
│   ├── payroll.js
│   ├── profile.js
│   ├── qr.js
│   ├── show-password.js
│   └── weather.js
├── launch.json
├── mariners-hotellink-firebase-adminsdk-fbsvc-65bfc6c5b7.json
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
├── server.js
└── vendor/
  └── html5-qrcode.min.js
```

## Setup Instructions

1. **Clone the repository** and open the folder in VS Code

2. **Install Dependencies:**
   ```bash
   cd javascript_website
   npm init -y
   npm install firebase firebase-admin express cors
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
   # Install Firebase Admin SDK
   npm install firebase-admin
   ```
   
   Create a new file `server.js` in your project root

   Add this to your package.json:
   ```json
   {
     "type": "module"
   }
   ```

  Start the admin server (from your project root). In PowerShell run:
  ```powershell
  cd C:\Users\chaos\a\Version6\javascript_website
  node server.js
  ```

5. **Get Admin SDK Credentials:**
   - Go to Firebase Console → Project Settings → Service Accounts
   - Click "Generate New Private Key"
   - Save the JSON file as `serviceAccountKey.json` in your project root
   - Add to `.gitignore`:
     ```
     serviceAccountKey.json
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
     - Save as `serviceAccountKey.json` in your project root
     - Add it to `.gitignore`

8. **Set up Firestore Rules:**
   - Go to Firestore Database → Rules
   - Replace with these rules:
   ```javascript
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {

    // Helper: check if user is signed in
    function isSignedIn() {
      return request.auth != null;
    }

    // Helper: check if user is admin
    function isAdmin() {
      return isSignedIn() &&
        get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'admin';
    }

    // Helper: check if user is an employee/staff
    function isEmployee() {
      return isSignedIn() &&
        get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'employee';
    }

    // 🔹 Account Requests
    match /accountRequests/{requestId} {
      // Anyone can submit a signup request
      allow create: if true;
      // Only admins can view or manage requests
      allow read, update, delete: if isAdmin();
    }

    // 🔹 User Profiles
    match /users/{userId} {
      // All signed-in users can read basic profile info
      allow read: if isSignedIn();
      // Users can manage their own profile
      allow create, update, delete: if request.auth.uid == userId;
      // Admins can manage all profiles
      allow read, write: if isAdmin();
    }

    // 🔹 Archived Users
    match /archivedUsers/{docId} {
      allow read, write: if isAdmin();
    }

    // 🔹 Attendance
    match /attendance/{docId} {
      allow read: if isSignedIn();
      // Employees can write their own attendance
      allow create, update: if request.auth.uid == resource.data.userId || isAdmin();
      allow delete: if isAdmin();
    }

    // 🔹 Payroll
    match /payroll/{docId} {
      // Everyone can read their own payroll; admins can read all
      allow read: if isAdmin() || resource.data.employeeId == request.auth.uid;
      allow write, delete: if isAdmin();
    }

    // 🔹 Payroll Batches
    match /payrollBatches/{batchId} {
      allow read, write, delete: if isAdmin();
    }

    // 🔹 Chatbot Inquiries
    match /chatbot/{docId} {
      // Any signed-in user (admin or employee) can read inquiries
      allow read: if isAdmin() || isEmployee();
      // Any signed-in user can create new chatbot inquiries
      allow create: if isSignedIn();
      // Only admins can edit or delete chatbot logs
      allow update, delete: if isAdmin();
    }
  }
}
```


9. **Add Authorized Domains:**
   - Go to Authentication → Settings → Authorized domains
   - Add: `localhost` and `127.0.0.1`

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

