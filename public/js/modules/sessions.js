// ============================================
// Sessions Module
// - Session CRUD, story rendering, actions
// - Virtual scrolling for story history
// - Slash commands for action textarea
// ============================================

import { getState, setState } from '../state.js';
import { api } from '../api.js';
import { escapeHtml, formatContent } from '../utils/formatters.js';
import { showNotification, scrollStoryToBottom, hideNarratorTyping, closeGameDrawer } from '../utils/dom.js';
import { loadCharacters, updateCharacterSelect, updatePartyList } from './characters.js';
import { saveAppState } from './auth.js';

// ============================================
// Virtual scrolling constants
// ============================================
const INITIAL_MESSAGE_COUNT = 50;
const LOAD_MORE_COUNT = 30;

// Track full history and how many are rendered
let _fullRenderedHistory = [];
let _renderedCount = 0;
let _scrollObserver = null;
let _sentinelEl = null;

// ============================================
// Scenario definitions
// ============================================

const SESSION_SCENARIOS = [
  { id: 'classic_fantasy', name: 'Classic Fantasy', description: 'Traditional D&D setting with dungeons, dragons, and medieval adventure', icon: '\uD83C\uDFF0' },
  { id: 'tavern_start', name: 'Tavern Meeting', description: 'The classic "you all meet in a tavern" opening - strangers brought together by fate', icon: '\uD83C\uDF7A' },
  { id: 'modern_urban', name: 'Modern Urban Fantasy', description: 'Magic hidden in the modern world - secret societies, urban mysteries', icon: '\uD83C\uDF03' },
  { id: 'zombie_apocalypse', name: 'Zombie Apocalypse', description: 'Survival horror in a world overrun by the undead', icon: '\uD83E\uDDDF' },
  { id: 'space_opera', name: 'Space Opera', description: 'Sci-fi adventure among the stars - alien worlds, space stations, galactic intrigue', icon: '\uD83D\uDE80' },
  { id: 'noir_detective', name: 'Noir Detective', description: 'Gritty 1940s detective story - rain-slicked streets, femme fatales, dark secrets', icon: '\uD83D\uDD0D' },
  { id: 'pirate_adventure', name: 'Pirate Adventure', description: 'High seas adventure - treasure hunting, naval battles, mysterious islands', icon: '\uD83C\uDFF4\u200D\u2620\uFE0F' },
  { id: 'post_apocalyptic', name: 'Post-Apocalyptic', description: 'Wasteland survival after civilization fell - scavengers, raiders, lost technology', icon: '\u2622\uFE0F' },
  { id: 'horror_mystery', name: 'Horror Mystery', description: 'Lovecraftian horror - eldritch secrets, cosmic dread, sanity-testing revelations', icon: '\uD83D\uDC41\uFE0F' },
  { id: 'custom', name: 'Custom Setting', description: 'Describe your own unique world and starting scenario', icon: '\u2728' }
];

// ============================================
// Session list
// ============================================

export async function loadSessions() {
  try {
    const sessions = await api('/api/sessions');
    const currentSession = getState('currentSession');
    const list = document.getElementById('session-list');
    if (!list) return;
    list.innerHTML = sessions.map(s => `
      <div class="session-item ${currentSession && currentSession.id === s.id ? 'active' : ''}">
        <span class="session-name" onclick="loadSession('${s.id}')">${escapeHtml(s.name)}</span>
        <button class="session-delete-btn" onclick="event.stopPropagation(); deleteSession('${s.id}', '${escapeHtml(s.name).replace(/'/g, "\\'")}')" title="Delete session">X</button>
      </div>
    `).join('');
  } catch (error) {
    console.error('Failed to load sessions:', error);
  }
}

export async function deleteSession(id, name) {
  if (!confirm(`Are you sure you want to delete the session "${name}"?\n\nThis will permanently delete all story history and progress!`)) return;

  try {
    await api(`/api/sessions/${id}`, 'DELETE');
    showNotification(`Session "${name}" deleted`);
    const currentSession = getState('currentSession');
    if (currentSession && currentSession.id === id) {
      setState({ currentSession: null });
      document.getElementById('story-container').innerHTML = '<p class="no-session">Select or create a session to begin your adventure!</p>';
    }
    loadSessions();
  } catch (error) {
    console.error('Failed to delete session:', error);
    alert('Failed to delete session: ' + error.message);
  }
}

// ============================================
// New session modal
// ============================================

export function openNewSessionModal() {
  renderScenarioOptions();
  renderCharacterSelection();
  document.getElementById('new-session-name').value = '';
  document.getElementById('custom-scenario-input').value = '';
  document.getElementById('custom-scenario-group').style.display = 'none';
  setState({ selectedScenario: 'classic_fantasy', selectedCharacterIds: [] });
  updateSelectedCharacterCount();
  setTimeout(() => selectScenario('classic_fantasy'), 10);
  document.getElementById('new-session-modal').classList.add('active');
}

function renderCharacterSelection() {
  const characters = getState('characters');
  const container = document.getElementById('character-selection-list');
  if (!container) return;

  if (characters.length === 0) {
    container.innerHTML = '<p class="no-characters-msg">No characters created yet. Create characters first!</p>';
    return;
  }

  container.innerHTML = characters.map(c => {
    let classDisplay;
    try {
      const classes = JSON.parse(c.classes || '{}');
      classDisplay = Object.keys(classes).length > 0
        ? Object.entries(classes).map(([cls, lvl]) => `${cls} ${lvl}`).join(' / ')
        : `${c.class} ${c.level}`;
    } catch (e) {
      classDisplay = `${c.class} ${c.level}`;
    }
    return `
      <label class="character-selection-item" data-id="${c.id}">
        <input type="checkbox"
               value="${c.id}"
               onchange="toggleCharacterSelection('${c.id}', this.checked)">
        <div class="char-info">
          <div class="char-name">${escapeHtml(c.character_name)}</div>
          <div class="char-details">${escapeHtml(c.race)} ${escapeHtml(classDisplay)}</div>
        </div>
      </label>
    `;
  }).join('');
}

export function toggleCharacterSelection(charId, isSelected) {
  let ids = [...getState('selectedCharacterIds')];
  if (isSelected) {
    if (!ids.includes(charId)) ids.push(charId);
  } else {
    ids = ids.filter(id => id !== charId);
  }
  setState({ selectedCharacterIds: ids });

  const item = document.querySelector(`.character-selection-item[data-id="${charId}"]`);
  if (item) item.classList.toggle('selected', isSelected);

  updateSelectedCharacterCount();
}

function updateSelectedCharacterCount() {
  const el = document.getElementById('selected-character-count');
  if (el) el.textContent = getState('selectedCharacterIds').length;
}

export function closeNewSessionModal() {
  document.getElementById('new-session-modal').classList.remove('active');
}

function renderScenarioOptions() {
  const container = document.getElementById('scenario-options');
  if (!container) return;
  container.innerHTML = SESSION_SCENARIOS.map(s => `
    <div class="scenario-option" data-id="${s.id}" onclick="selectScenario('${s.id}')">
      <div class="scenario-icon">${s.icon}</div>
      <div class="scenario-info">
        <div class="scenario-name">${s.name}</div>
        <div class="scenario-desc">${s.description}</div>
      </div>
    </div>
  `).join('');
}

export function selectScenario(scenarioId) {
  setState({ selectedScenario: scenarioId });
  document.querySelectorAll('.scenario-option').forEach(el => {
    el.classList.toggle('selected', el.dataset.id === scenarioId);
  });
  const customGroup = document.getElementById('custom-scenario-group');
  if (customGroup) customGroup.style.display = scenarioId === 'custom' ? 'block' : 'none';
}

export async function createSession() {
  const name = document.getElementById('new-session-name').value.trim();
  if (!name) { alert('Please enter a session name'); return; }

  const selectedCharacterIds = getState('selectedCharacterIds');
  if (selectedCharacterIds.length === 0) {
    alert('Please select at least one character for this session');
    return;
  }

  const selectedScenario = getState('selectedScenario');
  const scenario = SESSION_SCENARIOS.find(s => s.id === selectedScenario);
  let scenarioPrompt = '';

  if (selectedScenario === 'custom') {
    scenarioPrompt = document.getElementById('custom-scenario-input').value.trim();
    if (!scenarioPrompt) { alert('Please describe your custom scenario'); return; }
  } else {
    scenarioPrompt = `${scenario.name}: ${scenario.description}`;
  }

  closeNewSessionModal();

  try {
    const session = await api('/api/sessions', 'POST', {
      name,
      scenario: selectedScenario,
      scenarioPrompt,
      characterIds: selectedCharacterIds
    });
    loadSession(session.id);
  } catch (error) {
    console.error('Failed to create session:', error);
    alert('Failed to create session: ' + error.message);
  }
}

// ============================================
// Load session & render story
// ============================================

export async function loadSession(id) {
  try {
    const data = await api(`/api/sessions/${id}`);
    setState({
      currentSession: data.session,
      sessionCharacters: data.sessionCharacters || []
    });

    updateCharacterSelect();
    updatePartyList();

    const currentSession = data.session;
    document.getElementById('turn-counter').textContent = `Turn: ${currentSession.current_turn}`;
    document.getElementById('token-counter').textContent = `Tokens: ${currentSession.total_tokens}`;

    const history = JSON.parse(currentSession.full_history || '[]');

    // Use virtual scrolling: render only the last N messages initially
    _fullRenderedHistory = history;
    const historyContainer = document.getElementById('story-history');
    if (historyContainer) {
      // Render only the tail portion initially
      const startIndex = Math.max(0, history.length - INITIAL_MESSAGE_COUNT);
      _renderedCount = history.length - startIndex;
      const visibleHistory = history.slice(startIndex);
      historyContainer.innerHTML = renderStoryHistory(visibleHistory, startIndex);

      // Set up IntersectionObserver for lazy loading older messages
      setupScrollObserver(historyContainer);
    }

    scrollStoryToBottom();
    updatePendingActions(data.pendingActions);
    loadSessions();
    saveAppState();
    closeGameDrawer();
  } catch (error) {
    console.error('Failed to load session:', error);
  }
}

/**
 * Set up IntersectionObserver to load more messages when scrolling to top.
 */
function setupScrollObserver(historyContainer) {
  // Clean up previous observer
  if (_scrollObserver) {
    _scrollObserver.disconnect();
    _scrollObserver = null;
  }
  if (_sentinelEl && _sentinelEl.parentNode) {
    _sentinelEl.remove();
  }

  // If all messages are already rendered, no need for observer
  if (_renderedCount >= _fullRenderedHistory.length) return;

  // Create sentinel element at the top
  _sentinelEl = document.createElement('div');
  _sentinelEl.className = 'scroll-sentinel';
  _sentinelEl.setAttribute('aria-hidden', 'true');
  historyContainer.insertBefore(_sentinelEl, historyContainer.firstChild);

  const storyContainer = document.getElementById('story-container');
  _scrollObserver = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting) {
      loadMoreMessages();
    }
  }, { root: storyContainer, threshold: 0.1 });

  _scrollObserver.observe(_sentinelEl);
}

/**
 * Load more older messages when the user scrolls to the top.
 */
function loadMoreMessages() {
  if (_renderedCount >= _fullRenderedHistory.length) {
    // All messages loaded, disconnect observer
    if (_scrollObserver) {
      _scrollObserver.disconnect();
      _scrollObserver = null;
    }
    if (_sentinelEl && _sentinelEl.parentNode) {
      _sentinelEl.remove();
    }
    return;
  }

  const historyContainer = document.getElementById('story-history');
  const storyContainer = document.getElementById('story-container');
  if (!historyContainer || !storyContainer) return;

  // Remember scroll position to maintain it after prepending
  const scrollHeightBefore = storyContainer.scrollHeight;

  // Calculate the slice of history to prepend
  const currentStart = _fullRenderedHistory.length - _renderedCount;
  const newStart = Math.max(0, currentStart - LOAD_MORE_COUNT);
  const newSlice = _fullRenderedHistory.slice(newStart, currentStart);
  _renderedCount += (currentStart - newStart);

  // Render the new chunk
  const newHtml = renderStoryHistory(newSlice, newStart);

  // Remove old sentinel, prepend new content, then re-add sentinel
  if (_sentinelEl && _sentinelEl.parentNode) {
    _sentinelEl.remove();
  }

  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = newHtml;
  const fragment = document.createDocumentFragment();
  while (tempDiv.firstChild) {
    fragment.appendChild(tempDiv.firstChild);
  }
  historyContainer.insertBefore(fragment, historyContainer.firstChild);

  // Restore scroll position
  const scrollHeightAfter = storyContainer.scrollHeight;
  storyContainer.scrollTop += (scrollHeightAfter - scrollHeightBefore);

  // Re-add sentinel at top if there are still more messages
  if (_renderedCount < _fullRenderedHistory.length) {
    _sentinelEl = document.createElement('div');
    _sentinelEl.className = 'scroll-sentinel';
    _sentinelEl.setAttribute('aria-hidden', 'true');
    historyContainer.insertBefore(_sentinelEl, historyContainer.firstChild);
    if (_scrollObserver) {
      _scrollObserver.observe(_sentinelEl);
    }
  } else {
    if (_scrollObserver) {
      _scrollObserver.disconnect();
      _scrollObserver = null;
    }
  }
}

// Helper to refresh session characters without reloading entire session
export async function refreshSessionCharacters() {
  const currentSession = getState('currentSession');
  if (!currentSession) return;
  try {
    const data = await api(`/api/sessions/${currentSession.id}`);
    setState({ sessionCharacters: data.sessionCharacters || [] });
    updatePartyList();
  } catch (error) {
    console.error('Failed to refresh session characters:', error);
  }
}

// ============================================
// Story rendering
// ============================================

export function renderStoryHistory(history, indexOffset = 0) {
  let html = '';
  let turnActions = [];
  let turnActionIndices = [];

  for (let i = 0; i < history.length; i++) {
    const entry = history[i];
    const globalIndex = indexOffset + i;

    if (entry.hidden || entry.type === 'context') continue;

    if (entry.type === 'action') {
      turnActions.push(entry);
      turnActionIndices.push(globalIndex);
      continue;
    }

    if (entry.role === 'assistant' || entry.type === 'narration') {
      if (turnActions.length > 0) {
        html += renderPlayerActionsGroup(turnActions, turnActionIndices);
        turnActions = [];
        turnActionIndices = [];
      }

      const ttsId = 'tts-' + Math.random().toString(36).substr(2, 9);
      const ttsContent = btoa(encodeURIComponent(entry.content));
      html += `
        <div class="story-entry assistant narration" data-index="${globalIndex}">
          <div class="narration-header">
            <div class="role">Dungeon Master</div>
            <div class="narration-controls">
              <button class="tts-play-btn" id="${ttsId}" data-tts-content="${ttsContent}" onclick="handleTTSClick(this)" title="Play narration">\uD83D\uDD0A</button>
              <button class="delete-msg-btn" onclick="deleteStoryMessage(${globalIndex})" title="Delete this message">\uD83D\uDDD1\uFE0F</button>
            </div>
          </div>
          <div class="content">${formatContent(entry.content)}</div>
        </div>
      `;
      continue;
    }

    if (entry.role === 'user' && !entry.type) {
      if (entry.content.includes('PARTY STATUS:') || entry.content.includes('PLAYER ACTIONS THIS TURN:')) {
        const actionsMatch = entry.content.match(/PLAYER ACTIONS THIS TURN:\s*([\s\S]*?)(?:Please narrate|$)/i);
        if (actionsMatch) {
          const actionLines = actionsMatch[1].trim().split('\n').filter(l => l.trim());
          for (const line of actionLines) {
            const colonIdx = line.indexOf(':');
            if (colonIdx > 0) {
              const charName = line.substring(0, colonIdx).trim();
              const action = line.substring(colonIdx + 1).trim();
              turnActions.push({ character_name: charName, content: action, type: 'action' });
              turnActionIndices.push(globalIndex);
            }
          }
        }
      } else {
        html += `
          <div class="story-entry user" data-index="${globalIndex}">
            <div class="role">Players</div>
            <div class="content">${formatContent(entry.content)}</div>
            <button class="delete-msg-btn" onclick="deleteStoryMessage(${globalIndex})" title="Delete this message">\uD83D\uDDD1\uFE0F</button>
          </div>
        `;
      }
    }
  }

  if (turnActions.length > 0) {
    html += renderPlayerActionsGroup(turnActions, turnActionIndices);
  }

  return html;
}

function renderPlayerActionsGroup(actions, indices = []) {
  if (actions.length === 0) return '';

  let html = '<div class="player-actions-group">';
  html += '<div class="actions-header">Player Actions</div>';

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const index = indices[i] !== undefined ? indices[i] : -1;
    const charName = action.character_name || 'Unknown';
    const playerName = action.player_name || '';
    const initial = charName.charAt(0).toUpperCase();

    const colorIndex = charName.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) % 6;
    const colorClass = `char-color-${colorIndex}`;

    html += `
      <div class="player-action-bubble ${colorClass}" data-index="${index}">
        <div class="action-avatar">${initial}</div>
        <div class="action-content">
          <div class="action-character-name">${escapeHtml(charName)}${playerName ? ` <span class="action-player-name">(${escapeHtml(playerName)})</span>` : ''}</div>
          <div class="action-text">${formatContent(action.content)}</div>
        </div>
        ${index >= 0 ? `<button class="delete-action-btn" onclick="deleteStoryMessage(${index})" title="Delete this action">\uD83D\uDDD1\uFE0F</button>` : ''}
      </div>
    `;
  }

  html += '</div>';
  return html;
}

// ============================================
// Streaming support
// ============================================

/**
 * Append a text chunk from AI streaming to the story container.
 * Creates a temporary streaming element if one doesn't exist.
 */
export function appendStreamChunk(text) {
  const historyContainer = document.getElementById('story-history');
  if (!historyContainer) return;

  let streamEl = document.getElementById('streaming-response');
  if (!streamEl) {
    // Create a temporary streaming element
    streamEl = document.createElement('div');
    streamEl.id = 'streaming-response';
    streamEl.className = 'story-entry assistant narration streaming';
    streamEl.innerHTML = `
      <div class="narration-header">
        <div class="role">Dungeon Master</div>
        <div class="streaming-indicator">streaming...</div>
      </div>
      <div class="content streaming-content"></div>
    `;
    historyContainer.appendChild(streamEl);
  }

  const contentEl = streamEl.querySelector('.streaming-content');
  if (contentEl) {
    // Append text with typewriter effect by adding character by character
    contentEl.textContent += text;
  }

  // Auto-scroll to bottom
  const container = document.getElementById('story-container');
  if (container) {
    container.scrollTop = container.scrollHeight;
  }
}

/**
 * Remove the temporary streaming element.
 * Called when turn_processed arrives to replace with final formatted content.
 */
export function finalizeStreamedContent() {
  const streamEl = document.getElementById('streaming-response');
  if (streamEl) {
    streamEl.remove();
  }
}

// ============================================
// Pending actions
// ============================================

export function updatePendingActions(pendingActions) {
  const sessionCharacters = getState('sessionCharacters');
  const container = document.getElementById('pending-actions');
  if (!container) return;
  const waitingCount = sessionCharacters.length - pendingActions.length;

  document.getElementById('waiting-counter').textContent = `Waiting for: ${waitingCount} players`;

  container.innerHTML = sessionCharacters.map(c => {
    const action = pendingActions.find(a => a.character_id === c.id);
    return `
      <div class="action-item ${action ? 'submitted' : ''}">
        <div class="player">${escapeHtml(c.character_name)}</div>
        <div class="action-status">
          ${action ? `<span class="action-preview" title="${escapeHtml(action.action)}">Action submitted</span>
            <button class="btn-cancel-action" onclick="cancelAction('${c.id}')" title="Cancel action">\u2715</button>`
            : 'Waiting...'}
        </div>
      </div>
    `;
  }).join('');
}

export async function cancelAction(characterId) {
  const currentSession = getState('currentSession');
  if (!currentSession) return;

  try {
    const result = await api(`/api/sessions/${currentSession.id}/action/${characterId}`, 'DELETE');
    if (result.success) {
      updatePendingActions(result.pendingActions);
      showNotification('Action cancelled');
    }
  } catch (error) {
    console.error('Failed to cancel action:', error);
    alert('Failed to cancel action: ' + error.message);
  }
}

// ============================================
// Dice Roller for Actions
// ============================================

let _currentDiceRoll = null; // { value, modifier, modValue, stat, total, timestamp }

const STAT_LABELS = {
  strength: 'STR', dexterity: 'DEX', constitution: 'CON',
  intelligence: 'INT', wisdom: 'WIS', charisma: 'CHA'
};

/**
 * Calculate D&D ability modifier from a stat score.
 * @param {number} score - Ability score (e.g. 16)
 * @returns {number} Modifier (e.g. +3)
 */
function calcModifier(score) {
  return Math.floor((score - 10) / 2);
}

/**
 * Get the selected character's stat value for the chosen stat.
 * Returns { modifier, statName, score } or null.
 */
function getSelectedStatInfo() {
  const statSelect = document.getElementById('dice-stat-select');
  const charSelect = document.getElementById('action-character');
  if (!statSelect || !charSelect) return null;

  const stat = statSelect.value;
  if (stat === 'none') return null;

  const characterId = charSelect.value;
  if (!characterId) return null;

  // Look up the character from session characters or all characters
  const sessionChars = getState('sessionCharacters');
  const allChars = getState('characters');
  const char = sessionChars.find(c => c.id === characterId) || allChars.find(c => c.id === characterId);
  if (!char) return null;

  const score = char[stat];
  if (score === undefined || score === null) return null;

  return {
    modifier: calcModifier(score),
    statName: STAT_LABELS[stat] || stat.toUpperCase(),
    stat,
    score
  };
}

/**
 * Roll a d20 for action submission.
 * Must be called before submitting an action.
 */
export function rollActionDice() {
  const roller = document.getElementById('dice-roller');
  const btn = document.getElementById('dice-roll-btn');
  const valueEl = document.getElementById('dice-value');
  const modEl = document.getElementById('dice-mod');
  const totalEl = document.getElementById('dice-total');
  const diceText = btn?.querySelector('.d20-icon text');
  const submitBtn = document.getElementById('submit-action-btn');

  if (!roller || !btn || !valueEl) return;

  // Already rolled this turn — don't allow re-roll
  if (_currentDiceRoll) {
    showNotification('You already rolled! Submit your action first.');
    return;
  }

  // Trigger rolling animation
  btn.classList.add('rolling');
  roller.classList.remove('rolled', 'nat20', 'nat1', 'must-roll');

  // Quick visual number cycling during animation
  const cycleInterval = setInterval(() => {
    const fakeNum = Math.floor(Math.random() * 20) + 1;
    valueEl.textContent = fakeNum;
    if (diceText) diceText.textContent = fakeNum;
  }, 60);

  // Resolve after animation
  setTimeout(() => {
    clearInterval(cycleInterval);
    btn.classList.remove('rolling');

    const rawRoll = Math.floor(Math.random() * 20) + 1;
    const statInfo = getSelectedStatInfo();

    const mod = statInfo ? statInfo.modifier : 0;
    const total = rawRoll + mod;

    _currentDiceRoll = {
      value: rawRoll,
      modifier: mod,
      modValue: mod,
      stat: statInfo ? statInfo.statName : null,
      score: statInfo ? statInfo.score : null,
      total,
      timestamp: Date.now()
    };

    // Update display
    valueEl.textContent = rawRoll;
    valueEl.classList.add('pop');
    if (diceText) diceText.textContent = rawRoll;

    if (modEl) {
      if (statInfo) {
        const sign = mod >= 0 ? '+' : '';
        modEl.textContent = `${sign}${mod} ${statInfo.statName}`;
      } else {
        modEl.textContent = '';
      }
    }
    if (totalEl) {
      if (statInfo) {
        totalEl.textContent = `= ${total}`;
      } else {
        totalEl.textContent = '';
      }
    }

    roller.classList.add('rolled');

    // Special states (based on raw d20, not total)
    if (rawRoll === 20) {
      roller.classList.add('nat20');
      const msg = statInfo ? `Natural 20! (${total} with ${statInfo.statName})` : 'Natural 20! Critical success!';
      showNotification(msg);
    } else if (rawRoll === 1) {
      roller.classList.add('nat1');
      showNotification('Natural 1... Critical failure!');
    } else if (statInfo) {
      showNotification(`Rolled ${rawRoll} ${mod >= 0 ? '+' : ''}${mod} (${statInfo.statName}) = ${total}`);
    }

    if (submitBtn) submitBtn.classList.remove('needs-roll');

    // Lock dice after rolling — one roll per turn
    btn.disabled = true;
    btn.classList.add('dice-locked');
    btn.title = 'Already rolled — submit your action';
    const statSelect = document.getElementById('dice-stat-select');
    if (statSelect) statSelect.disabled = true;

    setTimeout(() => valueEl.classList.remove('pop'), 400);
  }, 600);
}

/**
 * Reset the dice roller state (after action submission).
 */
function resetDiceRoll() {
  _currentDiceRoll = null;
  const roller = document.getElementById('dice-roller');
  const valueEl = document.getElementById('dice-value');
  const modEl = document.getElementById('dice-mod');
  const totalEl = document.getElementById('dice-total');
  const diceText = document.querySelector('#dice-roll-btn .d20-icon text');

  if (roller) roller.classList.remove('rolled', 'nat20', 'nat1');
  if (valueEl) valueEl.textContent = '--';
  if (modEl) modEl.textContent = '';
  if (totalEl) totalEl.textContent = '';
  if (diceText) diceText.textContent = '?';

  // Re-enable dice button for next roll
  const btn = document.getElementById('dice-roll-btn');
  if (btn) {
    btn.disabled = false;
    btn.classList.remove('dice-locked');
    btn.title = 'Roll d20';
  }
  const statSelect = document.getElementById('dice-stat-select');
  if (statSelect) statSelect.disabled = false;
}

/**
 * Get the current dice roll result, or null if not rolled.
 */
export function getCurrentDiceRoll() {
  return _currentDiceRoll;
}

// ============================================
// Slash Commands
// ============================================

/**
 * Parse a dice expression like "2d6+3" and roll it.
 * @param {string} expression - Dice expression (e.g., "2d6+3", "d20", "4d8-2")
 * @returns {Object|null} Roll result or null if invalid
 */
function rollDice(expression) {
  const match = expression.match(/^(\d+)?d(\d+)([+-]\d+)?$/i);
  if (!match) return null;
  const count = parseInt(match[1] || '1');
  const sides = parseInt(match[2]);
  const modifier = parseInt(match[3] || '0');

  if (count < 1 || count > 100 || sides < 1 || sides > 1000) return null;

  const rolls = [];
  for (let i = 0; i < count; i++) {
    rolls.push(Math.floor(Math.random() * sides) + 1);
  }
  const total = rolls.reduce((a, b) => a + b, 0) + modifier;
  return { rolls, modifier, total, expression };
}

/**
 * Check if the action text is a slash command and handle it.
 * @param {string} text - The action text
 * @param {string} characterId - The selected character ID
 * @returns {boolean} True if it was handled as a slash command
 */
function handleSlashCommand(text, characterId) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return false;

  const parts = trimmed.split(/\s+/);
  const command = parts[0].toLowerCase();
  const args = parts.slice(1).join(' ');

  switch (command) {
    case '/roll': {
      if (!args) {
        showNotification('Usage: /roll 2d6+3');
        return true;
      }
      const result = rollDice(args.trim());
      if (!result) {
        showNotification('Invalid dice expression. Use format like: 2d6+3, d20, 4d8-2');
        return true;
      }
      const modStr = result.modifier !== 0
        ? ` ${result.modifier > 0 ? '+' : ''}${result.modifier}`
        : '';
      const rollDetail = result.rolls.length > 1
        ? ` (${result.rolls.join(' + ')}${modStr})`
        : modStr ? ` (${result.rolls[0]}${modStr})` : '';
      showNotification(`🎲 ${result.expression}: ${result.total}${rollDetail}`);
      return true;
    }

    case '/rest': {
      // Submit rest action directly — no dice roll needed for resting
      if (!characterId) {
        showNotification('Select a character first');
        return true;
      }
      const currentSession = getState('currentSession');
      if (!currentSession) { alert('Please select a session first'); return true; }
      const restAction = 'I take a long rest, settling down to recover my strength and tend to any wounds.';
      api(`/api/sessions/${currentSession.id}/action`, 'POST', {
        character_id: characterId,
        action: restAction
      }).then(result => {
        if (result.processed) loadSession(currentSession.id);
        showNotification('Rest action submitted!');
      }).catch(err => {
        alert('Failed to submit rest: ' + err.message);
      });
      const actionTextarea = document.getElementById('action-text');
      if (actionTextarea) actionTextarea.value = '';
      return true;
    }

    case '/inventory':
    case '/inv': {
      if (characterId) {
        // Dynamically import to avoid circular dependency issues
        window.openInventoryModal(characterId);
      } else {
        showNotification('Select a character first to view inventory');
      }
      return true;
    }

    default:
      showNotification(`Unknown command: ${command}`);
      return true;
  }
}

// ============================================
// Actions & turn processing
// ============================================

export async function submitAction() {
  const currentSession = getState('currentSession');
  if (!currentSession) { alert('Please select a session first'); return; }

  if (getState('isTurnProcessing')) {
    alert('Please wait - the Narrator is still processing the current turn');
    return;
  }

  const characterId = document.getElementById('action-character').value;
  const actionTextarea = document.getElementById('action-text');
  const action = actionTextarea.value;

  if (!characterId) { alert('Please select your character'); return; }
  if (!action.trim()) { alert('Please enter an action'); return; }

  // Check for slash commands before submitting
  if (handleSlashCommand(action, characterId)) {
    actionTextarea.value = '';
    return;
  }

  // Enforce dice roll before submission
  if (!_currentDiceRoll) {
    showNotification('Roll the d20 before submitting your action!');
    const roller = document.getElementById('dice-roller');
    const submitBtn = document.getElementById('submit-action-btn');
    if (roller) roller.classList.add('must-roll');
    if (submitBtn) submitBtn.classList.add('needs-roll');
    return;
  }

  // Build action text with dice roll + stat modifier included
  const roll = _currentDiceRoll;
  let rollTag;
  if (roll.stat) {
    const sign = roll.modifier >= 0 ? '+' : '';
    rollTag = `[DICE ROLL: d20 = ${roll.value} ${sign}${roll.modifier} ${roll.stat} (score ${roll.score}) = ${roll.total}]`;
  } else {
    rollTag = `[DICE ROLL: d20 = ${roll.value}]`;
  }
  const actionWithRoll = `${action}\n${rollTag}`;

  actionTextarea.value = '';
  resetDiceRoll();

  const submitBtn = document.getElementById('submit-action-btn');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting...';
  }
  const diceBtn = document.getElementById('dice-roll-btn');
  if (diceBtn) diceBtn.disabled = true;

  try {
    const result = await api(`/api/sessions/${currentSession.id}/action`, 'POST', {
      character_id: characterId,
      action: actionWithRoll
    });

    if (result.processed) {
      loadSession(currentSession.id);
    }

    const notifText = roll.stat
      ? `Action submitted! (d20: ${roll.value} ${roll.modifier >= 0 ? '+' : ''}${roll.modifier} ${roll.stat} = ${roll.total})`
      : `Action submitted! (rolled ${roll.value})`;
    showNotification(notifText);
  } catch (error) {
    console.error('Failed to submit action:', error);
    actionTextarea.value = action;

    if (error.message && error.message.includes('processing')) {
      setState({ isTurnProcessing: true });
      showNotification('Please wait - turn is being processed');
    } else {
      alert('Failed to submit action: ' + error.message);
    }
  } finally {
    updateActionFormState();
  }
}

export function updateActionFormState() {
  const isTurnProcessing = getState('isTurnProcessing');
  const submitBtn = document.getElementById('submit-action-btn');
  const actionTextarea = document.getElementById('action-text');
  const diceBtn = document.getElementById('dice-roll-btn');
  const statSelect = document.getElementById('dice-stat-select');

  if (submitBtn) {
    if (isTurnProcessing) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Narrator is typing...';
    } else {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit Action';
    }
  }

  if (actionTextarea) {
    actionTextarea.disabled = isTurnProcessing;
    actionTextarea.placeholder = isTurnProcessing
      ? 'Please wait for the Narrator to finish...'
      : 'What do you do?';
  }

  // Re-enable dice if turn processing ended and no roll is pending
  if (diceBtn) {
    if (isTurnProcessing) {
      diceBtn.disabled = true;
    } else if (!_currentDiceRoll) {
      diceBtn.disabled = false;
      diceBtn.classList.remove('dice-locked');
      diceBtn.title = 'Roll d20';
    }
  }
  if (statSelect) {
    statSelect.disabled = isTurnProcessing;
  }
}

export async function forceProcessTurn() {
  const currentSession = getState('currentSession');
  if (!currentSession) { alert('Please select a session first'); return; }
  if (!confirm('Force process the turn with current actions?')) return;
  try {
    await api(`/api/sessions/${currentSession.id}/process`, 'POST');
    loadSession(currentSession.id);
  } catch (error) {
    console.error('Failed to process turn:', error);
    alert('Failed to process turn: ' + error.message);
  }
}

export async function rerollLastResponse() {
  const currentSession = getState('currentSession');
  if (!currentSession) { alert('Please select a session first'); return; }
  if (!confirm('Regenerate the last AI response?')) return;
  try {
    await api(`/api/sessions/${currentSession.id}/reroll`, 'POST');
  } catch (error) {
    console.error('Failed to reroll:', error);
    alert('Failed to reroll: ' + error.message);
  }
}

export async function deleteStoryMessage(index) {
  const currentSession = getState('currentSession');
  if (!currentSession) { alert('No session selected'); return; }
  if (!confirm('Delete this message? This cannot be undone.')) return;

  try {
    await api(`/api/sessions/${currentSession.id}/delete-message`, 'POST', { index });
    await loadSession(currentSession.id);
    showNotification('Message deleted');
  } catch (error) {
    console.error('Failed to delete message:', error);
    alert('Failed to delete message: ' + error.message);
  }
}

// ============================================
// Recalculate functions
// ============================================

export async function recalculateXP() {
  const currentSession = getState('currentSession');
  if (!currentSession) { alert('Please select a session first'); return; }
  if (!confirm('Recalculate XP from session history? This will scan all DM responses for [XP: ...] tags.')) return;

  try {
    const result = await api(`/api/sessions/${currentSession.id}/recalculate-xp`, 'POST');
    if (result.success) {
      const characters = getState('characters');
      const sessionCharacters = getState('sessionCharacters');
      const xpEntries = Object.entries(result.xpAwarded);
      let xpSummary;
      if (xpEntries.length > 0) {
        const details = xpEntries.map(([charId, xp]) => {
          const char = sessionCharacters.find(c => c.id === charId) || characters.find(c => c.id === charId);
          return char ? `${char.character_name}: ${xp} XP` : `Unknown: ${xp} XP`;
        }).join('\n');
        xpSummary = `XP recalculated!\n\n${details}`;
      } else {
        xpSummary = 'No [XP: ...] tags found in session history.';
      }
      alert(xpSummary);
      await loadCharacters();
      await refreshSessionCharacters();
    }
  } catch (error) {
    console.error('Failed to recalculate XP:', error);
    alert('Failed to recalculate XP: ' + error.message);
  }
}

export async function recalculateLoot() {
  const currentSession = getState('currentSession');
  if (!currentSession) { alert('Please select a session first'); return; }
  if (!confirm('Recalculate gold and inventory from session history? This will scan all DM responses for [MONEY: ...] and [ITEM: ...] tags.')) return;

  try {
    const result = await api(`/api/sessions/${currentSession.id}/recalculate-loot`, 'POST');
    if (result.success) {
      const goldCount = Object.values(result.goldAwarded).filter(g => g !== 0).length;
      const itemCount = Object.values(result.inventoryChanges).filter(arr => arr.length > 0).length;
      const summary = goldCount > 0 || itemCount > 0
        ? `Loot recalculated! Found gold for ${goldCount} characters and items for ${itemCount} characters.`
        : 'No [MONEY: ...] or [ITEM: ...] tags found in session history.';
      alert(summary);
      await loadCharacters();
      await refreshSessionCharacters();
    }
  } catch (error) {
    console.error('Failed to recalculate loot:', error);
    alert('Failed to recalculate loot: ' + error.message);
  }
}

export async function recalculateInventory() {
  const currentSession = getState('currentSession');
  if (!currentSession) { alert('Please select a session first'); return; }
  if (!confirm('Recalculate inventory from session history? This will scan all DM responses for [ITEM: ...] tags and rebuild inventory from scratch.\n\nNote: This will REPLACE current inventory with what is found in tags.')) return;

  try {
    const result = await api(`/api/sessions/${currentSession.id}/recalculate-inventory`, 'POST');
    if (result.success) {
      const itemCount = Object.values(result.inventoryChanges).filter(arr => arr.length > 0).length;
      const summary = itemCount > 0
        ? `Inventory recalculated! Found items for ${itemCount} character(s).`
        : 'No [ITEM: ...] tags found in session history.';
      alert(summary);
      await loadCharacters();
      await refreshSessionCharacters();
    }
  } catch (error) {
    console.error('Failed to recalculate inventory:', error);
    alert('Failed to recalculate inventory: ' + error.message);
  }
}

export async function recalculateACSpells() {
  const currentSession = getState('currentSession');
  if (!currentSession) { alert('Please select a session first'); return; }
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
      await loadCharacters();
      await refreshSessionCharacters();
    }
  } catch (error) {
    console.error('Failed to recalculate AC/spells:', error);
    alert('Failed to recalculate AC/spells: ' + error.message);
  }
}
