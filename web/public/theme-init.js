// Apply the saved preference before styles load; interactive controls live in Vue.
(() => {
  let preference = 'system';
  try { preference = localStorage.getItem('douyin-onebot-theme') || 'system'; } catch {}
  const dark = preference === 'dark' || (preference !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]').content = dark ? '#171c26' : '#fbf7f2';
  document.querySelector('link[rel="icon"]').href = dark ? '/logo-dark.svg' : '/logo.svg';
})();
