// ============================================
// Modal Manager (Unified open/close helpers)
// ============================================
// Currently the app uses classList.add/remove('active') directly.
// This module provides a centralized API if needed in the future.

export const ModalManager = {
  open(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
      modal.classList.add('active');
      document.body.style.overflow = 'hidden';
    }
  },

  close(modalId) {
    if (modalId) {
      const modal = document.getElementById(modalId);
      if (modal) modal.classList.remove('active');
    } else {
      // Close all modals
      document.querySelectorAll('.modal.active').forEach(m => m.classList.remove('active'));
    }
    // Restore body scroll if no modals are open
    if (!document.querySelector('.modal.active')) {
      document.body.style.overflow = '';
    }
  },

  isOpen(modalId) {
    const modal = document.getElementById(modalId);
    return modal ? modal.classList.contains('active') : false;
  }
};

// Optional: global Escape key to close topmost modal
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const activeModals = document.querySelectorAll('.modal.active');
    if (activeModals.length > 0) {
      const topModal = activeModals[activeModals.length - 1];
      const closeBtn = topModal.querySelector('.modal-close');
      if (closeBtn) closeBtn.click();
    }
  }
});
