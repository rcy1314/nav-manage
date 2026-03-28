(() => {
  try {
    const theme = localStorage.getItem('theme_preference') || 'light';
    if (theme === 'dark') {
      document.documentElement.classList.add('dark-mode');
    }
  } catch (e) {}
})();
