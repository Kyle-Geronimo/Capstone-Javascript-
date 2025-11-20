// Lightweight enhancements: validation, inline errors, password toggle, strength bar.
// Drop into ../js/auth-enhancements.js and load after your main auth script.

export function initAuthEnhancements() {
  // Password toggle (works for multiple pages)
  document.querySelectorAll('.show-password-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-target') || btn.closest('.input-wrap')?.querySelector('input[type="password"], input[type="text"]');
      const input = typeof target === 'string' ? document.getElementById(target) : target;
      if (!input) return;
      if (input.type === 'password') {
        input.type = 'text';
        btn.textContent = 'Hide';
        btn.setAttribute('aria-pressed','true');
      } else {
        input.type = 'password';
        btn.textContent = 'Show';
        btn.setAttribute('aria-pressed','false');
      }
      input.focus();
    });
  });

  // Simple inline validation: email + password (can be expanded)
  function setError(el, msg) {
    let err = el.parentElement.querySelector('.error-text');
    if (!err) {
      err = document.createElement('div');
      err.className = 'error-text';
      el.parentElement.appendChild(err);
    }
    err.textContent = msg;
    el.setAttribute('aria-invalid','true');
  }
  function clearError(el) {
    const err = el.parentElement.querySelector('.error-text');
    if (err) err.remove();
    el.removeAttribute('aria-invalid');
  }

  document.querySelectorAll('form[id^="login"], form[id^="signup"]').forEach(form => {
        // We REMOVE the duplicate e.preventDefault() and form.submit() logic.
        // The script now ONLY prevents the default submission if validation FAILS.
        form.addEventListener('submit', e => {
            let valid = true;
            const email = form.querySelector('input[type="email"]');
            const password = form.querySelector('input[type="password"]');

            // Client-side Validation Checks
            if (email) {
                if (!/^\S+@\S+\.\S+$/.test(email.value.trim())) { setError(email, 'Please enter a valid email'); valid = false; }
                else clearError(email);
            }
            if (password) {
                if (password.value.trim().length < 6) { setError(password, 'Password must be at least 6 characters'); valid = false; }
                else clearError(password);
            }

            if (!valid) {
                e.preventDefault(); // <-- IMPORTANT: Stop submission ONLY if invalid
                // focus first invalid
                const firstInvalid = form.querySelector('[aria-invalid="true"]');
                if (firstInvalid) firstInvalid.focus();
                return;
            }
            // If VALID: Do nothing, allowing the event to continue to the main script in login.html
        });
    });

  // Password strength meter for inputs with data-strength="true"
  document.querySelectorAll('input[type="password"][data-strength="true"]').forEach(pw => {
    const meter = document.createElement('div');
    meter.className = 'strength';
    const inner = document.createElement('i');
    meter.appendChild(inner);
    pw.parentElement.appendChild(meter);
    pw.addEventListener('input', () => {
      const val = pw.value || '';
      let score = 0;
      if (val.length >= 8) score += 1;
      if (/[A-Z]/.test(val)) score += 1;
      if (/[0-9]/.test(val)) score += 1;
      if (/[^A-Za-z0-9]/.test(val)) score += 1;
      const pct = Math.min(100, (score / 4) * 100);
      inner.style.width = pct + '%';
      inner.style.filter = pct < 50 ? 'saturate(0.3)' : 'none';
    });
  });
}