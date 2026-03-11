// ============================================
// DOM Helper Utilities
// ============================================

/**
 * Show a notification banner using the levelup-notification element.
 */
export function showNotification(message) {
  const notif = document.getElementById('levelup-notification');
  if (!notif) return;
  notif.querySelector('.notification-text').textContent = message;
  notif.classList.remove('hidden');
}

export function hideLevelUpNotification() {
  const el = document.getElementById('levelup-notification');
  if (el) el.classList.add('hidden');
}

/**
 * Connection status indicator.
 */
export function showConnectionStatus(message, type = 'warning') {
  let statusEl = document.getElementById('connection-status');
  if (!statusEl) {
    statusEl = document.createElement('div');
    statusEl.id = 'connection-status';
    document.body.appendChild(statusEl);
  }
  statusEl.textContent = message;
  statusEl.className = `connection-status ${type}`;
  statusEl.style.display = 'block';
}

export function hideConnectionStatus() {
  const statusEl = document.getElementById('connection-status');
  if (statusEl) {
    statusEl.style.display = 'none';
  }
}

/**
 * Narrator typing indicator.
 */
export function showNarratorTyping() {
  const indicator = document.getElementById('narrator-typing');
  if (indicator) {
    indicator.classList.remove('hidden');
    const container = document.getElementById('story-container');
    if (container) container.scrollTop = container.scrollHeight;
  }
}

export function hideNarratorTyping() {
  const indicator = document.getElementById('narrator-typing');
  if (indicator) {
    indicator.classList.add('hidden');
  }
}

/**
 * Scroll story container to bottom with delays for mobile compatibility.
 */
export function scrollStoryToBottom() {
  const container = document.getElementById('story-container');
  if (!container) return;

  const doScroll = () => {
    container.scrollTop = container.scrollHeight;

    const historyContainer = document.getElementById('story-history');
    if (historyContainer && historyContainer.lastElementChild) {
      historyContainer.lastElementChild.scrollIntoView({ block: 'end', behavior: 'instant' });
    }
  };

  doScroll();
  requestAnimationFrame(() => {
    doScroll();
    setTimeout(doScroll, 100);
    setTimeout(doScroll, 300);
    setTimeout(doScroll, 500);
    setTimeout(doScroll, 1000);
  });
}

/**
 * Scroll chat messages container to bottom.
 */
export function scrollChatToBottom() {
  const container = document.getElementById('char-chat-messages');
  if (container) container.scrollTop = container.scrollHeight;
}

/**
 * Mobile menu toggle.
 */
export function toggleMobileMenu() {
  const navTabs = document.getElementById('nav-tabs');
  if (navTabs) navTabs.classList.toggle('active');
}
