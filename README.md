# Chatbot Workplace

A web-based workplace dashboard for managing chatbot modules, user profiles, authentication, and admin account approvals using Firebase.

## Features

- **User Authentication:** Sign up, log in, and log out with Firebase Auth.
- **Profile Management:** View user email and role in a styled profile card.
- **Module Control:** Toggle and view status of multiple chatbot modules in a responsive grid.
- **Chatbot Data:** Access and display chatbot-related data.
- **Admin Page:** View and approve account creation requests.
- **Responsive Design:** Modern UI with a clean, blue-themed layout.

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

## Getting Started

1. **Clone the repository** and open the folder in VS Code.
2. **Configure Firebase:**  
   - Update `js/firebase-config.js` with your Firebase project credentials.
3. **Run locally:**  
   - Open `index.html` in your browser or use a local server extension in VS Code. You can use the Live Server extension.

## Usage

- **Home:**  
  - Main landing page with Login and Sign Up buttons.
- **Login/Sign Up:**  
  - Authenticate users and create new accounts.
- **Modules:**  
  - View and control chatbot modules.
- **Profile:**  
  - View user information and log out.
- **Chatbot Data:**  
  - Display chatbot-related data.
- **Admin:**  
  - Admins can view and approve account creation requests.

## Customization

- **Styling:**  
  - Modify `css/styles.css` for theme changes.
- **Modules:**  
  - Add or edit module panels in `pages/modules.html` and logic in `js/modules.js`.
- **Admin Page:**  
  - Update `pages/admin.html` and `js/admin.js` for admin features.

## Dependencies

- [Firebase JS SDK](https://firebase.google.com/docs/web/setup)
- Modern browsers (Chrome, Edge, Firefox, etc.)

## License

MIT License

---

**Made for Capstone Project 2025**
