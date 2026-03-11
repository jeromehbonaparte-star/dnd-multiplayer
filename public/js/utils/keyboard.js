// ============================================
// Keyboard Navigation Utilities
// ============================================

import { getState } from '../state.js';

/**
 * Initialize keyboard navigation handlers.
 * - Ctrl+Enter to submit action
 * - Arrow keys in tab systems
 * - Focus management for modals
 */
export function initKeyboardNavigation() {
  // Ctrl+Enter to submit action from the action textarea
  const actionTextarea = document.getElementById('action-text');
  if (actionTextarea) {
    actionTextarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        const submitBtn = document.querySelector('.action-input button[onclick*="submitAction"]');
        if (submitBtn && !submitBtn.disabled) {
          submitBtn.click();
        }
      }
    });
  }

  // Arrow keys for main nav tabs
  setupTablistKeyboard(document.getElementById('nav-tabs'));

  // Arrow keys for quick-edit tabs
  setupTablistKeyboard(document.querySelector('.quick-edit-tabs'));

  // Focus trap and management for modals
  setupModalFocusManagement();
}

/**
 * Set up arrow key navigation for a tablist element.
 * Left/Right arrows move between tabs and activate them.
 */
function setupTablistKeyboard(tablist) {
  if (!tablist) return;

  tablist.addEventListener('keydown', (e) => {
    const tabs = Array.from(tablist.querySelectorAll('[role="tab"], .tab-btn, .quick-edit-tab'));
    const currentIndex = tabs.indexOf(document.activeElement);

    if (currentIndex === -1) return;

    let newIndex = currentIndex;

    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      newIndex = (currentIndex + 1) % tabs.length;
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      newIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    } else if (e.key === 'Home') {
      e.preventDefault();
      newIndex = 0;
    } else if (e.key === 'End') {
      e.preventDefault();
      newIndex = tabs.length - 1;
    } else {
      return;
    }

    tabs[newIndex].focus();
    tabs[newIndex].click();
  });
}

/**
 * Track focus before modal opens and restore it when modal closes.
 * Also traps focus within the active modal.
 */
function setupModalFocusManagement() {
  let _previousFocus = null;

  // Use a MutationObserver to detect when modals open/close
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type !== 'attributes' || mutation.attributeName !== 'class') continue;
      const target = mutation.target;
      if (!target.classList.contains('modal')) continue;

      if (target.classList.contains('active')) {
        // Modal opened: save focus, move focus into modal
        _previousFocus = document.activeElement;
        requestAnimationFrame(() => {
          const firstFocusable = getFirstFocusable(target);
          if (firstFocusable) firstFocusable.focus();
        });
      } else {
        // Modal closed: restore focus
        if (_previousFocus && typeof _previousFocus.focus === 'function') {
          requestAnimationFrame(() => {
            _previousFocus.focus();
            _previousFocus = null;
          });
        }
      }
    }
  });

  // Observe all modals for class changes
  document.querySelectorAll('.modal').forEach((modal) => {
    observer.observe(modal, { attributes: true, attributeFilter: ['class'] });
  });

  // Tab trap: keep focus within the active modal
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;

    const activeModal = document.querySelector('.modal.active');
    if (!activeModal) return;

    const focusable = getFocusableElements(activeModal);
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });
}

/**
 * Update aria-selected attributes on tab buttons in main nav.
 * Call this after switching tabs.
 */
export function updateTabAriaStates(activeTabBtn) {
  const tablist = activeTabBtn.closest('[role="tablist"], .nav-tabs, .quick-edit-tabs');
  if (!tablist) return;

  tablist.querySelectorAll('[role="tab"], .tab-btn, .quick-edit-tab').forEach(btn => {
    const isActive = btn === activeTabBtn;
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });
}

/**
 * Get all focusable elements within a container.
 */
function getFocusableElements(container) {
  return Array.from(container.querySelectorAll(
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )).filter(el => el.offsetParent !== null); // Only visible elements
}

/**
 * Get the first focusable element within a container.
 */
function getFirstFocusable(container) {
  const elements = getFocusableElements(container);
  return elements.length > 0 ? elements[0] : null;
}
