// Toggle password visibility
export function initShowPassword() {
  document.querySelectorAll('.toggle-password').forEach(btn => {
    const targetId = btn.dataset.target;
    const input = targetId ? document.getElementById(targetId) : btn.closest('.password-wrap')?.querySelector('input[type="password"], input[type="text"]');
    if (!input) return;
    btn.setAttribute('aria-pressed', 'false');
    btn.addEventListener('click', () => {
      const isPassword = input.type === 'password';
      input.type = isPassword ? 'text' : 'password';
      btn.textContent = isPassword ? 'Hide' : 'Show';
      btn.setAttribute('aria-pressed', isPassword ? 'true' : 'false');
      input.focus();
    });
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', initShowPassword);
}
