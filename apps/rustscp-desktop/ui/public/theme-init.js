// Applies the saved theme before first paint (kept out of index.html so the CSP can forbid inline scripts).
(function () {
  try {
    var mode = localStorage.getItem('rustscp-theme') || 'system';
    var isDark = mode === 'dark' || (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', isDark);
  } catch (e) {}
})();
