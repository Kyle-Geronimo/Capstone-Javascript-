# Chatbot Workplace

A web-based workplace dashboard for managing chatbot modules, user profiles, authentication, and admin account approvals using Firebase.

## Features

- **User Authentication:** Sign up, log in, and log out with Firebase Auth
- **Profile Management:** 
  - View and edit user profile information
  - Upload or change profile pictures
  - Customizable profile avatars with initials
- **Module Control:** Toggle and view status of multiple chatbot modules in a responsive grid
- **Chatbot Data:** Access and display chatbot-related data
- **Admin Panel:** 
  - View and approve/reject account creation requests
  - Manage existing user accounts
- **Responsive Design:** Modern UI with gradient themes and interactive elements

## Folder Structure

```
javascript_website/
├── css/
│   └── styles.css
├── js/
│   ├── admin.js
│   ├── auth.js
│   ├── firebase-config.js
│   ├── modules.js
│   ├── profile.js
│   └── chatbot.js
├── pages/
│   ├── admin.html
│   ├── chatbot.html
│   ├── login.html
│   ├── modules.html
│   ├── profile.html
│   └── signup.html
└── index.html
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

   Start the admin server:
   ```bash
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
       // 🔹 Account requests
       match /accountRequests/{requestId} {
         allow create: if true;
         allow read, write: if request.auth != null;
       }
       
       // 🔹 User profiles
       match /users/{userId} {
         allow read: if request.auth != null;
         allow write: if request.auth != null && request.auth.uid == userId;
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
