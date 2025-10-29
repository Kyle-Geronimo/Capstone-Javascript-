// Add a small module to toggle show/hide for password inputs.
// It looks for buttons with class "toggle-password" and a data-target pointing to the input id.
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