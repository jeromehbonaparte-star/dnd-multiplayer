// ============================================
// Pub/Sub State Manager
// ============================================

const state = {
  password: '',
  adminPassword: '',
  isAdminAuthenticated: false,
  currentSession: null,
  characters: [],
  sessionCharacters: [],
  socket: null,
  isTurnProcessing: false,
  currentCombat: null,
  storyScrollPosition: 0,

  // Character creation
  charCreationMessages: [],
  charCreationInProgress: false,

  // Modal state
  modalCharacterId: null,
  modalMessages: [],
  modalMode: 'edit',
  adminLoginResolve: null,

  // Level up modal
  levelUpModalCharId: null,
  levelUpMessages: [],

  // Inventory modal
  inventoryModalCharId: null,

  // Spell slots modal
  spellSlotsModalCharId: null,

  // Quick edit modal
  quickEditCharId: null,

  // API config edit
  editingConfigId: null,

  // Session creation
  selectedScenario: 'classic_fantasy',
  selectedCharacterIds: [],

  // Section expand/collapse state
  sectionExpandedStates: {},
  sectionToggleListenerAttached: false,
};

const subscribers = {};

export function getState(key) {
  if (key) return state[key];
  return { ...state };
}

export function setState(updates) {
  Object.assign(state, updates);
  for (const [key, value] of Object.entries(updates)) {
    (subscribers[key] || []).forEach(cb => cb(value, key));
  }
}

export function subscribe(key, callback) {
  if (!subscribers[key]) subscribers[key] = [];
  subscribers[key].push(callback);
  return () => {
    subscribers[key] = subscribers[key].filter(cb => cb !== callback);
  };
}
