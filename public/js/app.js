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
async function loadSettings() {
  try {
    const settings = await api('/api/settings');
    document.getElementById('max-tokens').value = settings.max_tokens_before_compact || 8000;
    // Load API configurations
    await loadApiConfigs();
  } catch (error) {
    console.error('Failed to load settings:', error);
  }
}

// Load API Configurations
async function loadApiConfigs() {
  try {
    const configs = await api('/api/api-configs');
    const listEl = document.getElementById('api-configs-list');

    if (!configs || configs.length === 0) {
      listEl.innerHTML = '<div class="no-configs-message">No API configurations yet. Add one below to get started.</div>';
      return;
    }

    listEl.innerHTML = configs.map(config => `
      <div class="api-config-card ${config.is_active ? 'active' : ''}" data-id="${config.id}">
        <div class="config-header">
          <span class="config-name">${escapeHtml(config.name)}</span>
        </div>
        <div class="config-details">
          <span><span class="label">Endpoint:</span> <span class="value">${escapeHtml(config.endpoint)}</span></span>
          <span><span class="label">Model:</span> <span class="value">${escapeHtml(config.model)}</span></span>
          <span><span class="label">API Key:</span> <span class="value">${escapeHtml(config.api_key)}</span></span>
        </div>
        <div class="config-actions">
          <button class="btn-activate" onclick="activateApiConfig('${config.id}')">Activate</button>
          <button class="btn-test-config" onclick="testApiConfig('${config.id}')">Test</button>
          <button class="btn-delete" onclick="deleteApiConfig('${config.id}')">Delete</button>
        </div>
      </div>
    `).join('');
  } catch (error) {
    console.error('Failed to load API configs:', error);
  }
}

// Add new API Configuration
async function addApiConfig() {
  const name = document.getElementById('new-config-name').value.trim();
  const endpoint = document.getElementById('new-config-endpoint').value.trim();
  const api_key = document.getElementById('new-config-key').value.trim();
  const model = document.getElementById('new-config-model').value.trim();
  const is_active = document.getElementById('new-config-active').checked;
  const statusEl = document.getElementById('new-config-status');

  if (!name || !endpoint || !api_key || !model) {
    statusEl.textContent = 'All fields are required';
    statusEl.className = 'error';
    return;
  }

  try {
    await api('/api/api-configs', 'POST', { name, endpoint, api_key, model, is_active });
    statusEl.textContent = 'Configuration added successfully!';
    statusEl.className = 'success';

    // Clear form
    document.getElementById('new-config-name').value = '';
    document.getElementById('new-config-endpoint').value = '';
    document.getElementById('new-config-key').value = '';
    document.getElementById('new-config-model').value = '';
    document.getElementById('new-config-active').checked = false;

    // Reload configs
    await loadApiConfigs();

    setTimeout(() => { statusEl.textContent = ''; }, 3000);
  } catch (error) {
    statusEl.textContent = error.message || 'Failed to add configuration';
    statusEl.className = 'error';
  }
}

// Test new config before adding
async function testNewConfig() {
  const statusEl = document.getElementById('new-config-status');
  statusEl.textContent = 'Testing connection...';
  statusEl.className = '';

  const testData = {
    api_endpoint: document.getElementById('new-config-endpoint').value.trim(),
    api_key: document.getElementById('new-config-key').value.trim(),
    api_model: document.getElementById('new-config-model').value.trim()
  };

  if (!testData.api_endpoint || !testData.api_key || !testData.api_model) {
    statusEl.textContent = 'Please fill in endpoint, API key, and model';
    statusEl.className = 'error';
    return;
  }

  try {
    const result = await api('/api/test-connection', 'POST', testData);
    statusEl.textContent = `Connection successful! Response: ${result.message}`;
    statusEl.className = 'success';
  } catch (error) {
    statusEl.textContent = `Connection failed: ${error.message}`;
    statusEl.className = 'error';
  }
}

// Activate specific API config
async function activateApiConfig(id) {
  try {
    await api(`/api/api-configs/${id}/activate`, 'POST');
    await loadApiConfigs();
  } catch (error) {
    alert('Failed to activate configuration: ' + error.message);
  }
}

// Test existing API config
async function testApiConfig(id) {
  // Get the card to show testing status
  const card = document.querySelector(`.api-config-card[data-id="${id}"]`);
  const btn = card.querySelector('.btn-test-config');
  const originalText = btn.textContent;
  btn.textContent = 'Testing...';
  btn.disabled = true;

  try {
    // Use the test-config endpoint with the config ID
    const result = await api(`/api/test-connection/${id}`, 'POST');
    btn.textContent = 'Success!';
    btn.style.color = 'var(--success)';
    btn.style.borderColor = 'var(--success)';
    setTimeout(() => {
      btn.textContent = originalText;
      btn.style.color = '';
      btn.style.borderColor = '';
      btn.disabled = false;
    }, 2000);
  } catch (error) {
    btn.textContent = 'Failed';
    btn.style.color = 'var(--danger)';
    btn.style.borderColor = 'var(--danger)';
    setTimeout(() => {
      btn.textContent = originalText;
      btn.style.color = '';
      btn.style.borderColor = '';
      btn.disabled = false;
    }, 2000);
  }
}

// Delete API config
async function deleteApiConfig(id) {
  if (!confirm('Are you sure you want to delete this API configuration?')) {
    return;
  }

  try {
    await api(`/api/api-configs/${id}`, 'DELETE');
    await loadApiConfigs();
  } catch (error) {
    alert('Failed to delete configuration: ' + error.message);
  }
}

async function saveSettings() {
  const settings = {
    max_tokens_before_compact: document.getElementById('max-tokens').value,
    new_password: document.getElementById('new-password').value || undefined
  };

  try {
    await api('/api/settings', 'POST', settings);
    document.getElementById('settings-status').textContent = 'Settings saved successfully!';
    if (settings.new_password) {
      password = settings.new_password;
    }
    setTimeout(() => {
      document.getElementById('settings-status').textContent = '';
    }, 3000);
  } catch (error) {
    document.getElementById('settings-status').textContent = 'Failed to save settings';
  }
}

// Test Connection (legacy - for backward compatibility)
async function testConnection() {
  // Redirect to testing the active config
  const activeCard = document.querySelector('.api-config-card.active');
  if (activeCard) {
    const id = activeCard.dataset.id;
    await testApiConfig(id);
  } else {
    alert('No active API configuration. Please add and activate one first.');
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
    const gold = c.gold || 0;
    const ac = c.ac || 10;
    let inventory = [];
    try {
      inventory = JSON.parse(c.inventory || '[]');
    } catch (e) {
      inventory = [];
    }
    const itemCount = inventory.reduce((sum, item) => sum + (item.quantity || 1), 0);

    // Parse spell slots
    let spellSlots = {};
    try {
      spellSlots = JSON.parse(c.spell_slots || '{}');
    } catch (e) {
      spellSlots = {};
    }
    const spellSlotsDisplay = formatSpellSlots(spellSlots);

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
      <div class="combat-stats">
        <div class="hp">HP: ${c.hp}/${c.max_hp}</div>
        <div class="ac-display">AC: ${ac}</div>
      </div>
      <div class="gold-display">Gold: ${gold}</div>
      ${spellSlotsDisplay ? `<div class="spell-slots-display">${spellSlotsDisplay}</div>` : ''}
      <div class="xp-bar"><div class="xp-fill" style="width: ${xpPercent}%"></div></div>
      <div class="xp-text">XP: ${xp} / ${requiredXP}</div>
      ${c.skills ? `<div class="details"><strong>Skills:</strong> ${c.skills}</div>` : ''}
      ${c.spells ? `<div class="details"><strong>Spells:</strong> ${c.spells}</div>` : ''}
      ${c.passives ? `<div class="details"><strong>Passives:</strong> ${c.passives}</div>` : ''}
      <div class="inventory-section">
        <div class="inventory-header" onclick="toggleInventory('${c.id}')">
          <strong>Inventory (${itemCount} items)</strong>
          <span class="inventory-toggle">+</span>
        </div>
        <div class="inventory-list" id="inventory-${c.id}" style="display: none;">
          ${inventory.length > 0 ? inventory.map(item => `<div class="inventory-item">${item.name}${item.quantity > 1 ? ' x' + item.quantity : ''}</div>`).join('') : '<div class="inventory-empty">No items</div>'}
        </div>
      </div>
      <div class="btn-row">
        <button class="btn-edit" onclick="openEditModal('${c.id}')">Edit</button>
        <button class="btn-inventory" onclick="openInventoryModal('${c.id}')">Inventory</button>
        <button class="btn-levelup" onclick="levelUpCharacter('${c.id}')" ${canLevel ? '' : 'disabled'}>${canLevel ? 'Level Up!' : 'Need XP'}</button>
      </div>
      <div class="btn-row">
        <button class="btn-reset-xp" onclick="resetXP('${c.id}', '${c.character_name.replace(/'/g, "\\'")}')">Reset XP</button>
        <button class="btn-spells" onclick="openSpellSlotsModal('${c.id}')">Spell Slots</button>
      </div>
    </div>
  `}).join('');
}

function formatSpellSlots(spellSlots) {
  const levels = Object.keys(spellSlots).sort((a, b) => parseInt(a) - parseInt(b));
  if (levels.length === 0) return '';

  return '<strong>Spell Slots:</strong> ' + levels.map(lvl => {
    const slot = spellSlots[lvl];
    const available = (slot.max || 0) - (slot.used || 0);
    return `${lvl}st: ${available}/${slot.max || 0}`;
  }).join(' | ').replace(/1st/g, '1st').replace(/2st/g, '2nd').replace(/3st/g, '3rd');
}

function toggleInventory(charId) {
  const list = document.getElementById(`inventory-${charId}`);
  const isHidden = list.style.display === 'none';
  list.style.display = isHidden ? 'block' : 'none';
  // Update toggle icon
  const card = list.closest('.character-card');
  const toggle = card.querySelector('.inventory-toggle');
  toggle.textContent = isHidden ? '-' : '+';
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
    const gold = c.gold || 0;
    const ac = c.ac || 10;
    const canLevel = canLevelUp(xp, c.level);
    let inventory = [];
    try {
      inventory = JSON.parse(c.inventory || '[]');
    } catch (e) {
      inventory = [];
    }
    const itemCount = inventory.reduce((sum, item) => sum + (item.quantity || 1), 0);

    // Parse spell slots for party display
    let spellSlots = {};
    try {
      spellSlots = JSON.parse(c.spell_slots || '{}');
    } catch (e) {
      spellSlots = {};
    }
    const spellSlotsShort = formatSpellSlotsShort(spellSlots);

    return `
    <div class="party-item expanded">
      <div class="party-header">
        <div class="name">${c.character_name}</div>
        <div class="level">Lv.${c.level}</div>
      </div>
      <div class="info">${c.race} ${c.class}</div>
      <div class="combat-info">
        <span class="hp">HP: ${c.hp}/${c.max_hp}</span>
        <span class="ac-info">AC: ${ac}</span>
      </div>
      <div class="gold-info">Gold: ${gold}</div>
      ${spellSlotsShort ? `<div class="spell-info">${spellSlotsShort}</div>` : ''}
      <div class="xp-info">XP: ${xp}/${requiredXP} ${canLevel ? '(Ready!)' : ''}</div>
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
      <div class="party-detail"><strong>Items:</strong> ${itemCount > 0 ? inventory.map(i => `${i.name}${i.quantity > 1 ? ' x' + i.quantity : ''}`).join(', ') : 'None'}</div>
      <div class="party-actions">
        <button class="party-btn" onclick="openInventoryModal('${c.id}')">Inv</button>
        <button class="party-btn" onclick="openSpellSlotsModal('${c.id}')">Spells</button>
        <button class="party-btn ${canLevel ? 'party-btn-levelup' : ''}" onclick="levelUpCharacter('${c.id}')" ${canLevel ? '' : 'disabled'}>${canLevel ? 'Level Up!' : 'Need XP'}</button>
      </div>
    </div>
  `}).join('');
}

function formatSpellSlotsShort(spellSlots) {
  const levels = Object.keys(spellSlots).sort((a, b) => parseInt(a) - parseInt(b));
  if (levels.length === 0) return '';

  return 'Slots: ' + levels.map(lvl => {
    const slot = spellSlots[lvl];
    const available = (slot.max || 0) - (slot.used || 0);
    return `L${lvl}:${available}/${slot.max || 0}`;
  }).join(' ');
}


async function deleteCharacter(id) {
  if (!confirm('Are you sure you want to delete this character?')) return;

  try {
    await api(`/api/characters/${id}`, 'DELETE');
  } catch (error) {
    console.error('Failed to delete character:', error);
  }
}

async function resetXP(id, name) {
  if (!confirm(`Reset ${name}'s XP to 0? This cannot be undone.`)) return;

  try {
    await api(`/api/characters/${id}/reset-xp`, 'POST');
    showNotification(`${name}'s XP has been reset to 0`);
    loadCharacters();
  } catch (error) {
    console.error('Failed to reset XP:', error);
    alert('Failed to reset XP: ' + error.message);
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

async function recalculateLoot() {
  if (!currentSession) {
    alert('Please select a session first');
    return;
  }

  if (!confirm('Recalculate gold and inventory from session history? This will scan all DM responses for [GOLD: ...] and [ITEM: ...] tags.')) return;

  try {
    const result = await api(`/api/sessions/${currentSession.id}/recalculate-loot`, 'POST');
    if (result.success) {
      const goldCount = Object.values(result.goldAwarded).filter(g => g !== 0).length;
      const itemCount = Object.values(result.inventoryChanges).filter(arr => arr.length > 0).length;
      const summary = goldCount > 0 || itemCount > 0
        ? `Loot recalculated! Found gold for ${goldCount} characters and items for ${itemCount} characters.`
        : 'No [GOLD: ...] or [ITEM: ...] tags found in session history.';
      alert(summary);
      loadCharacters();
    }
  } catch (error) {
    console.error('Failed to recalculate loot:', error);
    alert('Failed to recalculate loot: ' + error.message);
  }
}

async function recalculateACSpells() {
  if (!currentSession) {
    alert('Please select a session first');
    return;
  }

  if (!confirm('Recalculate AC and spell slots from session history? This will scan for:\n- [SPELL: ...] tags\n- Natural language spell casting mentions\n- AC mentions in DM responses')) return;

  try {
    const result = await api(`/api/sessions/${currentSession.id}/recalculate-ac-spells`, 'POST');
    if (result.success) {
      const acCount = Object.keys(result.acUpdated || {}).length;
      const spellCount = Object.keys(result.spellSlotsUpdated || {}).length;

      let summary = 'Recalculation complete!\n';
      if (acCount > 0) {
        summary += `AC updated for: ${Object.entries(result.acUpdated).map(([name, ac]) => `${name} (AC ${ac})`).join(', ')}\n`;
      }
      if (spellCount > 0) {
        summary += `Spell slots detected for: ${Object.keys(result.spellSlotsUpdated).join(', ')}`;
      }
      if (acCount === 0 && spellCount === 0) {
        summary = 'No AC or spell slot information found in session history.\nTip: You can manually set these values using the Spells button on each character.';
      }
      alert(summary);
      loadCharacters();
    }
  } catch (error) {
    console.error('Failed to recalculate AC/spells:', error);
    alert('Failed to recalculate AC/spells: ' + error.message);
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
  levelUpModalCharId = null;
  levelUpMessages = [];
}

async function sendModalMessage() {
  const input = document.getElementById('modal-input');
  const message = input.value.trim();

  // Determine which mode we're in
  const isLevelUp = levelUpModalCharId !== null;
  const charId = isLevelUp ? levelUpModalCharId : modalCharacterId;

  if (!message || !charId) return;

  input.value = '';
  const messagesContainer = document.getElementById('modal-chat-messages');

  // Add user message
  messagesContainer.innerHTML += `<div class="chat-message user"><div class="message-content">${escapeHtml(message)}</div></div>`;
  messagesContainer.scrollTop = messagesContainer.scrollHeight;

  if (isLevelUp) {
    levelUpMessages.push({ role: 'user', content: message });
  } else {
    modalMessages.push({ role: 'user', content: message });
  }

  // Add loading indicator
  messagesContainer.innerHTML += '<div class="chat-message assistant" id="modal-loading"><div class="message-content">Thinking...</div></div>';
  messagesContainer.scrollTop = messagesContainer.scrollHeight;

  try {
    let result;
    if (isLevelUp) {
      result = await api(`/api/characters/${charId}/levelup`, 'POST', {
        messages: levelUpMessages
      });
      levelUpMessages.push({ role: 'assistant', content: result.message });
    } else {
      result = await api(`/api/characters/${charId}/edit`, 'POST', {
        editRequest: modalMessages.length === 1 ? message : undefined,
        messages: modalMessages
      });
      modalMessages.push({ role: 'assistant', content: result.message });
    }

    document.getElementById('modal-loading')?.remove();

    messagesContainer.innerHTML += `<div class="chat-message assistant"><div class="message-content">${formatChatMessage(result.message)}</div></div>`;
    messagesContainer.scrollTop = messagesContainer.scrollHeight;

    if (result.complete) {
      loadCharacters();
      if (isLevelUp) {
        messagesContainer.innerHTML += `<div class="chat-message assistant"><div class="message-content"><strong>Level up complete!</strong></div></div>`;
        showNotification(`${result.character.character_name} is now level ${result.character.level}!`);
      } else {
        messagesContainer.innerHTML += `<div class="chat-message assistant"><div class="message-content"><strong>Changes saved!</strong></div></div>`;
      }
    }
  } catch (error) {
    document.getElementById('modal-loading')?.remove();
    messagesContainer.innerHTML += `<div class="chat-message assistant"><div class="message-content">Error: ${error.message}</div></div>`;
  }
}

async function levelUpCharacter(charId) {
  const char = characters.find(c => c.id === charId);
  if (!char) return;

  // Check if can level up
  const canLevel = canLevelUp(char.xp || 0, char.level);
  if (!canLevel) {
    alert(`${char.character_name} needs ${getRequiredXP(char.level)} XP to level up. Current: ${char.xp || 0} XP`);
    return;
  }

  // Open level up modal
  openLevelUpModal(charId);
}

// Level Up Modal Functions
let levelUpModalCharId = null;
let levelUpMessages = [];

function openLevelUpModal(charId) {
  levelUpModalCharId = charId;
  levelUpMessages = [];

  const char = characters.find(c => c.id === charId);
  if (!char) return;

  document.getElementById('modal-title').textContent = `Level Up ${char.character_name} to Level ${char.level + 1}`;
  document.getElementById('modal-chat-messages').innerHTML = `
    <div class="chat-message assistant">
      <div class="message-content">Starting level up process...</div>
    </div>
  `;
  document.getElementById('modal-input').value = '';
  document.getElementById('char-modal').classList.add('active');

  // Start the level up conversation
  startLevelUpConversation(charId);
}

async function startLevelUpConversation(charId) {
  levelUpMessages = [{ role: 'user', content: 'I want to level up my character. Please guide me through the process.' }];

  try {
    const result = await api(`/api/characters/${charId}/levelup`, 'POST', {
      messages: levelUpMessages
    });

    levelUpMessages.push({ role: 'assistant', content: result.message });

    const messagesContainer = document.getElementById('modal-chat-messages');
    messagesContainer.innerHTML = `<div class="chat-message assistant"><div class="message-content">${formatChatMessage(result.message)}</div></div>`;
    messagesContainer.scrollTop = messagesContainer.scrollHeight;

    if (result.complete) {
      messagesContainer.innerHTML += `<div class="chat-message assistant"><div class="message-content"><strong>Level up complete!</strong></div></div>`;
      loadCharacters();
      showNotification(`${result.character.character_name} is now level ${result.character.level}!`);
    }
  } catch (error) {
    const messagesContainer = document.getElementById('modal-chat-messages');
    messagesContainer.innerHTML = `<div class="chat-message assistant"><div class="message-content">Error: ${error.message}</div></div>`;
  }
}

// Inventory Modal Functions
let inventoryModalCharId = null;

function openInventoryModal(charId) {
  inventoryModalCharId = charId;
  const char = characters.find(c => c.id === charId);
  if (!char) return;

  document.getElementById('inventory-modal-title').textContent = `${char.character_name}'s Inventory`;
  document.getElementById('inventory-gold-input').value = char.gold || 0;

  renderInventoryModalList(char);

  document.getElementById('inventory-modal').classList.add('active');
}

function closeInventoryModal() {
  document.getElementById('inventory-modal').classList.remove('active');
  inventoryModalCharId = null;
}

function renderInventoryModalList(char) {
  let inventory = [];
  try {
    inventory = JSON.parse(char.inventory || '[]');
  } catch (e) {
    inventory = [];
  }

  const listEl = document.getElementById('inventory-modal-list');
  if (inventory.length === 0) {
    listEl.innerHTML = '<div class="inventory-empty">No items in inventory</div>';
  } else {
    listEl.innerHTML = inventory.map((item, idx) => `
      <div class="inventory-modal-item">
        <span class="item-name">${escapeHtml(item.name)}</span>
        <span class="item-qty">x${item.quantity || 1}</span>
        <button class="btn-tiny" onclick="removeItemFromInventory('${escapeHtml(item.name.replace(/'/g, "\\'"))}')">-</button>
      </div>
    `).join('');
  }
}

async function updateGold() {
  if (!inventoryModalCharId) return;

  const char = characters.find(c => c.id === inventoryModalCharId);
  if (!char) return;

  const newGold = parseInt(document.getElementById('inventory-gold-input').value) || 0;
  const goldDiff = newGold - (char.gold || 0);

  try {
    await api(`/api/characters/${inventoryModalCharId}/gold`, 'POST', { amount: goldDiff });
    loadCharacters();
    showNotification(`Gold updated for ${char.character_name}`);
  } catch (error) {
    alert('Failed to update gold: ' + error.message);
  }
}

async function addItemToInventory() {
  if (!inventoryModalCharId) return;

  const itemName = document.getElementById('new-item-name').value.trim();
  const quantity = parseInt(document.getElementById('new-item-qty').value) || 1;

  if (!itemName) {
    alert('Please enter an item name');
    return;
  }

  try {
    const result = await api(`/api/characters/${inventoryModalCharId}/inventory`, 'POST', {
      action: 'add',
      item: itemName,
      quantity: quantity
    });

    document.getElementById('new-item-name').value = '';
    document.getElementById('new-item-qty').value = '1';

    // Update local character data and refresh modal
    const charIdx = characters.findIndex(c => c.id === inventoryModalCharId);
    if (charIdx !== -1) {
      characters[charIdx] = result.character;
      renderInventoryModalList(result.character);
    }
    loadCharacters();
  } catch (error) {
    alert('Failed to add item: ' + error.message);
  }
}

async function removeItemFromInventory(itemName) {
  if (!inventoryModalCharId) return;

  try {
    const result = await api(`/api/characters/${inventoryModalCharId}/inventory`, 'POST', {
      action: 'remove',
      item: itemName,
      quantity: 1
    });

    // Update local character data and refresh modal
    const charIdx = characters.findIndex(c => c.id === inventoryModalCharId);
    if (charIdx !== -1) {
      characters[charIdx] = result.character;
      renderInventoryModalList(result.character);
    }
    loadCharacters();
  } catch (error) {
    alert('Failed to remove item: ' + error.message);
  }
}

// Spell Slots Modal Functions
let spellSlotsModalCharId = null;

function openSpellSlotsModal(charId) {
  spellSlotsModalCharId = charId;
  const char = characters.find(c => c.id === charId);
  if (!char) return;

  document.getElementById('spell-slots-modal-title').textContent = `${char.character_name}'s Spell Slots & AC`;
  document.getElementById('ac-input').value = char.ac || 10;

  renderSpellSlotsList(char);

  document.getElementById('spell-slots-modal').classList.add('active');
}

function closeSpellSlotsModal() {
  document.getElementById('spell-slots-modal').classList.remove('active');
  spellSlotsModalCharId = null;
}

function renderSpellSlotsList(char) {
  let spellSlots = {};
  try {
    spellSlots = JSON.parse(char.spell_slots || '{}');
  } catch (e) {
    spellSlots = {};
  }

  const listEl = document.getElementById('spell-slots-list');
  const levels = Object.keys(spellSlots).sort((a, b) => parseInt(a) - parseInt(b));

  if (levels.length === 0) {
    listEl.innerHTML = '<div class="spell-slots-empty">No spell slots configured. Add spell slot levels below.</div>';
  } else {
    listEl.innerHTML = levels.map(lvl => {
      const slot = spellSlots[lvl];
      const available = (slot.max || 0) - (slot.used || 0);
      const levelName = lvl === '1' ? '1st' : lvl === '2' ? '2nd' : lvl === '3' ? '3rd' : `${lvl}th`;
      return `
        <div class="spell-slot-row">
          <span class="slot-level">${levelName} Level</span>
          <span class="slot-count">${available} / ${slot.max || 0}</span>
          <button class="btn-tiny" onclick="useSpellSlot('${lvl}')" ${available <= 0 ? 'disabled' : ''}>Use</button>
          <button class="btn-tiny btn-restore" onclick="restoreSpellSlot('${lvl}')" ${slot.used <= 0 ? 'disabled' : ''}>+1</button>
          <button class="btn-tiny btn-remove" onclick="removeSpellSlotLevel('${lvl}')">X</button>
        </div>
      `;
    }).join('');
  }
}

async function updateAC() {
  if (!spellSlotsModalCharId) return;

  const ac = parseInt(document.getElementById('ac-input').value) || 10;

  try {
    await api(`/api/characters/${spellSlotsModalCharId}/ac`, 'POST', { ac });
    loadCharacters();
    showNotification('AC updated');
  } catch (error) {
    alert('Failed to update AC: ' + error.message);
  }
}

async function useSpellSlot(level) {
  if (!spellSlotsModalCharId) return;

  try {
    const result = await api(`/api/characters/${spellSlotsModalCharId}/spell-slots`, 'POST', {
      action: 'use',
      level: level
    });

    const charIdx = characters.findIndex(c => c.id === spellSlotsModalCharId);
    if (charIdx !== -1) {
      characters[charIdx] = result.character;
      renderSpellSlotsList(result.character);
    }
    loadCharacters();
  } catch (error) {
    alert('Failed to use spell slot: ' + error.message);
  }
}

async function restoreSpellSlot(level) {
  if (!spellSlotsModalCharId) return;

  try {
    const result = await api(`/api/characters/${spellSlotsModalCharId}/spell-slots`, 'POST', {
      action: 'restore',
      level: level
    });

    const charIdx = characters.findIndex(c => c.id === spellSlotsModalCharId);
    if (charIdx !== -1) {
      characters[charIdx] = result.character;
      renderSpellSlotsList(result.character);
    }
    loadCharacters();
  } catch (error) {
    alert('Failed to restore spell slot: ' + error.message);
  }
}

async function longRest() {
  if (!spellSlotsModalCharId) return;

  try {
    const result = await api(`/api/characters/${spellSlotsModalCharId}/spell-slots`, 'POST', {
      action: 'rest'
    });

    const charIdx = characters.findIndex(c => c.id === spellSlotsModalCharId);
    if (charIdx !== -1) {
      characters[charIdx] = result.character;
      renderSpellSlotsList(result.character);
    }
    loadCharacters();
    showNotification('All spell slots restored!');
  } catch (error) {
    alert('Failed to restore spell slots: ' + error.message);
  }
}

async function addSpellSlotLevel() {
  if (!spellSlotsModalCharId) return;

  const level = document.getElementById('new-slot-level').value;
  const maxSlots = parseInt(document.getElementById('new-slot-max').value) || 2;

  const char = characters.find(c => c.id === spellSlotsModalCharId);
  if (!char) return;

  let spellSlots = {};
  try {
    spellSlots = JSON.parse(char.spell_slots || '{}');
  } catch (e) {
    spellSlots = {};
  }

  spellSlots[level] = { max: maxSlots, used: 0 };

  try {
    const result = await api(`/api/characters/${spellSlotsModalCharId}/spell-slots`, 'POST', {
      action: 'set',
      slots: spellSlots
    });

    const charIdx = characters.findIndex(c => c.id === spellSlotsModalCharId);
    if (charIdx !== -1) {
      characters[charIdx] = result.character;
      renderSpellSlotsList(result.character);
    }
    loadCharacters();
  } catch (error) {
    alert('Failed to add spell slot level: ' + error.message);
  }
}

async function removeSpellSlotLevel(level) {
  if (!spellSlotsModalCharId) return;

  const char = characters.find(c => c.id === spellSlotsModalCharId);
  if (!char) return;

  let spellSlots = {};
  try {
    spellSlots = JSON.parse(char.spell_slots || '{}');
  } catch (e) {
    spellSlots = {};
  }

  delete spellSlots[level];

  try {
    const result = await api(`/api/characters/${spellSlotsModalCharId}/spell-slots`, 'POST', {
      action: 'set',
      slots: spellSlots
    });

    const charIdx = characters.findIndex(c => c.id === spellSlotsModalCharId);
    if (charIdx !== -1) {
      characters[charIdx] = result.character;
      renderSpellSlotsList(result.character);
    }
    loadCharacters();
  } catch (error) {
    alert('Failed to remove spell slot level: ' + error.message);
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
