// Global state
let password = '';
let adminPassword = '';
let isAdminAuthenticated = false;
let currentSession = null;
let characters = [];
let socket = null;

// State persistence for mobile tab switching
function saveAppState() {
  const state = {
    password: password,
    currentSessionId: currentSession ? currentSession.id : null,
    currentTab: document.querySelector('.tab-btn.active')?.dataset.tab || 'game',
    charCreationInProgress: charCreationInProgress,
    charCreationMessages: charCreationMessages
  };
  sessionStorage.setItem('dnd-app-state', JSON.stringify(state));
}

function loadAppState() {
  try {
    const saved = sessionStorage.getItem('dnd-app-state');
    if (saved) {
      return JSON.parse(saved);
    }
  } catch (e) {
    console.error('Failed to load app state:', e);
  }
  return null;
}

// Auto-restore session on page load
async function restoreSession() {
  const state = loadAppState();
  if (state && state.password) {
    password = state.password;

    try {
      // Verify password is still valid
      await api('/api/auth', 'POST', { password });

      // Restore app screen
      document.getElementById('login-screen').classList.remove('active');
      document.getElementById('app-screen').classList.add('active');

      initSocket();
      await loadInitialData();

      // Restore active tab
      if (state.currentTab) {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        document.querySelector(`.tab-btn[data-tab="${state.currentTab}"]`)?.classList.add('active');
        document.getElementById(`${state.currentTab}-tab`)?.classList.add('active');
      }

      // Restore current session
      if (state.currentSessionId) {
        await loadSession(state.currentSessionId);
      }

      // Restore character creation state
      if (state.charCreationInProgress && state.charCreationMessages) {
        charCreationInProgress = true;
        charCreationMessages = state.charCreationMessages;

        document.getElementById('start-creation-btn').disabled = true;
        document.getElementById('char-chat-input').disabled = false;
        document.getElementById('char-chat-send').disabled = false;

        // Restore chat messages
        const messagesContainer = document.getElementById('char-chat-messages');
        messagesContainer.innerHTML = state.charCreationMessages
          .filter(m => m.role !== 'system')
          .map(m => `<div class="chat-message ${m.role === 'user' ? 'user' : 'assistant'}"><div class="message-content">${m.role === 'user' ? escapeHtml(m.content) : formatChatMessage(m.content)}</div></div>`)
          .join('');
        scrollChatToBottom();
      }

      return true;
    } catch (e) {
      // Password invalid or session expired
      sessionStorage.removeItem('dnd-app-state');
      return false;
    }
  }
  return false;
}

// Initialize Socket.IO
function initSocket() {
  socket = io();

  socket.on('character_created', (character) => {
    loadCharacters();
  });

  socket.on('character_deleted', (id) => {
    loadCharacters();
  });

  socket.on('session_created', (session) => {
    loadSessions();
  });

  socket.on('session_deleted', (sessionId) => {
    if (currentSession && currentSession.id === sessionId) {
      currentSession = null;
      document.getElementById('story-summary').textContent = '';
      document.getElementById('story-history').innerHTML = '';
      document.getElementById('turn-counter').textContent = 'Turn: 0';
      document.getElementById('token-counter').textContent = 'Tokens: 0';
      document.getElementById('waiting-counter').textContent = 'Waiting for: 0 players';
      document.getElementById('pending-actions').innerHTML = '';
    }
    loadSessions();
  });

  socket.on('action_submitted', ({ sessionId, pendingActions, character_id }) => {
    if (currentSession && currentSession.id === sessionId) {
      updatePendingActions(pendingActions);
    }
  });

  socket.on('turn_processing', ({ sessionId }) => {
    if (currentSession && currentSession.id === sessionId) {
      showNarratorTyping();
    }
  });

  socket.on('turn_processed', ({ sessionId, response, turn, tokensUsed, compacted }) => {
    if (currentSession && currentSession.id === sessionId) {
      hideNarratorTyping();
      loadSession(sessionId);
      if (compacted) {
        showNotification('History was auto-compacted to save tokens!');
      }
    }
  });

  socket.on('character_updated', (character) => {
    loadCharacters();
  });

  socket.on('character_leveled_up', ({ character, summary }) => {
    loadCharacters();
    showNotification(`${character.character_name} leveled up to ${character.level}! ${summary}`);
  });
}

// API helper
async function api(endpoint, method = 'GET', body = null, requireAdmin = false) {
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Game-Password': password
    }
  };

  // Add admin password header if authenticated
  if (adminPassword) {
    options.headers['X-Admin-Password'] = adminPassword;
  }

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(endpoint, options);

  if (response.status === 401) {
    showLogin();
    throw new Error('Unauthorized');
  }

  if (response.status === 403) {
    isAdminAuthenticated = false;
    adminPassword = '';
    throw new Error('Admin access required');
  }

  return response.json();
}

// Admin authentication
let adminLoginResolve = null;

function showAdminModal() {
  document.getElementById('admin-modal').classList.add('active');
  document.getElementById('admin-password-input').value = '';
  document.getElementById('admin-login-error').textContent = '';
  document.getElementById('admin-password-input').focus();
}

function closeAdminModal() {
  document.getElementById('admin-modal').classList.remove('active');
  if (adminLoginResolve) {
    adminLoginResolve(false);
    adminLoginResolve = null;
  }
}

async function submitAdminLogin() {
  const pwd = document.getElementById('admin-password-input').value;
  if (!pwd) {
    document.getElementById('admin-login-error').textContent = 'Please enter a password';
    return;
  }

  try {
    const result = await fetch('/api/admin-auth', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Game-Password': password
      },
      body: JSON.stringify({ adminPassword: pwd })
    });

    if (result.ok) {
      adminPassword = pwd;
      isAdminAuthenticated = true;
      document.getElementById('admin-modal').classList.remove('active');
      if (adminLoginResolve) {
        adminLoginResolve(true);
        adminLoginResolve = null;
      }
    } else {
      const data = await result.json();
      document.getElementById('admin-login-error').textContent = data.error || 'Invalid admin password';
    }
  } catch (error) {
    document.getElementById('admin-login-error').textContent = 'Failed to authenticate';
  }
}

function promptAdminLogin() {
  return new Promise((resolve) => {
    adminLoginResolve = resolve;
    showAdminModal();
  });
}

// Handle Enter key in admin password input
document.addEventListener('DOMContentLoaded', () => {
  const adminInput = document.getElementById('admin-password-input');
  if (adminInput) {
    adminInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') submitAdminLogin();
    });
  }
});

// Authentication
async function login() {
  const input = document.getElementById('password-input');
  password = input.value;

  try {
    await api('/api/auth', 'POST', { password });
    document.getElementById('login-screen').classList.remove('active');
    document.getElementById('app-screen').classList.add('active');
    initSocket();
    await loadInitialData();
    saveAppState(); // Save state after successful login
  } catch (error) {
    document.getElementById('login-error').textContent = 'Invalid password';
  }
}

function showLogin() {
  document.getElementById('app-screen').classList.remove('active');
  document.getElementById('login-screen').classList.add('active');
}

// Tab navigation
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const targetTab = btn.dataset.tab;

    // Require admin password for settings tab
    if (targetTab === 'settings' && !isAdminAuthenticated) {
      const authenticated = await promptAdminLogin();
      if (!authenticated) return;
    }

    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

    btn.classList.add('active');
    document.getElementById(`${targetTab}-tab`).classList.add('active');

    // Load settings when tab is accessed
    if (targetTab === 'settings') {
      loadSettings();
    }

    saveAppState(); // Save state when tab changes
  });
});

// Load initial data
async function loadInitialData() {
  await Promise.all([
    loadCharacters(),
    loadSessions()
  ]);
}

// Settings
let originalMaskedApiKey = ''; // Store the masked key to detect changes

async function loadSettings() {
  try {
    const settings = await api('/api/settings');
    document.getElementById('api-endpoint').value = settings.api_endpoint || '';
    document.getElementById('api-key').value = settings.api_key || '';
    document.getElementById('api-key').placeholder = settings.api_key_set ? 'Key is set (enter new key to change)' : 'sk-...';
    document.getElementById('api-model').value = settings.api_model || '';
    document.getElementById('max-tokens').value = settings.max_tokens_before_compact || 8000;
    originalMaskedApiKey = settings.api_key || '';
  } catch (error) {
    console.error('Failed to load settings:', error);
  }
}

async function saveSettings() {
  const apiKeyInput = document.getElementById('api-key').value;

  // Only send API key if it was changed (not the masked value)
  const apiKeyChanged = apiKeyInput && apiKeyInput !== originalMaskedApiKey && !apiKeyInput.startsWith('****');

  const settings = {
    api_endpoint: document.getElementById('api-endpoint').value,
    api_key: apiKeyChanged ? apiKeyInput : undefined,
    api_model: document.getElementById('api-model').value,
    max_tokens_before_compact: document.getElementById('max-tokens').value,
    new_password: document.getElementById('new-password').value || undefined
  };

  try {
    await api('/api/settings', 'POST', settings);
    document.getElementById('settings-status').textContent = 'Settings saved successfully!';
    if (settings.new_password) {
      password = settings.new_password;
    }
    // Reload settings to get updated masked key
    await loadSettings();
    setTimeout(() => {
      document.getElementById('settings-status').textContent = '';
    }, 3000);
  } catch (error) {
    document.getElementById('settings-status').textContent = 'Failed to save settings';
  }
}

// Test Connection
async function testConnection() {
  const statusEl = document.getElementById('test-status');
  statusEl.textContent = 'Testing connection...';
  statusEl.className = '';

  const testData = {
    api_endpoint: document.getElementById('api-endpoint').value,
    api_key: document.getElementById('api-key').value,
    api_model: document.getElementById('api-model').value
  };

  try {
    const result = await api('/api/test-connection', 'POST', testData);
    statusEl.textContent = `Success! Model: ${result.model} - Response: "${result.message}"`;
    statusEl.className = 'success';
  } catch (error) {
    statusEl.textContent = error.message || 'Connection failed';
    statusEl.className = 'error';
  }
}

// AI Character Creation
let charCreationMessages = [];
let charCreationInProgress = false;

async function startCharacterCreation() {
  if (charCreationInProgress) return;

  charCreationMessages = [];
  charCreationInProgress = true;

  document.getElementById('start-creation-btn').disabled = true;
  document.getElementById('char-chat-input').disabled = false;
  document.getElementById('char-chat-send').disabled = false;

  const messagesContainer = document.getElementById('char-chat-messages');
  messagesContainer.innerHTML = '<div class="chat-message assistant"><div class="message-content">Starting character creation...</div></div>';

  // Send initial message to AI
  try {
    const result = await api('/api/characters/ai-create', 'POST', {
      messages: [{ role: 'user', content: 'I want to create a new character. Please guide me through the process.' }]
    });

    charCreationMessages.push({ role: 'user', content: 'I want to create a new character. Please guide me through the process.' });
    charCreationMessages.push({ role: 'assistant', content: result.message });

    messagesContainer.innerHTML = `<div class="chat-message assistant"><div class="message-content">${formatChatMessage(result.message)}</div></div>`;
    scrollChatToBottom();
    saveAppState(); // Save state after AI response

    document.getElementById('char-chat-input').focus();
  } catch (error) {
    messagesContainer.innerHTML = `<div class="chat-message assistant"><div class="message-content">Error: ${error.message}. Make sure your API is configured in Settings.</div></div>`;
    resetCharacterCreation();
  }
}

async function sendCharacterMessage() {
  const input = document.getElementById('char-chat-input');
  const message = input.value.trim();

  if (!message || !charCreationInProgress) return;

  input.value = '';
  input.disabled = true;
  document.getElementById('char-chat-send').disabled = true;

  const messagesContainer = document.getElementById('char-chat-messages');

  // Add user message
  messagesContainer.innerHTML += `<div class="chat-message user"><div class="message-content">${escapeHtml(message)}</div></div>`;
  scrollChatToBottom();

  charCreationMessages.push({ role: 'user', content: message });

  // Add loading indicator
  messagesContainer.innerHTML += '<div class="chat-message assistant" id="loading-msg"><div class="message-content">Thinking...</div></div>';
  scrollChatToBottom();

  try {
    const result = await api('/api/characters/ai-create', 'POST', {
      messages: charCreationMessages
    });

    // Remove loading indicator
    document.getElementById('loading-msg')?.remove();

    charCreationMessages.push({ role: 'assistant', content: result.message });

    messagesContainer.innerHTML += `<div class="chat-message assistant"><div class="message-content">${formatChatMessage(result.message)}</div></div>`;
    scrollChatToBottom();

    if (result.complete) {
      // Character created!
      charCreationInProgress = false;
      messagesContainer.innerHTML += `<div class="chat-message assistant"><div class="message-content"><strong>Character created successfully!</strong> Check the Characters list.</div></div>`;
      scrollChatToBottom();
      loadCharacters();
      document.getElementById('start-creation-btn').disabled = false;
      saveAppState(); // Save state after completion
    } else {
      input.disabled = false;
      document.getElementById('char-chat-send').disabled = false;
      input.focus();
      saveAppState(); // Save state after AI response
    }
  } catch (error) {
    document.getElementById('loading-msg')?.remove();
    messagesContainer.innerHTML += `<div class="chat-message assistant"><div class="message-content">Error: ${error.message}</div></div>`;
    input.disabled = false;
    document.getElementById('char-chat-send').disabled = false;
  }
}

function resetCharacterCreation() {
  charCreationMessages = [];
  charCreationInProgress = false;

  document.getElementById('start-creation-btn').disabled = false;
  document.getElementById('char-chat-input').disabled = true;
  document.getElementById('char-chat-input').value = '';
  document.getElementById('char-chat-send').disabled = true;

  document.getElementById('char-chat-messages').innerHTML = `
    <div class="chat-message assistant">
      <div class="message-content">Click "Start Character Creation" to begin creating your Level 1 character with AI guidance!</div>
    </div>
  `;
  saveAppState(); // Save state after reset
}

function scrollChatToBottom() {
  const container = document.getElementById('char-chat-messages');
  container.scrollTop = container.scrollHeight;
}

function formatChatMessage(text) {
  return escapeHtml(text)
    .replace(/\n/g, '<br>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>');
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Characters
async function loadCharacters() {
  try {
    characters = await api('/api/characters');
    renderCharactersList();
    updateCharacterSelect();
    updatePartyList();
  } catch (error) {
    console.error('Failed to load characters:', error);
  }
}

// XP requirements for each level
const XP_TABLE = [0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000, 85000, 100000, 120000, 140000, 165000, 195000, 225000, 265000, 305000, 355000];

function getRequiredXP(level) {
  return XP_TABLE[level] || 355000;
}

function canLevelUp(xp, level) {
  return xp >= getRequiredXP(level);
}

function renderCharactersList() {
  const grid = document.getElementById('characters-grid');
  grid.innerHTML = characters.map(c => {
    const xp = c.xp || 0;
    const requiredXP = getRequiredXP(c.level);
    const xpPercent = Math.min((xp / requiredXP) * 100, 100);
    const canLevel = canLevelUp(xp, c.level);

    return `
    <div class="character-card" data-id="${c.id}">
      <button class="delete-btn" onclick="deleteCharacter('${c.id}')">X</button>
      <h3>${c.character_name}</h3>
      <div class="player">Played by ${c.player_name}</div>
      <div class="race-class">${c.race} ${c.class} (Level ${c.level})</div>
      <div class="stats">
        <div class="stat">${c.strength}<span>STR</span></div>
        <div class="stat">${c.dexterity}<span>DEX</span></div>
        <div class="stat">${c.constitution}<span>CON</span></div>
        <div class="stat">${c.intelligence}<span>INT</span></div>
        <div class="stat">${c.wisdom}<span>WIS</span></div>
        <div class="stat">${c.charisma}<span>CHA</span></div>
      </div>
      <div class="hp">HP: ${c.hp}/${c.max_hp}</div>
      <div class="xp-bar"><div class="xp-fill" style="width: ${xpPercent}%"></div></div>
      <div class="xp-text">XP: ${xp} / ${requiredXP}</div>
      ${c.skills ? `<div class="details"><strong>Skills:</strong> ${c.skills}</div>` : ''}
      ${c.spells ? `<div class="details"><strong>Spells:</strong> ${c.spells}</div>` : ''}
      ${c.passives ? `<div class="details"><strong>Passives:</strong> ${c.passives}</div>` : ''}
      <div class="btn-row">
        <button class="btn-edit" onclick="openEditModal('${c.id}')">Edit</button>
        <button class="btn-levelup" onclick="levelUpCharacter('${c.id}')" ${canLevel ? '' : 'disabled'}>${canLevel ? 'Level Up!' : 'Need XP'}</button>
      </div>
    </div>
  `}).join('');
}

function updateCharacterSelect() {
  const select = document.getElementById('action-character');
  select.innerHTML = '<option value="">Select your character</option>' +
    characters.map(c => `<option value="${c.id}">${c.character_name} (${c.player_name})</option>`).join('');
}

function updatePartyList() {
  const list = document.getElementById('party-list');
  list.innerHTML = characters.map(c => {
    const xp = c.xp || 0;
    const requiredXP = getRequiredXP(c.level);
    return `
    <div class="party-item expanded">
      <div class="party-header">
        <div class="name">${c.character_name}</div>
        <div class="level">Lv.${c.level}</div>
      </div>
      <div class="info">${c.race} ${c.class}</div>
      <div class="hp">HP: ${c.hp}/${c.max_hp}</div>
      <div class="xp-info">XP: ${xp}/${requiredXP}</div>
      <div class="party-stats">
        <span>STR:${c.strength}</span>
        <span>DEX:${c.dexterity}</span>
        <span>CON:${c.constitution}</span>
        <span>INT:${c.intelligence}</span>
        <span>WIS:${c.wisdom}</span>
        <span>CHA:${c.charisma}</span>
      </div>
      ${c.skills ? `<div class="party-detail"><strong>Skills:</strong> ${c.skills}</div>` : ''}
      ${c.spells ? `<div class="party-detail"><strong>Spells:</strong> ${c.spells}</div>` : ''}
      ${c.passives ? `<div class="party-detail"><strong>Passives:</strong> ${c.passives}</div>` : ''}
    </div>
  `}).join('');
}


async function deleteCharacter(id) {
  if (!confirm('Are you sure you want to delete this character?')) return;

  try {
    await api(`/api/characters/${id}`, 'DELETE');
  } catch (error) {
    console.error('Failed to delete character:', error);
  }
}

// Sessions
async function loadSessions() {
  try {
    const sessions = await api('/api/sessions');
    const list = document.getElementById('session-list');
    list.innerHTML = sessions.map(s => `
      <div class="session-item ${currentSession && currentSession.id === s.id ? 'active' : ''}">
        <span class="session-name" onclick="loadSession('${s.id}')">${s.name}</span>
        <button class="session-delete-btn" onclick="event.stopPropagation(); deleteSession('${s.id}', '${s.name.replace(/'/g, "\\'")}')" title="Delete session">X</button>
      </div>
    `).join('');
  } catch (error) {
    console.error('Failed to load sessions:', error);
  }
}

async function deleteSession(id, name) {
  if (!confirm(`Are you sure you want to delete the session "${name}"?\n\nThis will permanently delete all story history and progress!`)) {
    return;
  }

  try {
    await api(`/api/sessions/${id}`, 'DELETE');
  } catch (error) {
    console.error('Failed to delete session:', error);
    alert('Failed to delete session: ' + error.message);
  }
}

async function createSession() {
  const name = prompt('Enter session name:');
  if (!name) return;

  try {
    const session = await api('/api/sessions', 'POST', { name });
    loadSession(session.id);
  } catch (error) {
    console.error('Failed to create session:', error);
  }
}

async function loadSession(id) {
  try {
    const data = await api(`/api/sessions/${id}`);
    currentSession = data.session;

    // Update UI
    document.getElementById('turn-counter').textContent = `Turn: ${currentSession.current_turn}`;
    document.getElementById('token-counter').textContent = `Tokens: ${currentSession.total_tokens}`;

    // Render story - summary is now backend-only for AI context
    // Players see the full chat history
    const history = JSON.parse(currentSession.full_history || '[]');
    const historyContainer = document.getElementById('story-history');
    historyContainer.innerHTML = history.map(entry => `
      <div class="story-entry ${entry.role}">
        <div class="role">${entry.role === 'user' ? 'Players' : 'Dungeon Master'}</div>
        <div class="content">${formatContent(entry.content)}</div>
      </div>
    `).join('');

    // Scroll to bottom
    document.getElementById('story-container').scrollTop =
      document.getElementById('story-container').scrollHeight;

    // Update pending actions
    updatePendingActions(data.pendingActions);

    // Update session list to show active
    loadSessions();
    saveAppState(); // Save state when session changes
  } catch (error) {
    console.error('Failed to load session:', error);
  }
}

function updatePendingActions(pendingActions) {
  const container = document.getElementById('pending-actions');
  const waitingCount = characters.length - pendingActions.length;

  document.getElementById('waiting-counter').textContent = `Waiting for: ${waitingCount} players`;

  container.innerHTML = characters.map(c => {
    const action = pendingActions.find(a => a.character_id === c.id);
    return `
      <div class="action-item ${action ? 'submitted' : ''}">
        <div class="player">${c.character_name}</div>
        <div>${action ? 'Action submitted' : 'Waiting...'}</div>
      </div>
    `;
  }).join('');
}

function formatContent(content) {
  return content
    .replace(/\n/g, '<br>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>');
}

// Actions
async function submitAction() {
  if (!currentSession) {
    alert('Please select a session first');
    return;
  }

  const characterId = document.getElementById('action-character').value;
  const action = document.getElementById('action-text').value;

  if (!characterId) {
    alert('Please select your character');
    return;
  }

  if (!action.trim()) {
    alert('Please enter an action');
    return;
  }

  try {
    const result = await api(`/api/sessions/${currentSession.id}/action`, 'POST', {
      character_id: characterId,
      action: action
    });

    document.getElementById('action-text').value = '';

    if (result.processed) {
      loadSession(currentSession.id);
    }
  } catch (error) {
    console.error('Failed to submit action:', error);
    alert('Failed to submit action');
  }
}

async function forceProcessTurn() {
  if (!currentSession) {
    alert('Please select a session first');
    return;
  }

  if (!confirm('Force process the turn with current actions?')) return;

  try {
    await api(`/api/sessions/${currentSession.id}/process`, 'POST');
    loadSession(currentSession.id);
  } catch (error) {
    console.error('Failed to process turn:', error);
    alert('Failed to process turn: ' + error.message);
  }
}

async function recalculateXP() {
  if (!currentSession) {
    alert('Please select a session first');
    return;
  }

  if (!confirm('Recalculate XP from session history? This will scan all DM responses for [XP: ...] tags.')) return;

  try {
    const result = await api(`/api/sessions/${currentSession.id}/recalculate-xp`, 'POST');
    if (result.success) {
      const xpSummary = Object.entries(result.xpAwarded).length > 0
        ? 'XP recalculated successfully!'
        : 'No XP tags found in session history.';
      alert(xpSummary);
      loadCharacters();
    }
  } catch (error) {
    console.error('Failed to recalculate XP:', error);
    alert('Failed to recalculate XP: ' + error.message);
  }
}

function showNotification(message) {
  const notif = document.getElementById('levelup-notification');
  notif.querySelector('.notification-text').textContent = message;
  notif.classList.remove('hidden');
}

function hideLevelUpNotification() {
  document.getElementById('levelup-notification').classList.add('hidden');
}

// Narrator typing indicator
function showNarratorTyping() {
  const indicator = document.getElementById('narrator-typing');
  if (indicator) {
    indicator.classList.remove('hidden');
    // Scroll to show the indicator
    const container = document.getElementById('story-container');
    container.scrollTop = container.scrollHeight;
  }
}

function hideNarratorTyping() {
  const indicator = document.getElementById('narrator-typing');
  if (indicator) {
    indicator.classList.add('hidden');
  }
}

// Mobile menu toggle
function toggleMobileMenu() {
  document.getElementById('nav-tabs').classList.toggle('active');
}

// Modal functions
let modalCharacterId = null;
let modalMessages = [];
let modalMode = 'edit'; // 'edit' or 'levelup'

function openEditModal(charId) {
  modalCharacterId = charId;
  modalMessages = [];
  modalMode = 'edit';

  const char = characters.find(c => c.id === charId);
  document.getElementById('modal-title').textContent = `Edit ${char.character_name}`;
  document.getElementById('modal-chat-messages').innerHTML = `
    <div class="chat-message assistant">
      <div class="message-content">What would you like to change about ${char.character_name}? You can ask me to update stats, equipment, spells, skills, or anything else.</div>
    </div>
  `;
  document.getElementById('modal-input').value = '';
  document.getElementById('char-modal').classList.add('active');
}

function closeModal() {
  document.getElementById('char-modal').classList.remove('active');
  modalCharacterId = null;
  modalMessages = [];
}

async function sendModalMessage() {
  const input = document.getElementById('modal-input');
  const message = input.value.trim();

  if (!message || !modalCharacterId) return;

  input.value = '';
  const messagesContainer = document.getElementById('modal-chat-messages');

  // Add user message
  messagesContainer.innerHTML += `<div class="chat-message user"><div class="message-content">${escapeHtml(message)}</div></div>`;
  messagesContainer.scrollTop = messagesContainer.scrollHeight;

  modalMessages.push({ role: 'user', content: message });

  // Add loading indicator
  messagesContainer.innerHTML += '<div class="chat-message assistant" id="modal-loading"><div class="message-content">Thinking...</div></div>';
  messagesContainer.scrollTop = messagesContainer.scrollHeight;

  try {
    const result = await api(`/api/characters/${modalCharacterId}/edit`, 'POST', {
      editRequest: modalMessages.length === 1 ? message : undefined,
      messages: modalMessages
    });

    document.getElementById('modal-loading')?.remove();

    modalMessages.push({ role: 'assistant', content: result.message });
    messagesContainer.innerHTML += `<div class="chat-message assistant"><div class="message-content">${formatChatMessage(result.message)}</div></div>`;
    messagesContainer.scrollTop = messagesContainer.scrollHeight;

    if (result.complete) {
      loadCharacters();
      messagesContainer.innerHTML += `<div class="chat-message assistant"><div class="message-content"><strong>Changes saved!</strong></div></div>`;
    }
  } catch (error) {
    document.getElementById('modal-loading')?.remove();
    messagesContainer.innerHTML += `<div class="chat-message assistant"><div class="message-content">Error: ${error.message}</div></div>`;
  }
}

async function levelUpCharacter(charId) {
  const char = characters.find(c => c.id === charId);
  if (!char) return;

  if (!confirm(`Level up ${char.character_name} to level ${char.level + 1}?`)) return;

  try {
    const result = await api(`/api/characters/${charId}/levelup`, 'POST');

    if (result.levelUp) {
      showNotification(`${char.character_name} is now level ${result.character.level}! ${result.levelUp.summary}`);
    } else {
      showNotification(`${char.character_name} leveled up! HP increased by ${result.hpIncrease}.`);
    }

    loadCharacters();
  } catch (error) {
    alert('Level up failed: ' + error.message);
  }
}

// Theme toggle
function toggleTheme() {
  const html = document.documentElement;
  const currentTheme = html.getAttribute('data-theme') || 'dark';
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';

  html.setAttribute('data-theme', newTheme);
  localStorage.setItem('dnd-theme', newTheme);
  updateThemeButton(newTheme);
}

function updateThemeButton(theme) {
  const icon = document.getElementById('theme-icon');
  const label = document.getElementById('theme-label');
  if (theme === 'light') {
    icon.textContent = '☀️';
    label.textContent = 'Light';
  } else {
    icon.textContent = '🌙';
    label.textContent = 'Dark';
  }
}

// Load saved theme
function loadTheme() {
  const savedTheme = localStorage.getItem('dnd-theme') || 'dark';
  document.documentElement.setAttribute('data-theme', savedTheme);
  updateThemeButton(savedTheme);
}
loadTheme();

// Enter key handlers - Enter for new line, Shift+Enter to send
document.getElementById('password-input').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') login();
});

// Shift+Enter to send in chat inputs
document.getElementById('char-chat-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.shiftKey) {
    e.preventDefault();
    sendCharacterMessage();
  }
});

document.getElementById('modal-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.shiftKey) {
    e.preventDefault();
    sendModalMessage();
  }
});

// Shift+Enter to submit action
document.getElementById('action-text')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.shiftKey) {
    e.preventDefault();
    submitAction();
  }
});

// Save state before page unloads or becomes hidden (mobile tab switch)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && password) {
    saveAppState();
  }
});

window.addEventListener('beforeunload', () => {
  if (password) {
    saveAppState();
  }
});

// Try to restore session on page load
(async function init() {
  const restored = await restoreSession();
  if (!restored) {
    // No saved state, show login screen
    document.getElementById('login-screen').classList.add('active');
  }
})();
