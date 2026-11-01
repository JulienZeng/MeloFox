'use strict';
(() => {
  const storageKey = 'douyin-onebot-theme';
  const choices = new Set(['system', 'light', 'dark']);
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  let preference = 'system';
  try {
    const saved = localStorage.getItem(storageKey);
    if (choices.has(saved)) preference = saved;
  } catch {
    // System preference still works when browser storage is unavailable.
  }

  function applyTheme() {
    const theme =
      preference === 'system'
        ? system.matches
          ? 'dark'
          : 'light'
        : preference;
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]').content =
      theme === 'dark' ? '#121a21' : '#f6f7f9';
    document.querySelector('link[rel="icon"]').href =
      theme === 'dark' ? '/logo-dark.svg' : '/logo.svg';
    document.querySelectorAll('[data-theme-asset]').forEach((image) => {
      const asset = image.dataset.themeAsset;
      image.src = `/${asset}${theme === 'dark' ? '-dark' : ''}.svg`;
    });
    document.querySelectorAll('[data-theme-control]').forEach((control) => {
      control.dataset.choice = preference;
    });
    document.querySelectorAll('[data-theme-option]').forEach((option) => {
      option.checked = option.value === preference;
    });
  }

  // Run before the stylesheet is painted to avoid a light flash at startup.
  applyTheme();
  document.addEventListener('DOMContentLoaded', () => {
    applyTheme();
    document.querySelectorAll('[data-theme-option]').forEach((option) => {
      option.addEventListener('change', () => {
        if (!option.checked) return;
        preference = choices.has(option.value) ? option.value : 'system';
        try {
          localStorage.setItem(storageKey, preference);
        } catch {}
        applyTheme();
      });
    });
  });
  system.addEventListener('change', () => {
    if (preference === 'system') applyTheme();
  });
  window.addEventListener('storage', (event) => {
    if (event.key !== storageKey && event.key !== null) return;
    preference = choices.has(event.newValue) ? event.newValue : 'system';
    applyTheme();
  });
})();
