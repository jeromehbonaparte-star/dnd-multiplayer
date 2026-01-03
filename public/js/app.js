// Global state
let password = '';
let adminPassword = '';
let isAdminAuthenticated = false;
let currentSession = null;
let characters = [];  // All characters (for character selection)
let sessionCharacters = [];  // Characters for the current session
let socket = null;
let isTurnProcessing = false;  // Track if AI is currently processing a turn

// Global click handler for section toggles (using capture phase to ensure it fires)
document.addEventListener('click', function(e) {
  // Check if clicked element or any parent is a section-header
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
        if (typeof toggleSection === 'function') {
          toggleSection(charId, section);
        }
      }
    }
  }
}, true); // true = capture phase

// ============================================
// TTS (Text-to-Speech) Manager
// ============================================

class TTSManager {
  constructor() {
    this.voice = localStorage.getItem('tts-voice') || 'onyx';
    this.speed = parseFloat(localStorage.getItem('tts-speed')) || 1.0;
    this.currentAudio = null;
    this.isPlaying = false;
    this.isPaused = false;
    this.currentText = null;
    this.currentChunkIndex = 0;
    this.totalChunks = 0;
    this.onStateChange = null; // Callback for UI updates
  }

  setVoice(voice) {
    this.voice = voice;
    localStorage.setItem('tts-voice', voice);
  }

  setSpeed(speed) {
    this.speed = parseFloat(speed);
    localStorage.setItem('tts-speed', this.speed.toString());
  }

  async speak(text, buttonEl = null) {
    console.log('TTSManager.speak() called with text length:', text?.length);

    // Stop any current playback
    this.stop();

    this.currentText = text;
    this.currentChunkIndex = 0;
    this.activeButton = buttonEl;

    try {
      // Get chunk info first
      console.log('Fetching TTS info...');
      const info = await api('/api/tts/info', 'POST', { text });
      console.log('TTS info received:', info);
      this.totalChunks = info.totalChunks;

      console.log(`TTS: Starting playback of ${this.totalChunks} chunks`);

      // Start playing chunks
      await this.playChunk(0);

    } catch (error) {
      console.error('TTS Error:', error);
      this.resetState();
      showNotification('TTS Error: ' + (error.message || 'Failed to generate speech'));
    }
  }

  async playChunk(index) {
    console.log(`TTSManager.playChunk(${index}) called, totalChunks: ${this.totalChunks}`);

    if (index >= this.totalChunks || !this.currentText) {
      console.log('Playback complete or no text');
      this.resetState();
      return;
    }

    this.currentChunkIndex = index;
    this.isPlaying = true;
    this.isPaused = false;
    this.updateButtonState();

    try {
      // Fetch audio for this chunk
      console.log(`Fetching audio for chunk ${index}...`);
      const response = await fetch('/api/tts/audio', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Game-Password': password
        },
        body: JSON.stringify({
          text: this.currentText,
          chunkIndex: index,
          voice: this.voice,
          speed: this.speed
        })
      });

      console.log('Audio fetch response:', response.status, response.ok);

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to generate audio');
      }

      const audioBlob = await response.blob();
      console.log('Audio blob received, size:', audioBlob.size, 'type:', audioBlob.type);

      if (audioBlob.size === 0) {
        throw new Error('Received empty audio blob');
      }

      const audioUrl = URL.createObjectURL(audioBlob);
      console.log('Audio URL created:', audioUrl);

      this.currentAudio = new Audio(audioUrl);
      this.currentAudio.volume = 1.0;

      // Play and chain to next chunk
      this.currentAudio.onended = () => {
        console.log('Audio chunk ended');
        URL.revokeObjectURL(audioUrl);
        this.playChunk(index + 1);
      };

      this.currentAudio.onerror = (e) => {
        console.error('Audio playback error:', e, this.currentAudio.error);
        URL.revokeObjectURL(audioUrl);
        this.resetState();
        showNotification('Audio playback failed - check console for details');
      };

      this.currentAudio.oncanplaythrough = () => {
        console.log('Audio can play through, duration:', this.currentAudio.duration);
      };

      console.log('Starting audio playback...');
      try {
        await this.currentAudio.play();
        console.log('Audio playback started successfully');
      } catch (playError) {
        console.error('Play error:', playError);
        // Autoplay might be blocked - show notification
        showNotification('Click anywhere on the page first, then try TTS again (autoplay policy)');
        this.resetState();
        return;
      }

      // Pre-fetch next chunk for smoother playback
      if (index + 1 < this.totalChunks) {
        this.prefetchChunk(index + 1);
      }

    } catch (error) {
      console.error('TTS playback error:', error);
      this.resetState();
      showNotification('TTS Error: ' + error.message);
    }
  }

  async prefetchChunk(index) {
    // Pre-fetch in background for smoother playback
    try {
      fetch('/api/tts/audio', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Game-Password': password
        },
        body: JSON.stringify({
          text: this.currentText,
          chunkIndex: index,
          voice: this.voice,
          speed: this.speed
        })
      });
    } catch (e) {
      // Ignore prefetch errors
    }
  }

  pause() {
    if (this.currentAudio && this.isPlaying && !this.isPaused) {
      this.currentAudio.pause();
      this.isPaused = true;
      this.updateButtonState();
    }
  }

  resume() {
    if (this.currentAudio && this.isPaused) {
      this.currentAudio.play();
      this.isPaused = false;
      this.updateButtonState();
    }
  }

  stop() {
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio.src = '';
      this.currentAudio = null;
    }
    this.resetState();
  }

  updateButtonState() {
    if (!this.activeButton) return;

    if (this.isPaused) {
      this.activeButton.classList.add('tts-paused');
      this.activeButton.classList.remove('tts-playing');
      this.activeButton.innerHTML = '▶️';
      this.activeButton.title = 'Resume';
    } else if (this.isPlaying) {
      this.activeButton.classList.add('tts-playing');
      this.activeButton.classList.remove('tts-paused');
      this.activeButton.innerHTML = '⏸️';
      const progress = this.totalChunks > 1 ? ` (${this.currentChunkIndex + 1}/${this.totalChunks})` : '';
      this.activeButton.title = 'Pause' + progress;
    }
  }

  resetState() {
    this.isPlaying = false;
    this.isPaused = false;
    this.currentText = null;
    this.currentChunkIndex = 0;
    this.totalChunks = 0;

    // Reset button state
    if (this.activeButton) {
      this.activeButton.classList.remove('tts-playing', 'tts-paused');
      this.activeButton.innerHTML = '🔊';
      this.activeButton.title = 'Play narration';
    }
    this.activeButton = null;

    if (this.onStateChange) {
      this.onStateChange(false);
    }
  }

  togglePlayback(text, buttonEl) {
    // If same text is playing, toggle pause/resume
    if (this.currentText === text && (this.isPlaying || this.isPaused)) {
      if (this.isPaused) {
        this.resume();
      } else {
        this.pause();
      }
    } else {
      // Different text or not playing - start new playback
      this.speak(text, buttonEl);
    }
  }
}

// Global TTS Manager instance
const ttsManager = new TTSManager();

// TTS click handler for play buttons
function handleTTSClick(buttonEl) {
  console.log('TTS button clicked', buttonEl);

  // Decode the base64-encoded content from data attribute
  const encodedContent = buttonEl.dataset.ttsContent;
  console.log('Encoded content:', encodedContent ? encodedContent.substring(0, 50) + '...' : 'NONE');

  if (!encodedContent) {
    showNotification('TTS Error: No content found');
    return;
  }

  try {
    const text = decodeURIComponent(atob(encodedContent));
    console.log('Decoded text:', text.substring(0, 100) + '...');
    ttsManager.togglePlayback(text, buttonEl);
  } catch (e) {
    console.error('TTS decode error:', e);
    showNotification('TTS Error: Failed to decode content');
  }
}

// State persistence for mobile tab switching
function saveAppState() {
  const state = {
    password: password,
    currentSessionId: currentSession ? currentSession.id : null,
    currentTab: document.querySelector('.tab-btn.active')?.dataset.tab || 'game',
    charCreationInProgress: charCreationInProgress,
    charCreationMessages: charCreationMessages,
    // Auto-reply selections
    autoReplySessionId: document.getElementById('autoreply-session-select')?.value || '',
    autoReplyCharacterId: document.getElementById('autoreply-character-select')?.value || ''
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

      // Restore auto-reply selections
      if (state.autoReplySessionId) {
        const autoReplySelect = document.getElementById('autoreply-session-select');
        if (autoReplySelect) {
          autoReplySelect.value = state.autoReplySessionId;
          await loadAutoReplyCharacters();
          if (state.autoReplyCharacterId) {
            const charSelect = document.getElementById('autoreply-character-select');
            if (charSelect) {
              charSelect.value = state.autoReplyCharacterId;
            }
          }
        }
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

  socket.on('action_cancelled', ({ sessionId, pendingActions, character_id }) => {
    if (currentSession && currentSession.id === sessionId) {
      updatePendingActions(pendingActions);
    }
  });

  socket.on('turn_processing', ({ sessionId }) => {
    if (currentSession && currentSession.id === sessionId) {
      isTurnProcessing = true;
      showNarratorTyping();
      updateActionFormState();
    }
  });

  socket.on('reroll_started', ({ sessionId }) => {
    if (currentSession && currentSession.id === sessionId) {
      isTurnProcessing = true;
      showNarratorTyping();
      updateActionFormState();
      showNotification('Regenerating response...');
    }
  });

  socket.on('turn_processed', ({ sessionId, response, turn, tokensUsed, compacted }) => {
    if (currentSession && currentSession.id === sessionId) {
      isTurnProcessing = false;
      hideNarratorTyping();
      loadSession(sessionId);
      updateActionFormState();
      if (compacted) {
        showNotification('History was auto-compacted to save tokens!');
      }
    }
  });

  socket.on('character_updated', (character) => {
    // Update the character in sessionCharacters if it exists there
    const sessionIdx = sessionCharacters.findIndex(c => c.id === character.id);
    if (sessionIdx !== -1) {
      sessionCharacters[sessionIdx] = character;
    }
    loadCharacters();
  });

  socket.on('character_leveled_up', ({ character, summary }) => {
    // Update the character in sessionCharacters if it exists there
    const sessionIdx = sessionCharacters.findIndex(c => c.id === character.id);
    if (sessionIdx !== -1) {
      sessionCharacters[sessionIdx] = character;
    }
    loadCharacters();
    showNotification(`${character.character_name} leveled up to ${character.level}! ${summary}`);
  });

  // Combat tracker events
  socket.on('combat_started', ({ sessionId, combat }) => {
    if (currentSession && currentSession.id === sessionId) {
      currentCombat = combat;
      renderCombatTracker();
      showNotification('Combat started!');
    }
  });

  socket.on('combat_updated', ({ sessionId, combat }) => {
    if (currentSession && currentSession.id === sessionId) {
      currentCombat = combat;
      renderCombatTracker();
    }
  });

  socket.on('combat_ended', ({ sessionId }) => {
    if (currentSession && currentSession.id === sessionId) {
      currentCombat = null;
      renderCombatTracker();
      showNotification('Combat ended');
    }
  });

  // Session compacted event (from force compact or auto-compact)
  socket.on('session_compacted', ({ sessionId, compactedCount }) => {
    showNotification(`Session history compacted! ${compactedCount} entries summarized.`);

    // If the Summary Management panel is open for this session, refresh it
    const summarySelect = document.getElementById('summary-session-select');
    if (summarySelect && summarySelect.value == sessionId) {
      loadSessionSummary();
    }

    // Reload session if we're viewing the compacted session
    if (currentSession && currentSession.id === sessionId) {
      loadSession(sessionId);
    }
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

  // Check content type before parsing
  const contentType = response.headers.get('content-type');
  if (!contentType || !contentType.includes('application/json')) {
    // Server returned non-JSON (likely HTML error page)
    const text = await response.text();
    console.error('Non-JSON response:', response.status, text.substring(0, 200));
    throw new Error(`Server error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || `Request failed: ${response.status}`);
  }

  return data;
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
let storyScrollPosition = 0; // Track scroll position for game tab

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const targetTab = btn.dataset.tab;
    const currentTab = document.querySelector('.tab-btn.active')?.dataset.tab;

    // Require admin password for settings tab
    if (targetTab === 'settings' && !isAdminAuthenticated) {
      const authenticated = await promptAdminLogin();
      if (!authenticated) return;
    }

    // Save scroll position when leaving game tab
    if (currentTab === 'game') {
      const storyContainer = document.getElementById('story-container');
      if (storyContainer) {
        storyScrollPosition = storyContainer.scrollTop;
      }
    }

    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

    btn.classList.add('active');
    document.getElementById(`${targetTab}-tab`).classList.add('active');

    // Restore scroll position when returning to game tab
    if (targetTab === 'game') {
      requestAnimationFrame(() => {
        const storyContainer = document.getElementById('story-container');
        if (storyContainer) {
          storyContainer.scrollTop = storyScrollPosition;
        }
      });
    }

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

    // Restore TTS settings from localStorage
    const ttsVoiceEl = document.getElementById('tts-voice');
    const ttsSpeedEl = document.getElementById('tts-speed');
    const ttsSpeedValueEl = document.getElementById('tts-speed-value');

    if (ttsVoiceEl) {
      ttsVoiceEl.value = ttsManager.voice;
    }
    if (ttsSpeedEl) {
      ttsSpeedEl.value = ttsManager.speed;
    }
    if (ttsSpeedValueEl) {
      ttsSpeedValueEl.textContent = ttsManager.speed + 'x';
    }

    // Load sessions for GM Mode dropdown
    await loadGMSessionDropdown();

    // Load sessions for Summary Management dropdown
    await loadSummarySessionDropdown();
  } catch (error) {
    console.error('Failed to load settings:', error);
  }
}

// ============================================
// GM Mode Functions
// ============================================

async function loadGMSessionDropdown() {
  try {
    const sessions = await api('/api/sessions');
    const sessionOptions = '<option value="">-- Select a session --</option>' +
      sessions.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');

    // GM Mode dropdown
    const gmSelect = document.getElementById('gm-session-select');
    if (gmSelect) {
      gmSelect.innerHTML = sessionOptions;
      document.getElementById('gm-session-info').style.display = 'none';
    }

    // Auto-Reply dropdown
    const autoReplySelect = document.getElementById('autoreply-session-select');
    if (autoReplySelect) {
      autoReplySelect.innerHTML = sessionOptions;
    }

    // Summary dropdown
    const summarySelect = document.getElementById('summary-session-select');
    if (summarySelect) {
      summarySelect.innerHTML = sessionOptions;
    }
  } catch (error) {
    console.error('Failed to load sessions for settings dropdowns:', error);
  }
}

async function loadGMSessionInfo() {
  const sessionId = document.getElementById('gm-session-select').value;
  const infoDiv = document.getElementById('gm-session-info');

  if (!sessionId) {
    infoDiv.style.display = 'none';
    return;
  }

  try {
    const data = await api(`/api/sessions/${sessionId}`);
    document.getElementById('gm-session-name').textContent = data.session.name;
    document.getElementById('gm-session-turn').textContent = data.session.current_turn;
    infoDiv.style.display = 'block';
  } catch (error) {
    console.error('Failed to load session info:', error);
    infoDiv.style.display = 'none';
  }
}

// ============================================
// Story Summary Management Functions
// ============================================

async function loadSummarySessionDropdown() {
  try {
    const sessions = await api('/api/sessions');
    const select = document.getElementById('summary-session-select');
    if (!select) return;

    select.innerHTML = '<option value="">-- Select a session --</option>' +
      sessions.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
  } catch (error) {
    console.error('Failed to load sessions for summary:', error);
  }
}

async function loadSessionSummary() {
  const sessionId = document.getElementById('summary-session-select').value;
  const infoDiv = document.getElementById('summary-info');
  const textarea = document.getElementById('summary-textarea');
  const statusEl = document.getElementById('summary-status');

  if (!sessionId) {
    infoDiv.style.display = 'none';
    textarea.value = '';
    return;
  }

  try {
    const data = await api(`/api/sessions/${sessionId}/summary`);

    document.getElementById('summary-total-msgs').textContent = data.totalMessages;
    document.getElementById('summary-compacted-msgs').textContent = data.compactedCount;
    document.getElementById('summary-pending-msgs').textContent = data.uncompactedMessages;

    textarea.value = data.summary || '';
    infoDiv.style.display = 'block';
    statusEl.textContent = '';

  } catch (error) {
    console.error('Failed to load summary:', error);
    statusEl.textContent = 'Error loading summary: ' + error.message;
    statusEl.style.color = 'var(--danger)';
  }
}

async function saveSummary() {
  const sessionId = document.getElementById('summary-session-select').value;
  const summary = document.getElementById('summary-textarea').value;
  const statusEl = document.getElementById('summary-status');

  if (!sessionId) {
    statusEl.textContent = 'Please select a session first.';
    statusEl.style.color = 'var(--danger)';
    return;
  }

  try {
    await api(`/api/sessions/${sessionId}/summary`, 'POST', { summary });
    statusEl.textContent = 'Summary saved successfully!';
    statusEl.style.color = 'var(--success)';
  } catch (error) {
    statusEl.textContent = 'Error saving summary: ' + error.message;
    statusEl.style.color = 'var(--danger)';
  }
}

async function forceCompact() {
  const sessionId = document.getElementById('summary-session-select').value;
  const statusEl = document.getElementById('summary-status');
  const btn = document.getElementById('force-compact-btn');

  if (!sessionId) {
    statusEl.textContent = 'Please select a session first.';
    statusEl.style.color = 'var(--danger)';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Compacting...';
  statusEl.textContent = 'Generating summary from recent messages...';
  statusEl.style.color = 'var(--text-muted)';

  try {
    const result = await api(`/api/sessions/${sessionId}/force-compact`, 'POST');

    statusEl.textContent = result.message;
    statusEl.style.color = 'var(--success)';

    // Reload the summary
    await loadSessionSummary();

  } catch (error) {
    statusEl.textContent = 'Error: ' + error.message;
    statusEl.style.color = 'var(--danger)';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Force Compact Now';
  }
}

async function sendGMMessage() {
  const sessionId = document.getElementById('gm-session-select').value;
  const message = document.getElementById('gm-message-input').value.trim();
  const statusEl = document.getElementById('gm-status');
  const sendBtn = document.getElementById('gm-send-btn');

  if (!sessionId) {
    statusEl.textContent = 'Please select a session first.';
    statusEl.style.color = 'var(--danger)';
    return;
  }

  if (!message) {
    statusEl.textContent = 'Please enter a message.';
    statusEl.style.color = 'var(--danger)';
    return;
  }

  // Disable button while sending
  sendBtn.disabled = true;
  sendBtn.textContent = 'Sending...';
  statusEl.textContent = '';

  try {
    const result = await api(`/api/sessions/${sessionId}/gm-message`, 'POST', { message });

    // Success
    statusEl.textContent = result.message || 'GM message sent! It will influence the next AI response.';
    statusEl.style.color = 'var(--success)';
    document.getElementById('gm-message-input').value = '';

    // Update session info to show it's been modified
    loadGMSessionInfo();

  } catch (error) {
    statusEl.textContent = 'Error: ' + (error.message || 'Failed to send message');
    statusEl.style.color = 'var(--danger)';
  } finally {
    sendBtn.disabled = false;
    sendBtn.textContent = 'Send GM Nudge';
  }
}

// ============================================
// AI Auto-Reply Functions
// ============================================

async function loadAutoReplyCharacters() {
  const sessionId = document.getElementById('autoreply-session-select').value;
  const charSelect = document.getElementById('autoreply-character-select');
  const statusEl = document.getElementById('autoreply-status');

  // Save state when session changes
  saveAppState();

  if (!sessionId) {
    charSelect.innerHTML = '<option value="">-- Select a session first --</option>';
    charSelect.disabled = true;
    return;
  }

  try {
    const data = await api(`/api/sessions/${sessionId}`);
    const characters = data.sessionCharacters || [];

    if (characters.length === 0) {
      charSelect.innerHTML = '<option value="">No characters in this session</option>';
      charSelect.disabled = true;
      return;
    }

    charSelect.innerHTML = '<option value="">-- Select a character --</option>' +
      characters.map(c => `<option value="${c.id}">${escapeHtml(c.character_name)} (${escapeHtml(c.race)} ${escapeHtml(c.class)})</option>`).join('');
    charSelect.disabled = false;
    statusEl.textContent = '';
  } catch (error) {
    console.error('Failed to load characters:', error);
    charSelect.innerHTML = '<option value="">Error loading characters</option>';
    charSelect.disabled = true;
    statusEl.textContent = 'Error: ' + error.message;
    statusEl.style.color = 'var(--danger)';
  }
}

function onAutoReplyCharacterChange() {
  saveAppState();
}

async function generateAutoReply() {
  const sessionId = document.getElementById('autoreply-session-select').value;
  const characterId = document.getElementById('autoreply-character-select').value;
  const context = document.getElementById('autoreply-context').value.trim();
  const statusEl = document.getElementById('autoreply-status');
  const btn = document.getElementById('autoreply-btn');

  if (!sessionId) {
    statusEl.textContent = 'Please select a session first.';
    statusEl.style.color = 'var(--danger)';
    return;
  }

  if (!characterId) {
    statusEl.textContent = 'Please select a character.';
    statusEl.style.color = 'var(--danger)';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Generating...';
  statusEl.textContent = 'AI is thinking...';
  statusEl.style.color = 'var(--text-muted)';

  try {
    const result = await api(`/api/sessions/${sessionId}/auto-reply`, 'POST', {
      character_id: characterId,
      context: context || null
    });

    if (result.success) {
      statusEl.innerHTML = `<strong>Action generated:</strong> "${escapeHtml(result.action)}"<br><em>${escapeHtml(result.message)}</em>`;
      statusEl.style.color = 'var(--success)';
      document.getElementById('autoreply-context').value = '';
    } else {
      statusEl.textContent = 'Error: ' + (result.error || 'Unknown error');
      statusEl.style.color = 'var(--danger)';
    }
  } catch (error) {
    statusEl.textContent = 'Error: ' + (error.message || 'Failed to generate action');
    statusEl.style.color = 'var(--danger)';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generate & Send Action';
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
      <div class="api-config-card ${config.is_active ? 'active' : ''}" data-id="${config.id}"
           data-name="${escapeHtml(config.name)}"
           data-endpoint="${escapeHtml(config.endpoint)}"
           data-model="${escapeHtml(config.model)}">
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
          <button class="btn-edit" onclick="editApiConfig('${config.id}')">Edit</button>
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

// Edit API config
let editingConfigId = null;

function editApiConfig(id) {
  const card = document.querySelector(`.api-config-card[data-id="${id}"]`);
  if (!card) return;

  editingConfigId = id;

  // Get current values from data attributes
  const name = card.dataset.name;
  const endpoint = card.dataset.endpoint;
  const model = card.dataset.model;

  // Show edit modal
  const modal = document.getElementById('api-edit-modal');
  document.getElementById('edit-config-name').value = name;
  document.getElementById('edit-config-endpoint').value = endpoint;
  document.getElementById('edit-config-model').value = model;
  document.getElementById('edit-config-key').value = '';
  document.getElementById('edit-config-key').placeholder = 'Leave blank to keep current key';
  document.getElementById('edit-config-status').textContent = '';

  modal.classList.add('active');
}

function closeApiEditModal() {
  const modal = document.getElementById('api-edit-modal');
  modal.classList.remove('active');
  editingConfigId = null;
}

async function saveApiConfigEdit() {
  if (!editingConfigId) return;

  const name = document.getElementById('edit-config-name').value.trim();
  const endpoint = document.getElementById('edit-config-endpoint').value.trim();
  const model = document.getElementById('edit-config-model').value.trim();
  const api_key = document.getElementById('edit-config-key').value.trim();
  const statusEl = document.getElementById('edit-config-status');

  if (!name || !endpoint || !model) {
    statusEl.textContent = 'Name, endpoint, and model are required';
    statusEl.className = 'error';
    return;
  }

  const updateData = { name, endpoint, model };
  if (api_key) {
    updateData.api_key = api_key;
  }

  try {
    await api(`/api/api-configs/${editingConfigId}`, 'PUT', updateData);
    statusEl.textContent = 'Configuration updated!';
    statusEl.className = 'success';

    // Reload configs and close modal after a brief delay
    await loadApiConfigs();
    setTimeout(() => {
      closeApiEditModal();
    }, 1000);
  } catch (error) {
    statusEl.textContent = error.message || 'Failed to update configuration';
    statusEl.className = 'error';
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
    messagesContainer.innerHTML = `<div class="chat-message assistant"><div class="message-content">Error: ${escapeHtml(error.message)}. Make sure your API is configured in Settings.</div></div>`;
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
      messagesContainer.innerHTML += `<div class="chat-message assistant"><div class="message-content"><strong>Character created successfully!</strong> Check the Characters list.</div></div>`;
      messagesContainer.innerHTML += `<div class="chat-message assistant"><div class="message-content">Want to create another character? Just describe them!</div></div>`;
      scrollChatToBottom();
      loadCharacters();
      // Reset for next character creation but keep the conversation going
      charCreationMessages = [];
      input.disabled = false;
      document.getElementById('char-chat-send').disabled = false;
      input.focus();
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

// Scroll story container to bottom with delay for mobile compatibility
function scrollStoryToBottom() {
  const container = document.getElementById('story-container');
  if (!container) return;

  // Helper to perform scroll and save position
  const doScroll = () => {
    // Method 1: Set scrollTop
    container.scrollTop = container.scrollHeight;

    // Method 2: Try scrollIntoView on the last child element
    const historyContainer = document.getElementById('story-history');
    if (historyContainer && historyContainer.lastElementChild) {
      historyContainer.lastElementChild.scrollIntoView({ block: 'end', behavior: 'instant' });
    }

    // Save position for tab switching
    if (typeof storyScrollPosition !== 'undefined') {
      storyScrollPosition = container.scrollTop;
    }
  };

  // Multiple scroll attempts for mobile compatibility
  // Mobile browsers often need more time for DOM to fully render
  doScroll(); // Immediate attempt
  requestAnimationFrame(() => {
    doScroll(); // After next paint
    setTimeout(doScroll, 100);
    setTimeout(doScroll, 300);
    setTimeout(doScroll, 500);
    setTimeout(doScroll, 1000); // Final attempt after 1 second
  });
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
    const hasSpellSlots = Object.keys(spellSlots).length > 0;

    // Parse multiclass
    let classDisplay = `${c.class} (Level ${c.level})`;
    try {
      const classes = JSON.parse(c.classes || '{}');
      if (Object.keys(classes).length > 0) {
        classDisplay = Object.entries(classes)
          .map(([cls, lvl]) => `${cls} ${lvl}`)
          .join(' / ');
      }
    } catch (e) {}

    // Parse feats
    const feats = c.feats || '';

    // Format AC display with effects breakdown
    const acDisplay = formatAcDisplay(c);

    // Helper function to create collapsible section
    // isHtml=true means content is already sanitized HTML, false means escape it
    const createSection = (sectionId, label, content, colorClass, isHtml = false) => {
      if (!content) return '';
      const isExpanded = getSectionState(c.id, sectionId);
      // Escape plain text content and convert newlines to <br>
      const safeContent = isHtml ? content : escapeHtml(content).replace(/\n/g, '<br>');
      return `
        <div class="section-collapsible ${colorClass} ${isExpanded ? 'expanded' : ''}" data-char="${c.id}" data-section="${sectionId}">
          <div class="section-header" onclick="event.stopPropagation(); toggleSection('${c.id}', '${sectionId}')">
            <span class="section-toggle-icon">${isExpanded ? '▼' : '▶'}</span>
            <strong>${escapeHtml(label)}</strong>
          </div>
          <div class="section-content">${safeContent}</div>
        </div>
      `;
    };

    return `
    <div class="character-card" data-id="${c.id}">
      <button class="delete-btn" onclick="event.stopPropagation(); deleteCharacter('${c.id}')">X</button>

      <!-- Character Header (always visible) -->
      <div class="card-header">
        <div class="card-header-main">
          <h3>${escapeHtml(c.character_name)}</h3>
        </div>
        <div class="player">Played by ${escapeHtml(c.player_name)}</div>
        <div class="race-class">${escapeHtml(c.race)} ${escapeHtml(classDisplay)}</div>
        <div class="card-summary">
          <div class="stats stats-mini">
            <div class="stat">${c.strength}<span>STR</span></div>
            <div class="stat">${c.dexterity}<span>DEX</span></div>
            <div class="stat">${c.constitution}<span>CON</span></div>
            <div class="stat">${c.intelligence}<span>INT</span></div>
            <div class="stat">${c.wisdom}<span>WIS</span></div>
            <div class="stat">${c.charisma}<span>CHA</span></div>
          </div>
          <div class="combat-stats">
            <div class="hp">HP: ${c.hp}/${c.max_hp}</div>
            <div class="ac-display">AC: ${acDisplay}</div>
          </div>
          <div class="resource-row">
            <span class="gold-display">Money: ${gold}</span>
            <span class="xp-mini">XP: ${xp}/${requiredXP}</span>
          </div>
          <div class="xp-bar"><div class="xp-fill" style="width: ${xpPercent}%"></div></div>
        </div>
      </div>

      <!-- Collapsible Sections -->
      <div class="card-sections">
        <div class="section-controls">
          <button class="btn-tiny" onclick="event.stopPropagation(); expandAllSections('${c.id}')">Expand All</button>
          <button class="btn-tiny" onclick="event.stopPropagation(); collapseAllSections('${c.id}')">Collapse All</button>
        </div>
        ${createSection('appearance', 'Appearance', c.appearance, 'section-appearance')}
        ${createSection('backstory', 'Backstory', c.backstory, 'section-backstory')}
        ${hasSpellSlots ? createSection('spellSlots', 'Spell Slots', spellSlotsDisplay, 'section-spellslots', true) : ''}
        ${createSection('skills', 'Skills', c.skills, 'section-skills')}
        ${createSection('spells', 'Spells', c.spells, 'section-spells')}
        ${createSection('passives', 'Passives', c.passives, 'section-passives')}
        ${createSection('classFeatures', 'Class Features', c.class_features, 'section-classfeatures')}
        ${createSection('feats', 'Feats', feats, 'section-feats')}
        ${createSection('inventory', `Inventory (${itemCount} items)`,
          inventory.length > 0
            ? inventory.map(item => `<div class="inventory-item">${escapeHtml(item.name)}${item.quantity > 1 ? ' x' + item.quantity : ''}</div>`).join('')
            : '<div class="inventory-empty">No items</div>',
          'section-inventory', true)}
      </div>

      <!-- Action Buttons -->
      <div class="card-actions">
        <div class="btn-row">
          <button class="btn-edit" onclick="event.stopPropagation(); openEditModal('${c.id}')">Edit</button>
          <button class="btn-quick-edit" onclick="event.stopPropagation(); openQuickEditModal('${c.id}')">Quick Edit</button>
          <button class="btn-inventory" onclick="event.stopPropagation(); openInventoryModal('${c.id}')">Inventory</button>
        </div>
        <div class="btn-row">
          <button class="btn-levelup" onclick="event.stopPropagation(); levelUpCharacter('${c.id}')" ${canLevel ? '' : 'disabled'}>${canLevel ? 'Level Up!' : 'Need XP'}</button>
          <button class="btn-spells" onclick="event.stopPropagation(); openSpellSlotsModal('${c.id}')">Spell Slots</button>
        </div>
        <div class="btn-row">
          <button class="btn-reset-xp" onclick="event.stopPropagation(); resetXP('${c.id}', '${escapeHtml(c.character_name).replace(/'/g, "\\'")}')">Reset XP</button>
          <button class="btn-reset-level" onclick="event.stopPropagation(); resetLevel('${c.id}', '${escapeHtml(c.character_name).replace(/'/g, "\\'")}')">Reset Level</button>
        </div>
      </div>
    </div>
  `}).join('');

  // Attach event listeners for collapsible sections
  attachSectionToggleListeners();
}

// Section expand/collapse state management
// Format: { charId: { sectionName: boolean } }
let sectionExpandedStates = {};

// Available sections
const CHARACTER_SECTIONS = ['appearance', 'backstory', 'spellSlots', 'skills', 'spells', 'passives', 'classFeatures', 'feats', 'inventory'];

function loadSectionStates() {
  try {
    const saved = localStorage.getItem('dnd-section-states');
    if (saved) {
      sectionExpandedStates = JSON.parse(saved);
    }
  } catch (e) {}
}

function saveSectionStates() {
  try {
    localStorage.setItem('dnd-section-states', JSON.stringify(sectionExpandedStates));
  } catch (e) {}
}

function getSectionState(charId, section) {
  if (!sectionExpandedStates[charId]) {
    sectionExpandedStates[charId] = {};
  }
  // Default to collapsed (false)
  return sectionExpandedStates[charId][section] || false;
}

function toggleSection(charId, section) {
  console.log('toggleSection called:', { charId, section });

  if (!sectionExpandedStates[charId]) {
    sectionExpandedStates[charId] = {};
  }
  sectionExpandedStates[charId][section] = !getSectionState(charId, section);
  saveSectionStates();

  // Update ALL matching sections visually (both party sidebar and character cards)
  const selector = `.section-collapsible[data-char="${charId}"][data-section="${section}"]`;
  const sectionEls = document.querySelectorAll(selector);
  console.log('Found elements:', sectionEls.length);

  sectionEls.forEach(sectionEl => {
    sectionEl.classList.toggle('expanded', sectionExpandedStates[charId][section]);
    const icon = sectionEl.querySelector('.section-toggle-icon');
    if (icon) {
      icon.textContent = sectionExpandedStates[charId][section] ? '▼' : '▶';
    }
  });

  console.log('Section toggled, expanded:', sectionExpandedStates[charId][section]);
}

// Use event delegation for section toggle - attach once to document
let sectionToggleListenerAttached = false;

function attachSectionToggleListeners() {
  // Only attach the delegated listener once
  if (sectionToggleListenerAttached) return;
  sectionToggleListenerAttached = true;

  document.addEventListener('click', function(e) {
    // Find the closest section-header with the toggle data attributes
    const header = e.target.closest('.section-header[data-toggle-char][data-toggle-section]');
    if (header) {
      e.stopPropagation();
      const charId = header.dataset.toggleChar;
      const section = header.dataset.toggleSection;
      if (charId && section) {
        toggleSection(charId, section);
      }
    }
  });
}

// Legacy function kept for compatibility but not used
function handleSectionToggleClick(e) {
  e.stopPropagation();
  const charId = e.currentTarget.dataset.toggleChar;
  const section = e.currentTarget.dataset.toggleSection;
  if (charId && section) {
    toggleSection(charId, section);
  }
}

function expandAllSections(charId) {
  if (!sectionExpandedStates[charId]) {
    sectionExpandedStates[charId] = {};
  }
  CHARACTER_SECTIONS.forEach(s => {
    sectionExpandedStates[charId][s] = true;
  });
  saveSectionStates();
  renderCharactersList();
  updatePartyList();
}

function collapseAllSections(charId) {
  if (!sectionExpandedStates[charId]) {
    sectionExpandedStates[charId] = {};
  }
  CHARACTER_SECTIONS.forEach(s => {
    sectionExpandedStates[charId][s] = false;
  });
  saveSectionStates();
  renderCharactersList();
  updatePartyList();
}

// Load section states on init
loadSectionStates();

function formatSpellSlots(spellSlots) {
  const levels = Object.keys(spellSlots).sort((a, b) => parseInt(a) - parseInt(b));
  if (levels.length === 0) return '';

  return '<strong>Spell Slots:</strong> ' + levels.map(lvl => {
    const slot = spellSlots[lvl];
    const available = (slot.max || 0) - (slot.used || 0);
    return `${lvl}st: ${available}/${slot.max || 0}`;
  }).join(' | ').replace(/1st/g, '1st').replace(/2st/g, '2nd').replace(/3st/g, '3rd');
}

function parseAcEffects(acEffectsJson) {
  try {
    const parsed = JSON.parse(acEffectsJson || '{}');
    return {
      base_source: parsed.base_source || 'Unarmored',
      base_value: parsed.base_value || 10,
      effects: parsed.effects || []
    };
  } catch (e) {
    return { base_source: 'Unarmored', base_value: 10, effects: [] };
  }
}

function formatAcDisplay(character) {
  const acEffects = parseAcEffects(character.ac_effects);
  const totalAc = character.ac || (acEffects.base_value + acEffects.effects.reduce((sum, e) => sum + (e.value || 0), 0));

  let html = `<span class="ac-total">${totalAc}</span>`;
  html += `<span class="ac-breakdown">(${escapeHtml(acEffects.base_source)}: ${acEffects.base_value}`;

  if (acEffects.effects.length > 0) {
    const effectsHtml = acEffects.effects.map(e => {
      const typeClass = e.temporary ? 'ac-effect-temp' : 'ac-effect-perm';
      return `<span class="${typeClass}" title="${escapeHtml(e.type)}${e.notes ? ' - ' + escapeHtml(e.notes) : ''}">${escapeHtml(e.name)}: +${e.value}</span>`;
    }).join(', ');
    html += ` + ${effectsHtml}`;
  }
  html += ')</span>';

  return html;
}

function formatAcShort(character) {
  const acEffects = parseAcEffects(character.ac_effects);
  const totalAc = character.ac || (acEffects.base_value + acEffects.effects.reduce((sum, e) => sum + (e.value || 0), 0));
  const hasEffects = acEffects.effects.length > 0;

  let title = `${acEffects.base_source}: ${acEffects.base_value}`;
  if (hasEffects) {
    title += '\n' + acEffects.effects.map(e => `${e.name}: +${e.value} (${e.type})`).join('\n');
  }

  return `<span class="ac-info${hasEffects ? ' has-effects' : ''}" title="${escapeHtml(title)}">AC: ${totalAc}${hasEffects ? '*' : ''}</span>`;
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
    sessionCharacters.map(c => `<option value="${c.id}">${escapeHtml(c.character_name)} (${escapeHtml(c.player_name)})</option>`).join('');
}

function updatePartyList() {
  const list = document.getElementById('party-list');
  // Use session characters if a session is loaded, otherwise use all characters
  const partyChars = currentSession && sessionCharacters.length > 0 ? sessionCharacters : characters;
  list.innerHTML = partyChars.map(c => {
    const xp = c.xp || 0;
    const requiredXP = getRequiredXP(c.level);
    const gold = c.gold || 0;
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
    const hasSpellSlots = Object.keys(spellSlots).length > 0;

    // Format AC with effects indicator
    const acShortDisplay = formatAcShort(c);

    // Helper function to create collapsible section for party view
    // isHtml=true means content is already sanitized HTML, false means escape it
    const createPartySection = (sectionId, label, content, colorClass, isHtml = false) => {
      if (!content) return '';
      const isExpanded = getSectionState(c.id, sectionId);
      // Escape plain text content and convert newlines to <br>
      const safeContent = isHtml ? content : escapeHtml(content).replace(/\n/g, '<br>');
      return `
        <div class="section-collapsible party-section ${colorClass} ${isExpanded ? 'expanded' : ''}" data-char="${c.id}" data-section="${sectionId}">
          <div class="section-header" onclick="event.stopPropagation(); toggleSection('${c.id}', '${sectionId}')">
            <span class="section-toggle-icon">${isExpanded ? '▼' : '▶'}</span>
            <strong>${escapeHtml(label)}</strong>
          </div>
          <div class="section-content">${safeContent}</div>
        </div>
      `;
    };

    return `
    <div class="party-item" data-id="${c.id}">
      <!-- Party Header (always visible) -->
      <div class="party-header">
        <div class="party-header-row">
          <div class="name">${escapeHtml(c.character_name)}</div>
          <div class="level">Lv.${c.level}</div>
        </div>
        <div class="info">${escapeHtml(c.race)} ${escapeHtml(c.class)}</div>
        <div class="party-summary">
          <div class="combat-info">
            <span class="hp">HP: ${c.hp}/${c.max_hp}</span>
            ${acShortDisplay}
          </div>
          <div class="gold-info">Money: ${gold}</div>
          <div class="xp-info">XP: ${xp}/${requiredXP} ${canLevel ? '(Ready!)' : ''}</div>
          <div class="party-stats">
            <span>STR:${c.strength}</span>
            <span>DEX:${c.dexterity}</span>
            <span>CON:${c.constitution}</span>
            <span>INT:${c.intelligence}</span>
            <span>WIS:${c.wisdom}</span>
            <span>CHA:${c.charisma}</span>
          </div>
        </div>
      </div>

      <!-- Collapsible Party Sections -->
      <div class="party-sections">
        ${createPartySection('appearance', 'Appearance', c.appearance, 'section-appearance')}
        ${createPartySection('backstory', 'Backstory', c.backstory, 'section-backstory')}
        ${hasSpellSlots ? createPartySection('spellSlots', 'Spell Slots', spellSlotsShort, 'section-spellslots') : ''}
        ${createPartySection('skills', 'Skills', c.skills, 'section-skills')}
        ${createPartySection('spells', 'Spells', c.spells, 'section-spells')}
        ${createPartySection('passives', 'Passives', c.passives, 'section-passives')}
        ${createPartySection('classFeatures', 'Class Features', c.class_features, 'section-classfeatures')}
        ${createPartySection('inventory', `Inventory (${itemCount})`,
          itemCount > 0 ? inventory.map(i => `${escapeHtml(i.name)}${i.quantity > 1 ? ' x' + i.quantity : ''}`).join(', ') : 'None',
          'section-inventory', true)}
      </div>

      <!-- Party Actions -->
      <div class="party-actions">
        <button class="party-btn" onclick="event.stopPropagation(); openInventoryModal('${c.id}')">Inv</button>
        <button class="party-btn" onclick="event.stopPropagation(); openSpellSlotsModal('${c.id}')">Spells</button>
        <button class="party-btn ${canLevel ? 'party-btn-levelup' : ''}" onclick="event.stopPropagation(); levelUpCharacter('${c.id}')" ${canLevel ? '' : 'disabled'}>${canLevel ? 'Level Up!' : 'Need XP'}</button>
      </div>
    </div>
  `}).join('');

  // Attach event listeners for collapsible sections in party sidebar
  attachSectionToggleListeners();
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

async function resetLevel(id, name) {
  if (!confirm(`Reset ${name} to Level 1?\n\nThis will:\n- Set level to 1\n- Set XP to 0\n- Reset HP to level 1 value\n- AI will determine which spells, skills, passives, feats, and class features to keep\n\nThis cannot be undone!`)) return;

  try {
    showNotification(`Resetting ${name} to Level 1... (AI is analyzing features to keep)`);
    const result = await api(`/api/characters/${id}/reset-level`, 'POST');

    let message = `${name} reset to Level 1 (HP: ${result.newHP})`;
    const kept = [];
    if (result.keptSpells) kept.push(`Spells: ${result.keptSpells}`);
    if (result.keptSkills) kept.push(`Skills: ${result.keptSkills}`);
    if (result.keptPassives) kept.push(`Passives: ${result.keptPassives}`);
    if (result.keptFeats) kept.push(`Feats: ${result.keptFeats}`);
    if (result.keptClassFeatures) kept.push(`Features: ${result.keptClassFeatures}`);

    if (kept.length > 0) {
      message += `\nKept: ${kept.join(', ')}`;
    }

    showNotification(message);
    loadCharacters();
  } catch (error) {
    console.error('Failed to reset level:', error);
    alert('Failed to reset level: ' + error.message);
  }
}

// Sessions
async function loadSessions() {
  try {
    const sessions = await api('/api/sessions');
    const list = document.getElementById('session-list');
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

async function deleteSession(id, name) {
  if (!confirm(`Are you sure you want to delete the session "${name}"?\n\nThis will permanently delete all story history and progress!`)) {
    return;
  }

  try {
    await api(`/api/sessions/${id}`, 'DELETE');
    showNotification(`Session "${name}" deleted`);
    // Clear current session if it was the deleted one
    if (currentSession && currentSession.id === id) {
      currentSession = null;
      document.getElementById('story-container').innerHTML = '<p class="no-session">Select or create a session to begin your adventure!</p>';
    }
    loadSessions();
  } catch (error) {
    console.error('Failed to delete session:', error);
    alert('Failed to delete session: ' + error.message);
  }
}

// Scenario definitions
const SESSION_SCENARIOS = [
  {
    id: 'classic_fantasy',
    name: 'Classic Fantasy',
    description: 'Traditional D&D setting with dungeons, dragons, and medieval adventure',
    icon: '🏰'
  },
  {
    id: 'tavern_start',
    name: 'Tavern Meeting',
    description: 'The classic "you all meet in a tavern" opening - strangers brought together by fate',
    icon: '🍺'
  },
  {
    id: 'modern_urban',
    name: 'Modern Urban Fantasy',
    description: 'Magic hidden in the modern world - secret societies, urban mysteries',
    icon: '🌃'
  },
  {
    id: 'zombie_apocalypse',
    name: 'Zombie Apocalypse',
    description: 'Survival horror in a world overrun by the undead',
    icon: '🧟'
  },
  {
    id: 'space_opera',
    name: 'Space Opera',
    description: 'Sci-fi adventure among the stars - alien worlds, space stations, galactic intrigue',
    icon: '🚀'
  },
  {
    id: 'noir_detective',
    name: 'Noir Detective',
    description: 'Gritty 1940s detective story - rain-slicked streets, femme fatales, dark secrets',
    icon: '🔍'
  },
  {
    id: 'pirate_adventure',
    name: 'Pirate Adventure',
    description: 'High seas adventure - treasure hunting, naval battles, mysterious islands',
    icon: '🏴‍☠️'
  },
  {
    id: 'post_apocalyptic',
    name: 'Post-Apocalyptic',
    description: 'Wasteland survival after civilization fell - scavengers, raiders, lost technology',
    icon: '☢️'
  },
  {
    id: 'horror_mystery',
    name: 'Horror Mystery',
    description: 'Lovecraftian horror - eldritch secrets, cosmic dread, sanity-testing revelations',
    icon: '👁️'
  },
  {
    id: 'custom',
    name: 'Custom Setting',
    description: 'Describe your own unique world and starting scenario',
    icon: '✨'
  }
];

function openNewSessionModal() {
  renderScenarioOptions();
  renderCharacterSelection();
  document.getElementById('new-session-name').value = '';
  document.getElementById('custom-scenario-input').value = '';
  document.getElementById('custom-scenario-group').style.display = 'none';
  selectedScenario = 'classic_fantasy';
  selectedCharacterIds = [];
  updateSelectedCharacterCount();
  // Auto-select first scenario
  setTimeout(() => selectScenario('classic_fantasy'), 10);
  document.getElementById('new-session-modal').classList.add('active');
}

function renderCharacterSelection() {
  const container = document.getElementById('character-selection-list');

  if (characters.length === 0) {
    container.innerHTML = '<p class="no-characters-msg">No characters created yet. Create characters first!</p>';
    return;
  }

  container.innerHTML = characters.map(c => {
    const classDisplay = c.classes ? formatMulticlass(JSON.parse(c.classes || '{}')) : `${c.class} ${c.level}`;
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

function formatMulticlass(classes) {
  if (!classes || Object.keys(classes).length === 0) return '';
  return Object.entries(classes).map(([cls, lvl]) => `${cls} ${lvl}`).join(' / ');
}

function toggleCharacterSelection(charId, isSelected) {
  if (isSelected) {
    if (!selectedCharacterIds.includes(charId)) {
      selectedCharacterIds.push(charId);
    }
  } else {
    selectedCharacterIds = selectedCharacterIds.filter(id => id !== charId);
  }

  // Update visual state
  const item = document.querySelector(`.character-selection-item[data-id="${charId}"]`);
  if (item) {
    item.classList.toggle('selected', isSelected);
  }

  updateSelectedCharacterCount();
}

function updateSelectedCharacterCount() {
  document.getElementById('selected-character-count').textContent = selectedCharacterIds.length;
}

function closeNewSessionModal() {
  document.getElementById('new-session-modal').classList.remove('active');
}

function renderScenarioOptions() {
  const container = document.getElementById('scenario-options');
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

let selectedScenario = 'classic_fantasy';
let selectedCharacterIds = [];

function selectScenario(scenarioId) {
  selectedScenario = scenarioId;

  // Update visual selection
  document.querySelectorAll('.scenario-option').forEach(el => {
    el.classList.toggle('selected', el.dataset.id === scenarioId);
  });

  // Show/hide custom input
  const customGroup = document.getElementById('custom-scenario-group');
  customGroup.style.display = scenarioId === 'custom' ? 'block' : 'none';
}

async function createSession() {
  const name = document.getElementById('new-session-name').value.trim();
  if (!name) {
    alert('Please enter a session name');
    return;
  }

  if (selectedCharacterIds.length === 0) {
    alert('Please select at least one character for this session');
    return;
  }

  const scenario = SESSION_SCENARIOS.find(s => s.id === selectedScenario);
  let scenarioPrompt = '';

  if (selectedScenario === 'custom') {
    scenarioPrompt = document.getElementById('custom-scenario-input').value.trim();
    if (!scenarioPrompt) {
      alert('Please describe your custom scenario');
      return;
    }
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

async function loadSession(id) {
  try {
    const data = await api(`/api/sessions/${id}`);
    currentSession = data.session;

    // Store session-specific characters
    sessionCharacters = data.sessionCharacters || [];

    // Update character select dropdown with session characters
    updateCharacterSelect();

    // Update party list with session characters
    updatePartyList();

    // Update UI
    document.getElementById('turn-counter').textContent = `Turn: ${currentSession.current_turn}`;
    document.getElementById('token-counter').textContent = `Tokens: ${currentSession.total_tokens}`;

    // Render story - summary is now backend-only for AI context
    // Players see the full chat history
    const history = JSON.parse(currentSession.full_history || '[]');
    const historyContainer = document.getElementById('story-history');
    historyContainer.innerHTML = renderStoryHistory(history);

    // Scroll to bottom (with delay for mobile compatibility)
    scrollStoryToBottom();

    // Update pending actions
    updatePendingActions(data.pendingActions);

    // Update session list to show active
    loadSessions();
    saveAppState(); // Save state when session changes

    // Load combat state for this session
    loadCombat();
  } catch (error) {
    console.error('Failed to load session:', error);
  }
}

// Helper to refresh session characters without reloading entire session
async function refreshSessionCharacters() {
  if (!currentSession) return;
  try {
    const data = await api(`/api/sessions/${currentSession.id}`);
    sessionCharacters = data.sessionCharacters || [];
    updatePartyList();
  } catch (error) {
    console.error('Failed to refresh session characters:', error);
  }
}

function updatePendingActions(pendingActions) {
  const container = document.getElementById('pending-actions');
  const waitingCount = sessionCharacters.length - pendingActions.length;

  document.getElementById('waiting-counter').textContent = `Waiting for: ${waitingCount} players`;

  container.innerHTML = sessionCharacters.map(c => {
    const action = pendingActions.find(a => a.character_id === c.id);
    return `
      <div class="action-item ${action ? 'submitted' : ''}">
        <div class="player">${escapeHtml(c.character_name)}</div>
        <div class="action-status">
          ${action ? `<span class="action-preview" title="${escapeHtml(action.action)}">Action submitted</span>
            <button class="btn-cancel-action" onclick="cancelAction('${c.id}')" title="Cancel action">✕</button>`
            : 'Waiting...'}
        </div>
      </div>
    `;
  }).join('');
}

async function cancelAction(characterId) {
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

function formatContent(content) {
  // SECURITY: Must escape HTML first to prevent XSS
  return escapeHtml(content)
    .replace(/\n/g, '<br>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>');
}

// Render story history with beautified player actions
function renderStoryHistory(history) {
  let html = '';
  let turnActions = []; // Collect actions for a turn
  let turnActionIndices = []; // Track original indices for delete

  for (let i = 0; i < history.length; i++) {
    const entry = history[i];

    // Skip hidden context messages (character sheets)
    if (entry.hidden || entry.type === 'context') {
      continue;
    }

    // Handle player actions - collect and display as a group
    if (entry.type === 'action') {
      turnActions.push(entry);
      turnActionIndices.push(i);
      continue;
    }

    // When we hit a narration or legacy assistant message, first render any collected actions
    if (entry.role === 'assistant' || entry.type === 'narration') {
      if (turnActions.length > 0) {
        html += renderPlayerActionsGroup(turnActions, turnActionIndices);
        turnActions = [];
        turnActionIndices = [];
      }

      // Render DM narration with TTS play button and delete button
      const ttsId = 'tts-' + Math.random().toString(36).substr(2, 9);
      // Store content in base64 to avoid escaping issues with special characters
      const ttsContent = btoa(encodeURIComponent(entry.content));
      html += `
        <div class="story-entry assistant narration" data-index="${i}">
          <div class="narration-header">
            <div class="role">Dungeon Master</div>
            <div class="narration-controls">
              <button class="tts-play-btn" id="${ttsId}" data-tts-content="${ttsContent}" onclick="handleTTSClick(this)" title="Play narration">🔊</button>
              <button class="delete-msg-btn" onclick="deleteStoryMessage(${i})" title="Delete this message">🗑️</button>
            </div>
          </div>
          <div class="content">${formatContent(entry.content)}</div>
        </div>
      `;
      continue;
    }

    // Legacy format - user messages without type
    if (entry.role === 'user' && !entry.type) {
      // Check if it looks like old combined format
      if (entry.content.includes('PARTY STATUS:') || entry.content.includes('PLAYER ACTIONS THIS TURN:')) {
        // Parse legacy format - extract actions if possible
        const actionsMatch = entry.content.match(/PLAYER ACTIONS THIS TURN:\s*([\s\S]*?)(?:Please narrate|$)/i);
        if (actionsMatch) {
          const actionLines = actionsMatch[1].trim().split('\n').filter(l => l.trim());
          for (const line of actionLines) {
            const colonIdx = line.indexOf(':');
            if (colonIdx > 0) {
              const charName = line.substring(0, colonIdx).trim();
              const action = line.substring(colonIdx + 1).trim();
              turnActions.push({
                character_name: charName,
                content: action,
                type: 'action'
              });
              turnActionIndices.push(i); // All from same legacy entry
            }
          }
        }
      } else {
        // Just a plain user message
        html += `
          <div class="story-entry user" data-index="${i}">
            <div class="role">Players</div>
            <div class="content">${formatContent(entry.content)}</div>
            <button class="delete-msg-btn" onclick="deleteStoryMessage(${i})" title="Delete this message">🗑️</button>
          </div>
        `;
      }
    }
  }

  // Render any remaining actions at the end
  if (turnActions.length > 0) {
    html += renderPlayerActionsGroup(turnActions, turnActionIndices);
  }

  return html;
}

// Render a group of player actions as individual character bubbles
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

    // Generate a consistent color based on character name
    const colorIndex = charName.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) % 6;
    const colorClass = `char-color-${colorIndex}`;

    html += `
      <div class="player-action-bubble ${colorClass}" data-index="${index}">
        <div class="action-avatar">${initial}</div>
        <div class="action-content">
          <div class="action-character-name">${escapeHtml(charName)}${playerName ? ` <span class="action-player-name">(${escapeHtml(playerName)})</span>` : ''}</div>
          <div class="action-text">${formatContent(action.content)}</div>
        </div>
        ${index >= 0 ? `<button class="delete-action-btn" onclick="deleteStoryMessage(${index})" title="Delete this action">🗑️</button>` : ''}
      </div>
    `;
  }

  html += '</div>';
  return html;
}

// Delete a message from story history
async function deleteStoryMessage(index) {
  if (!currentSession) {
    alert('No session selected');
    return;
  }

  if (!confirm('Delete this message? This cannot be undone.')) {
    return;
  }

  try {
    await api(`/api/sessions/${currentSession.id}/delete-message`, 'POST', { index });
    // Reload session to refresh history
    await loadSession(currentSession.id);
    showNotification('Message deleted');
  } catch (error) {
    console.error('Failed to delete message:', error);
    alert('Failed to delete message: ' + error.message);
  }
}

// Actions
async function submitAction() {
  if (!currentSession) {
    alert('Please select a session first');
    return;
  }

  // Block submission if turn is currently processing
  if (isTurnProcessing) {
    alert('Please wait - the Narrator is still processing the current turn');
    return;
  }

  const characterId = document.getElementById('action-character').value;
  const actionTextarea = document.getElementById('action-text');
  const action = actionTextarea.value;

  if (!characterId) {
    alert('Please select your character');
    return;
  }

  if (!action.trim()) {
    alert('Please enter an action');
    return;
  }

  // Clear textarea IMMEDIATELY before API call to prevent stale data
  actionTextarea.value = '';

  // Disable submit button while submitting
  const submitBtn = document.querySelector('.action-form button[type="submit"], .action-form button[onclick*="submitAction"]');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting...';
  }

  try {
    const result = await api(`/api/sessions/${currentSession.id}/action`, 'POST', {
      character_id: characterId,
      action: action
    });

    if (result.processed) {
      loadSession(currentSession.id);
    }

    showNotification('Action submitted!');
  } catch (error) {
    console.error('Failed to submit action:', error);
    // Restore the action text if submission failed
    actionTextarea.value = action;

    // Check if it's a "processing" error (409) - sync the local state
    if (error.message && error.message.includes('processing')) {
      isTurnProcessing = true;
      showNotification('Please wait - turn is being processed');
    } else {
      alert('Failed to submit action: ' + error.message);
    }
  } finally {
    // Re-enable submit button (unless turn is now processing)
    updateActionFormState();
  }
}

// Update action form state based on processing status
function updateActionFormState() {
  const submitBtn = document.querySelector('.action-form button[type="submit"], .action-form button[onclick*="submitAction"]');
  const actionTextarea = document.getElementById('action-text');

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
    if (isTurnProcessing) {
      actionTextarea.placeholder = 'Please wait for the Narrator to finish...';
    } else {
      actionTextarea.placeholder = 'What do you do?';
    }
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

async function rerollLastResponse() {
  if (!currentSession) {
    alert('Please select a session first');
    return;
  }

  if (!confirm('Regenerate the last AI response?')) return;

  try {
    await api(`/api/sessions/${currentSession.id}/reroll`, 'POST');
    // The turn_processed event will handle refreshing the UI
  } catch (error) {
    console.error('Failed to reroll:', error);
    alert('Failed to reroll: ' + error.message);
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
      const xpEntries = Object.entries(result.xpAwarded);
      let xpSummary;
      if (xpEntries.length > 0) {
        // Show XP found for each character
        const details = xpEntries.map(([charId, xp]) => {
          const char = sessionCharacters.find(c => c.id === charId) || characters.find(c => c.id === charId);
          return char ? `${char.character_name}: ${xp} XP` : `Unknown: ${xp} XP`;
        }).join('\n');
        xpSummary = `XP recalculated!\n\n${details}`;
      } else {
        xpSummary = 'No [XP: ...] tags found in session history.';
      }
      alert(xpSummary);
      // Refresh both characters and sessionCharacters
      await loadCharacters();
      await refreshSessionCharacters();
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

async function recalculateInventory() {
  if (!currentSession) {
    alert('Please select a session first');
    return;
  }

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
      await loadCharacters();
      await refreshSessionCharacters();
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
      <div class="message-content">What would you like to change about ${char.character_name}? You can ask me to update stats, spells, skills, appearance, backstory, or anything else. (Use the Inventory button to manage items.)</div>
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
      await refreshSessionCharacters();
      if (isLevelUp) {
        messagesContainer.innerHTML += `<div class="chat-message assistant"><div class="message-content"><strong>Level up complete!</strong></div></div>`;
        messagesContainer.innerHTML += `<div class="chat-message assistant"><div class="message-content">Want to make any other changes? Just ask!</div></div>`;
        showNotification(`${result.character.character_name} is now level ${result.character.level}!`);
        // Reset for further changes
        levelUpMessages = [];
      } else {
        messagesContainer.innerHTML += `<div class="chat-message assistant"><div class="message-content"><strong>Changes saved!</strong></div></div>`;
        messagesContainer.innerHTML += `<div class="chat-message assistant"><div class="message-content">Want to make more changes? Just ask!</div></div>`;
        // Reset for further changes
        modalMessages = [];
      }
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
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
    messagesContainer.innerHTML = `<div class="chat-message assistant"><div class="message-content">Error: ${escapeHtml(error.message)}</div></div>`;
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

  // Load AC effects
  const acEffects = parseAcEffects(char.ac_effects);
  document.getElementById('ac-base-source').value = acEffects.base_source || 'Unarmored';
  document.getElementById('ac-base-value').value = acEffects.base_value || 10;
  document.getElementById('ac-total-value').textContent = char.ac || 10;

  renderAcEffectsList(char);
  renderSpellSlotsList(char);

  document.getElementById('spell-slots-modal').classList.add('active');
}

function closeSpellSlotsModal() {
  document.getElementById('spell-slots-modal').classList.remove('active');
  spellSlotsModalCharId = null;
}

function renderAcEffectsList(char) {
  const acEffects = parseAcEffects(char.ac_effects);
  const listEl = document.getElementById('ac-effects-list');

  if (acEffects.effects.length === 0) {
    listEl.innerHTML = '<div class="ac-effects-empty">No active AC effects</div>';
  } else {
    listEl.innerHTML = acEffects.effects.map(effect => {
      const typeLabel = effect.type === 'spell' ? 'Spell' :
                       effect.type === 'equipment' ? 'Equipment' :
                       effect.type === 'item' ? 'Magic Item' :
                       effect.type === 'class_feature' ? 'Class' : 'Other';
      const tempClass = effect.temporary ? 'effect-temporary' : 'effect-permanent';
      return `
        <div class="ac-effect-row ${tempClass}">
          <span class="effect-name">${escapeHtml(effect.name)}</span>
          <span class="effect-value">${effect.value >= 0 ? '+' : ''}${effect.value}</span>
          <span class="effect-type">${typeLabel}</span>
          ${effect.temporary ? '<span class="effect-temp-badge">Temp</span>' : ''}
          <button class="btn-tiny btn-remove" onclick="removeAcEffect('${effect.id}')">X</button>
        </div>
      `;
    }).join('');
  }

  // Update total display
  document.getElementById('ac-total-value').textContent = char.ac || 10;
}

async function updateAcBase() {
  if (!spellSlotsModalCharId) return;

  const baseSource = document.getElementById('ac-base-source').value.trim() || 'Unarmored';
  const baseValue = parseInt(document.getElementById('ac-base-value').value) || 10;

  try {
    const result = await api(`/api/characters/${spellSlotsModalCharId}/ac`, 'POST', {
      action: 'set_base',
      base_source: baseSource,
      base_value: baseValue
    });

    const charIdx = characters.findIndex(c => c.id === spellSlotsModalCharId);
    if (charIdx !== -1) {
      characters[charIdx] = result.character;
      renderAcEffectsList(result.character);
    }
    loadCharacters();
    showNotification('Base AC updated');
  } catch (error) {
    alert('Failed to update AC: ' + error.message);
  }
}

async function addAcEffect() {
  if (!spellSlotsModalCharId) return;

  const name = document.getElementById('new-effect-name').value.trim();
  const value = parseInt(document.getElementById('new-effect-value').value) || 0;
  const type = document.getElementById('new-effect-type').value;
  const temporary = document.getElementById('new-effect-temp').checked;

  if (!name) {
    alert('Please enter an effect name');
    return;
  }

  try {
    const result = await api(`/api/characters/${spellSlotsModalCharId}/ac`, 'POST', {
      action: 'add_effect',
      effect: { name, value, type, temporary }
    });

    const charIdx = characters.findIndex(c => c.id === spellSlotsModalCharId);
    if (charIdx !== -1) {
      characters[charIdx] = result.character;
      renderAcEffectsList(result.character);
    }

    // Clear inputs
    document.getElementById('new-effect-name').value = '';
    document.getElementById('new-effect-value').value = '2';
    document.getElementById('new-effect-temp').checked = false;

    loadCharacters();
    showNotification('AC effect added');
  } catch (error) {
    alert('Failed to add AC effect: ' + error.message);
  }
}

async function removeAcEffect(effectId) {
  if (!spellSlotsModalCharId) return;

  try {
    const result = await api(`/api/characters/${spellSlotsModalCharId}/ac`, 'POST', {
      action: 'remove_effect',
      effect: { id: effectId }
    });

    const charIdx = characters.findIndex(c => c.id === spellSlotsModalCharId);
    if (charIdx !== -1) {
      characters[charIdx] = result.character;
      renderAcEffectsList(result.character);
    }
    loadCharacters();
    showNotification('AC effect removed');
  } catch (error) {
    alert('Failed to remove AC effect: ' + error.message);
  }
}

async function clearTempAcEffects() {
  if (!spellSlotsModalCharId) return;

  try {
    const result = await api(`/api/characters/${spellSlotsModalCharId}/ac`, 'POST', {
      action: 'clear_temporary'
    });

    const charIdx = characters.findIndex(c => c.id === spellSlotsModalCharId);
    if (charIdx !== -1) {
      characters[charIdx] = result.character;
      renderAcEffectsList(result.character);
    }
    loadCharacters();
    showNotification('Temporary AC effects cleared');
  } catch (error) {
    alert('Failed to clear temporary effects: ' + error.message);
  }
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

// Extra scroll attempt after full page load (helps mobile)
window.addEventListener('load', () => {
  if (currentSession) {
    // Delay to ensure everything is rendered
    setTimeout(scrollStoryToBottom, 500);
    setTimeout(scrollStoryToBottom, 1500);
  }
});

// ============================================
// COMBAT TRACKER FUNCTIONS
// ============================================

let currentCombat = null;

// Load combat state when session loads
async function loadCombat() {
  if (!currentSession) return;

  try {
    const result = await api(`/api/sessions/${currentSession.id}/combat`);
    currentCombat = result.combat;
    renderCombatTracker();
  } catch (error) {
    console.error('Failed to load combat:', error);
  }
}

function renderCombatTracker() {
  const noCombatMsg = document.getElementById('no-combat-message');
  const combatActive = document.getElementById('combat-active');

  if (!currentCombat) {
    noCombatMsg.style.display = 'block';
    combatActive.style.display = 'none';
    return;
  }

  noCombatMsg.style.display = 'none';
  combatActive.style.display = 'block';

  document.getElementById('combat-name').textContent = currentCombat.name || 'Combat';
  document.getElementById('combat-round').textContent = `Round ${currentCombat.round}`;

  const orderEl = document.getElementById('initiative-order');
  orderEl.innerHTML = currentCombat.combatants.map((c, idx) => {
    const isCurrent = idx === currentCombat.current_turn;
    const isPlayer = c.is_player;
    const hpPercent = c.max_hp > 0 ? (c.hp / c.max_hp) * 100 : 0;
    const hpClass = hpPercent > 50 ? 'hp-healthy' : hpPercent > 25 ? 'hp-wounded' : 'hp-critical';
    const conditions = (c.conditions || []).join(', ');

    return `
      <div class="combatant ${isCurrent ? 'current-turn' : ''} ${!c.is_active ? 'defeated' : ''} ${isPlayer ? 'player' : 'enemy'}">
        <div class="combatant-init">${c.initiative}</div>
        <div class="combatant-info">
          <div class="combatant-name">${escapeHtml(c.name)}</div>
          <div class="combatant-stats">
            <span class="combatant-hp ${hpClass}">${c.hp}/${c.max_hp}</span>
            <span class="combatant-ac">AC ${c.ac}</span>
          </div>
          ${conditions ? `<div class="combatant-conditions">${escapeHtml(conditions)}</div>` : ''}
        </div>
        ${isCurrent ? '<div class="turn-indicator">▶</div>' : ''}
      </div>
    `;
  }).join('');
}

// Combat is now AI-driven - manual controls removed


// ============================================
// QUICK EDIT MODAL (Direct field editing)
// ============================================

let quickEditCharId = null;

function showQuickEditSection(sectionName) {
  // Hide all sections
  document.querySelectorAll('.quick-edit-section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.quick-edit-tab').forEach(t => t.classList.remove('active'));

  // Show selected section
  document.getElementById(`quick-edit-${sectionName}`).classList.add('active');
  event.target.classList.add('active');
}

function openQuickEditModal(charId) {
  const char = characters.find(c => c.id === charId);
  if (!char) return;

  quickEditCharId = charId;

  document.getElementById('quick-edit-title').textContent = `Edit: ${char.character_name}`;

  // Basic Info
  document.getElementById('quick-edit-player-name').value = char.player_name || '';
  document.getElementById('quick-edit-character-name').value = char.character_name || '';
  document.getElementById('quick-edit-race').value = char.race || '';
  document.getElementById('quick-edit-class').value = char.class || '';
  document.getElementById('quick-edit-level').value = char.level || 1;
  document.getElementById('quick-edit-xp').value = char.xp || 0;
  document.getElementById('quick-edit-gold').value = char.gold || 0;
  document.getElementById('quick-edit-background').value = char.background || '';

  // Stats
  document.getElementById('quick-edit-strength').value = char.strength || 10;
  document.getElementById('quick-edit-dexterity').value = char.dexterity || 10;
  document.getElementById('quick-edit-constitution').value = char.constitution || 10;
  document.getElementById('quick-edit-intelligence').value = char.intelligence || 10;
  document.getElementById('quick-edit-wisdom').value = char.wisdom || 10;
  document.getElementById('quick-edit-charisma').value = char.charisma || 10;

  // Combat
  document.getElementById('quick-edit-hp').value = char.hp || 10;
  document.getElementById('quick-edit-max-hp').value = char.max_hp || 10;
  document.getElementById('quick-edit-ac').value = char.ac || 10;
  document.getElementById('quick-edit-spell-slots').value = char.spell_slots || '';

  // Abilities
  document.getElementById('quick-edit-spells').value = char.spells || '';
  document.getElementById('quick-edit-skills').value = char.skills || '';
  document.getElementById('quick-edit-class-features').value = char.class_features || '';
  document.getElementById('quick-edit-passives').value = char.passives || '';
  document.getElementById('quick-edit-feats').value = char.feats || '';

  // Story
  document.getElementById('quick-edit-appearance').value = char.appearance || '';
  document.getElementById('quick-edit-backstory').value = char.backstory || '';

  // Reset to first tab
  document.querySelectorAll('.quick-edit-section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.quick-edit-tab').forEach(t => t.classList.remove('active'));
  document.getElementById('quick-edit-basic').classList.add('active');
  document.querySelector('.quick-edit-tab').classList.add('active');

  document.getElementById('quick-edit-modal').classList.add('active');
}

function closeQuickEditModal() {
  document.getElementById('quick-edit-modal').classList.remove('active');
  quickEditCharId = null;
}

async function saveQuickEdit() {
  if (!quickEditCharId) return;

  const data = {
    // Basic Info
    player_name: document.getElementById('quick-edit-player-name').value,
    character_name: document.getElementById('quick-edit-character-name').value,
    race: document.getElementById('quick-edit-race').value,
    class: document.getElementById('quick-edit-class').value,
    level: parseInt(document.getElementById('quick-edit-level').value) || 1,
    xp: parseInt(document.getElementById('quick-edit-xp').value) || 0,
    gold: parseInt(document.getElementById('quick-edit-gold').value) || 0,
    background: document.getElementById('quick-edit-background').value,

    // Stats
    strength: parseInt(document.getElementById('quick-edit-strength').value) || 10,
    dexterity: parseInt(document.getElementById('quick-edit-dexterity').value) || 10,
    constitution: parseInt(document.getElementById('quick-edit-constitution').value) || 10,
    intelligence: parseInt(document.getElementById('quick-edit-intelligence').value) || 10,
    wisdom: parseInt(document.getElementById('quick-edit-wisdom').value) || 10,
    charisma: parseInt(document.getElementById('quick-edit-charisma').value) || 10,

    // Combat
    hp: parseInt(document.getElementById('quick-edit-hp').value) || 10,
    max_hp: parseInt(document.getElementById('quick-edit-max-hp').value) || 10,
    ac: parseInt(document.getElementById('quick-edit-ac').value) || 10,
    spell_slots: document.getElementById('quick-edit-spell-slots').value,

    // Abilities
    spells: document.getElementById('quick-edit-spells').value,
    skills: document.getElementById('quick-edit-skills').value,
    class_features: document.getElementById('quick-edit-class-features').value,
    passives: document.getElementById('quick-edit-passives').value,
    feats: document.getElementById('quick-edit-feats').value,

    // Story
    appearance: document.getElementById('quick-edit-appearance').value,
    backstory: document.getElementById('quick-edit-backstory').value
  };

  try {
    await api(`/api/characters/${quickEditCharId}/quick-update`, 'POST', data);
    await loadCharacters();
    await refreshSessionCharacters();
    closeQuickEditModal();
    showNotification('Character updated!');
  } catch (error) {
    alert('Failed to update character: ' + error.message);
  }
}
