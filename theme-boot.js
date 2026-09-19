// Runs in <head>, before the stylesheets paint anything. chrome.storage is
// async and would answer after the first frame, so a night profile would see
// a flash of paper on every open; localStorage is a synchronous mirror of the
// same choice, kept only for this. MV3 forbids inline scripts, hence a file.
try {
  if (localStorage.getItem('theme') === 'night') document.documentElement.dataset.theme = 'night';
} catch {
  // Storage blocked: the page starts light and dashboard.js corrects it.
}
