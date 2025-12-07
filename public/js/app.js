// Global state
let password = '';
let currentSession = null;
let characters = [];
let socket = null;

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

  socket.on('action_submitted', ({ sessionId, pendingActions, character_id }) => {
    if (currentSession && currentSession.id === sessionId) {
      updatePendingActions(pendingActions);
    }
  });

  socket.on('turn_processed', ({ sessionId, response, turn, tokensUsed, compacted }) => {
    if (currentSession && currentSession.id === sessionId) {
      loadSession(sessionId);
      if (compacted) {
        showNotification('History was auto-compacted to save tokens!');
      }
    }
  });
}

// API helper
async function api(endpoint, method = 'GET', body = null) {
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Game-Password': password
    }
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(endpoint, options);

  if (response.status === 401) {
    showLogin();
    throw new Error('Unauthorized');
  }

  return response.json();
}

// Authentication
async function login() {
  const input = document.getElementById('password-input');
  password = input.value;

  try {
    await api('/api/auth', 'POST', { password });
    document.getElementById('login-screen').classList.remove('active');
    document.getElementById('app-screen').classList.add('active');
    initSocket();
    loadInitialData();
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
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

    btn.classList.add('active');
    document.getElementById(`${btn.dataset.tab}-tab`).classList.add('active');
  });
});

// Load initial data
async function loadInitialData() {
  await Promise.all([
    loadSettings(),
    loadCharacters(),
    loadSessions()
  ]);
}

// Settings
async function loadSettings() {
  try {
    const settings = await api('/api/settings');
    document.getElementById('api-endpoint').value = settings.api_endpoint || '';
    document.getElementById('api-key').value = settings.api_key || '';
    document.getElementById('api-model').value = settings.api_model || '';
    document.getElementById('max-tokens').value = settings.max_tokens_before_compact || 8000;
    document.getElementById('system-prompt').value = settings.system_prompt || '';
  } catch (error) {
    console.error('Failed to load settings:', error);
  }
}

async function saveSettings() {
  const settings = {
    api_endpoint: document.getElementById('api-endpoint').value,
    api_key: document.getElementById('api-key').value,
    api_model: document.getElementById('api-model').value,
    max_tokens_before_compact: document.getElementById('max-tokens').value,
    system_prompt: document.getElementById('system-prompt').value,
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

function renderCharactersList() {
  const grid = document.getElementById('characters-grid');
  grid.innerHTML = characters.map(c => `
    <div class="character-card">
      <button class="delete-btn" onclick="deleteCharacter('${c.id}')">Delete</button>
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
    </div>
  `).join('');
}

function updateCharacterSelect() {
  const select = document.getElementById('action-character');
  select.innerHTML = '<option value="">Select your character</option>' +
    characters.map(c => `<option value="${c.id}">${c.character_name} (${c.player_name})</option>`).join('');
}

function updatePartyList() {
  const list = document.getElementById('party-list');
  list.innerHTML = characters.map(c => `
    <div class="party-item">
      <div class="name">${c.character_name}</div>
      <div class="info">${c.race} ${c.class}</div>
      <div class="hp">HP: ${c.hp}/${c.max_hp}</div>
    </div>
  `).join('');
}

// Roll stats
function rollD6() {
  return Math.floor(Math.random() * 6) + 1;
}

function roll4d6DropLowest() {
  const rolls = [rollD6(), rollD6(), rollD6(), rollD6()];
  rolls.sort((a, b) => b - a);
  return rolls[0] + rolls[1] + rolls[2];
}

function rollStat(stat) {
  const value = roll4d6DropLowest();
  document.getElementById(`char-${stat}`).value = value;
}

function rollAllStats() {
  ['str', 'dex', 'con', 'int', 'wis', 'cha'].forEach(stat => rollStat(stat));
}

async function createCharacter() {
  const character = {
    player_name: document.getElementById('char-player-name').value,
    character_name: document.getElementById('char-name').value,
    race: document.getElementById('char-race').value,
    class: document.getElementById('char-class').value,
    strength: parseInt(document.getElementById('char-str').value),
    dexterity: parseInt(document.getElementById('char-dex').value),
    constitution: parseInt(document.getElementById('char-con').value),
    intelligence: parseInt(document.getElementById('char-int').value),
    wisdom: parseInt(document.getElementById('char-wis').value),
    charisma: parseInt(document.getElementById('char-cha').value),
    background: document.getElementById('char-background').value,
    equipment: document.getElementById('char-equipment').value
  };

  if (!character.player_name || !character.character_name) {
    alert('Please fill in player name and character name');
    return;
  }

  try {
    await api('/api/characters', 'POST', character);
    // Reset form
    document.getElementById('char-player-name').value = '';
    document.getElementById('char-name').value = '';
    document.getElementById('char-background').value = '';
    document.getElementById('char-equipment').value = '';
    ['str', 'dex', 'con', 'int', 'wis', 'cha'].forEach(stat => {
      document.getElementById(`char-${stat}`).value = 10;
    });
  } catch (error) {
    console.error('Failed to create character:', error);
    alert('Failed to create character');
  }
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
      <div class="session-item ${currentSession && currentSession.id === s.id ? 'active' : ''}"
           onclick="loadSession('${s.id}')">
        ${s.name}
      </div>
    `).join('');
  } catch (error) {
    console.error('Failed to load sessions:', error);
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

    // Render story
    const summary = document.getElementById('story-summary');
    summary.textContent = currentSession.story_summary || '';

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

function showNotification(message) {
  alert(message); // Simple notification for now
}

// Enter key for login
document.getElementById('password-input').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') login();
});
