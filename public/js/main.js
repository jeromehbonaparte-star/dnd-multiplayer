// ============================================
// Main Entry Point - D&D Multiplayer App
// ============================================

import { getState, setState } from './state.js';
import { initSocket } from './socket.js';

// Modules
import { restoreSession, saveAppState, submitAdminLogin, closeAdminModal, promptAdminLogin } from './modules/auth.js';
import {
  loadCharacters, renderCharactersList, updateCharacterSelect, updatePartyList,
  deleteCharacter, resetXP, resetLevel,
  toggleSection, expandAllSections, collapseAllSections,
  startCharacterCreation, sendCharacterMessage, resetCharacterCreation,
  loadSectionStates, attachSectionToggleListeners,
  toggleInventory, formatMulticlass,
  initAvatarUpload
} from './modules/characters.js';
import {
  loadSessions, loadSession, deleteSession,
  openNewSessionModal, closeNewSessionModal, createSession,
  selectScenario, toggleCharacterSelection,
  submitAction, forceProcessTurn, rerollLastResponse, deleteStoryMessage,
  cancelAction, updateActionFormState,
  recalculateXP, recalculateLoot, recalculateInventory, recalculateACSpells,
  rollActionDice, getCurrentDiceRoll,
  updateInspirationDisplay,
  displayChoices, selectChoice, dismissChoices
} from './modules/sessions.js';
import {
  loadSettings, saveSettings,
  addApiConfig, testNewConfig, activateApiConfig, testApiConfig, deleteApiConfig, testConnection,
  loadGMSessionInfo, sendGMMessage,
  loadSessionSummary, saveSummary, forceCompact,
  loadAutoReplyCharacters, onAutoReplyCharacterChange, generateAutoReply
} from './modules/settings.js';
import { editApiConfig, closeApiEditModal, saveApiConfigEdit } from './modules/modals/apiConfig.js';
import { openEditModal, closeModal, sendModalMessage } from './modules/modals/characterEdit.js';
import { levelUpCharacter } from './modules/modals/levelUp.js';
import { openInventoryModal, closeInventoryModal, updateGold, addItemToInventory, removeItemFromInventory } from './modules/modals/inventory.js';
import {
  openSpellSlotsModal, closeSpellSlotsModal,
  updateAcBase, addAcEffect, removeAcEffect, clearTempAcEffects,
  useSpellSlot, restoreSpellSlot, longRest, addSpellSlotLevel, removeSpellSlotLevel
} from './modules/modals/spellSlots.js';
import { openQuickEditModal, closeQuickEditModal, saveQuickEdit, showQuickEditSection } from './modules/modals/quickEdit.js';
import { toggleTheme, loadTheme } from './modules/theme.js';
import { ttsManager, handleTTSClick } from './modules/tts.js';
import { showNotification, hideLevelUpNotification, scrollStoryToBottom, openGameDrawer, closeGameDrawer, toggleGameDrawer } from './utils/dom.js';
import { escapeHtml } from './utils/formatters.js';
import './utils/modalManager.js'; // Registers Escape-to-close handler
import { initKeyboardNavigation, updateTabAriaStates } from './utils/keyboard.js';
import { initWeather, cycleWeather, setWeather } from './modules/weather.js';
import { initCharacterBuilder, saveNewCharacter, resetBuilder } from './modules/characterBuilder.js';

// ============================================
// Expose functions to window for onclick handlers in HTML
// ============================================

// Auth (admin only — game auth handled by EasyPanel basic auth)
window.submitAdminLogin = submitAdminLogin;
window.closeAdminModal = closeAdminModal;

// Theme
window.toggleTheme = toggleTheme;

// Mobile
window.openGameDrawer = openGameDrawer;
window.closeGameDrawer = closeGameDrawer;
window.toggleGameDrawer = toggleGameDrawer;

// Characters
window.deleteCharacter = deleteCharacter;
window.resetXP = resetXP;
window.resetLevel = resetLevel;
window.toggleSection = toggleSection;
window.expandAllSections = expandAllSections;
window.collapseAllSections = collapseAllSections;
window.startCharacterCreation = startCharacterCreation;
window.sendCharacterMessage = sendCharacterMessage;
window.resetCharacterCreation = resetCharacterCreation;
window.toggleInventory = toggleInventory;

// Sessions
window.loadSession = loadSession;
window.deleteSession = deleteSession;
window.openNewSessionModal = openNewSessionModal;
window.closeNewSessionModal = closeNewSessionModal;
window.createSession = createSession;
window.selectScenario = selectScenario;
window.toggleCharacterSelection = toggleCharacterSelection;
window.submitAction = submitAction;
window.forceProcessTurn = forceProcessTurn;
window.rerollLastResponse = rerollLastResponse;
window.deleteStoryMessage = deleteStoryMessage;
window.cancelAction = cancelAction;
window.recalculateXP = recalculateXP;
window.recalculateLoot = recalculateLoot;
window.recalculateInventory = recalculateInventory;
window.recalculateACSpells = recalculateACSpells;
window.rollActionDice = rollActionDice;
window.selectChoice = selectChoice;
window.dismissChoices = dismissChoices;

// Settings
window.saveSettings = saveSettings;
window.addApiConfig = addApiConfig;
window.testNewConfig = testNewConfig;
window.activateApiConfig = activateApiConfig;
window.testApiConfig = testApiConfig;
window.deleteApiConfig = deleteApiConfig;
window.testConnection = testConnection;
window.loadGMSessionInfo = loadGMSessionInfo;
window.sendGMMessage = sendGMMessage;
window.loadSessionSummary = loadSessionSummary;
window.saveSummary = saveSummary;
window.forceCompact = forceCompact;
window.loadAutoReplyCharacters = loadAutoReplyCharacters;
window.onAutoReplyCharacterChange = onAutoReplyCharacterChange;
window.generateAutoReply = generateAutoReply;

// Modals
window.editApiConfig = editApiConfig;
window.closeApiEditModal = closeApiEditModal;
window.saveApiConfigEdit = saveApiConfigEdit;
window.openEditModal = openEditModal;
window.closeModal = closeModal;
window.sendModalMessage = sendModalMessage;
window.levelUpCharacter = levelUpCharacter;
window.openInventoryModal = openInventoryModal;
window.closeInventoryModal = closeInventoryModal;
window.updateGold = updateGold;
window.addItemToInventory = addItemToInventory;
window.removeItemFromInventory = removeItemFromInventory;
window.openSpellSlotsModal = openSpellSlotsModal;
window.closeSpellSlotsModal = closeSpellSlotsModal;
window.updateAcBase = updateAcBase;
window.addAcEffect = addAcEffect;
window.removeAcEffect = removeAcEffect;
window.clearTempAcEffects = clearTempAcEffects;
window.useSpellSlot = useSpellSlot;
window.restoreSpellSlot = restoreSpellSlot;
window.longRest = longRest;
window.addSpellSlotLevel = addSpellSlotLevel;
window.removeSpellSlotLevel = removeSpellSlotLevel;
window.openQuickEditModal = openQuickEditModal;
window.closeQuickEditModal = closeQuickEditModal;
window.saveQuickEdit = saveQuickEdit;
window.showQuickEditSection = showQuickEditSection;

// TTS
window.ttsManager = ttsManager;
window.handleTTSClick = handleTTSClick;

// Notifications
window.hideLevelUpNotification = hideLevelUpNotification;

// Weather
window.cycleWeather = cycleWeather;
window.setWeather = setWeather;

// Character Builder
window.saveNewCharacter = saveNewCharacter;
window.resetBuilder = resetBuilder;

// ============================================
// Global click handler for section toggles (capture phase)
// ============================================

document.addEventListener('click', function(e) {
  const header = e.target.closest('.section-header');
  if (header) {
    const parent = header.closest('.section-collapsible');
    if (parent) {
      const charId = parent.dataset.char;
      const section = parent.dataset.section;
      if (charId && section) {
        console.log('Global handler caught click on section:', { charId, section });
        e.preventDefault();
        e.stopPropagation();
        toggleSection(charId, section);
      }
    }
  }
}, true);

// ============================================
// Load initial data (exported for restoreSession)
// ============================================

export async function loadInitialData() {
  await Promise.all([
    loadCharacters(),
    loadSessions()
  ]);
}

// ============================================
// Tab navigation (exported for restoreSession)
// ============================================

export function setupTabNavigation() {
  // Already set up by the DOMContentLoaded handler below
}

// ============================================
// Initialize
// ============================================

// Load theme immediately (before DOMContentLoaded)
loadTheme();

// Load section states immediately
loadSectionStates();

// Set up event listeners once DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  // Initialize keyboard navigation (Ctrl+Enter, arrow keys, focus management)
  initKeyboardNavigation();

  // Initialize weather effect system (starts disabled)
  initWeather();

  // Initialize character builder form
  initCharacterBuilder();

  // Initialize avatar click-to-upload
  initAvatarUpload();

  // Persist character selection + update inspiration display + re-filter choices on change
  const charSelect = document.getElementById('action-character');
  if (charSelect) charSelect.addEventListener('change', () => {
    localStorage.setItem('dnd-selected-character', charSelect.value);
    updateInspirationDisplay();
    // Re-filter choices for newly selected character
    const pendingChoices = getState('pendingChoices');
    if (pendingChoices) displayChoices(pendingChoices);
  });

  // Shared tab switching function
  async function switchTab(targetTab) {
    const currentTab = document.querySelector('.tab-btn.active')?.dataset.tab
                    || document.querySelector('.bottom-nav-btn.active')?.dataset.tab;

    // Require admin password for settings tab
    if (targetTab === 'settings' && !getState('isAdminAuthenticated')) {
      const authenticated = await promptAdminLogin();
      if (!authenticated) return;
    }

    // Save scroll position when leaving game tab
    if (currentTab === 'game') {
      const storyContainer = document.getElementById('story-container');
      if (storyContainer) {
        setState({ storyScrollPosition: storyContainer.scrollTop });
      }
    }

    // Update all tab button active states (top nav + bottom nav)
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.bottom-nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

    // Activate matching buttons
    document.querySelectorAll(`.tab-btn[data-tab="${targetTab}"]`).forEach(b => b.classList.add('active'));
    document.querySelectorAll(`.bottom-nav-btn[data-tab="${targetTab}"]`).forEach(b => b.classList.add('active'));
    document.getElementById(`${targetTab}-tab`)?.classList.add('active');

    // Update ARIA states
    const activeBtn = document.querySelector(`.tab-btn[data-tab="${targetTab}"]`);
    if (activeBtn) updateTabAriaStates(activeBtn);

    // Restore scroll position when returning to game tab
    if (targetTab === 'game') {
      requestAnimationFrame(() => {
        const storyContainer = document.getElementById('story-container');
        if (storyContainer) {
          storyContainer.scrollTop = getState('storyScrollPosition');
        }
      });
    }

    // Load settings when tab is accessed
    if (targetTab === 'settings') {
      loadSettings();
    }

    saveAppState();
  }

  // Wire top nav tab buttons
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Wire bottom nav buttons
  document.querySelectorAll('.bottom-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Drawer toggle
  const drawerToggle = document.getElementById('drawer-toggle');
  if (drawerToggle) drawerToggle.addEventListener('click', toggleGameDrawer);

  // Drawer overlay click-to-close
  const drawerOverlay = document.getElementById('drawer-overlay');
  if (drawerOverlay) drawerOverlay.addEventListener('click', closeGameDrawer);

  // Enter key on admin password input
  const adminInput = document.getElementById('admin-password-input');
  if (adminInput) {
    adminInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') submitAdminLogin();
    });
  }

  // Shift+Enter to send in char chat
  const charChatInput = document.getElementById('char-chat-input');
  if (charChatInput) {
    charChatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        sendCharacterMessage();
      }
    });
  }

  // Shift+Enter to send in modal input
  const modalInput = document.getElementById('modal-input');
  if (modalInput) {
    modalInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        sendModalMessage();
      }
    });
  }

  // Shift+Enter to submit action
  const actionText = document.getElementById('action-text');
  if (actionText) {
    actionText.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        submitAction();
      }
    });
  }

  // Save state before page unloads or becomes hidden
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      saveAppState();
    }
  });

  window.addEventListener('beforeunload', () => {
    saveAppState();
  });
});

// ============================================
// Initialize app
// ============================================

(async function init() {
  // Show app screen immediately (auth handled by EasyPanel basic auth)
  document.getElementById('app-screen').classList.add('active');

  const restored = await restoreSession();
  if (!restored) {
    // First visit — initialize socket and load data
    initSocket();
    await loadInitialData();
  }
})();

// Extra scroll attempt after full page load (helps mobile)
window.addEventListener('load', () => {
  if (getState('currentSession')) {
    setTimeout(scrollStoryToBottom, 500);
    setTimeout(scrollStoryToBottom, 1500);
  }
});
