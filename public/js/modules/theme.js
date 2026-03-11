// ============================================
// Theme Toggle
// ============================================

export function toggleTheme() {
  const html = document.documentElement;
  const currentTheme = html.getAttribute('data-theme') || 'dark';
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';

  html.setAttribute('data-theme', newTheme);
  localStorage.setItem('dnd-theme', newTheme);
  updateThemeButton(newTheme);
}

export function updateThemeButton(theme) {
  const icon = document.getElementById('theme-icon');
  const label = document.getElementById('theme-label');
  if (theme === 'light') {
    if (icon) icon.textContent = '\u2600\uFE0F';
    if (label) label.textContent = 'Light';
  } else {
    if (icon) icon.textContent = '\uD83C\uDF19';
    if (label) label.textContent = 'Dark';
  }
}

export function loadTheme() {
  const savedTheme = localStorage.getItem('dnd-theme') || 'dark';
  document.documentElement.setAttribute('data-theme', savedTheme);
  updateThemeButton(savedTheme);
}
