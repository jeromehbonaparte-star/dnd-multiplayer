// ============================================
// Socket.IO Initialization & Event Handlers
// ============================================

import { getState, setState } from './state.js';
import { showConnectionStatus, hideConnectionStatus, showNotification, showNarratorTyping, hideNarratorTyping } from './utils/dom.js';
import { loadCharacters } from './modules/characters.js';
import { loadSessions, loadSession, updatePendingActions, updateActionFormState, appendStreamChunk, finalizeStreamedContent } from './modules/sessions.js';
import { renderCombatTracker } from './modules/combat.js';
import { loadSessionSummary } from './modules/settings.js';

export function initSocket() {
  // Clean up existing socket if any
  const existingSocket = getState('socket');
  if (existingSocket) {
    existingSocket.disconnect();
  }

  const socket = io({
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 20000
  });

  setState({ socket });

  // Connection status handling
  socket.off('connect');
  socket.on('connect', () => {
    console.log('Connected to server');
    hideConnectionStatus();
    const currentSession = getState('currentSession');
    if (currentSession) {
      loadSession(currentSession.id);
    }
    loadCharacters();
  });

  socket.off('disconnect');
  socket.on('disconnect', (reason) => {
    console.log('Disconnected from server:', reason);
    showConnectionStatus('Disconnected - Reconnecting...', 'warning');
  });

  socket.off('reconnect');
  socket.on('reconnect', (attemptNumber) => {
    console.log('Reconnected after', attemptNumber, 'attempts');
    showConnectionStatus('Reconnected!', 'success');
    setTimeout(hideConnectionStatus, 2000);

    // Reload current session state to get latest data
    const currentSession = getState('currentSession');
    if (currentSession) {
      import('./modules/sessions.js').then(m => m.loadSession(currentSession.id));
    }

    // Clear any stale UI state
    setState({ isTurnProcessing: false });

    // Hide typing indicators
    const typingEl = document.getElementById('narrator-typing');
    if (typingEl) typingEl.style.display = 'none';
  });

  socket.off('reconnect_attempt');
  socket.on('reconnect_attempt', (attemptNumber) => {
    showConnectionStatus(`Reconnecting... (attempt ${attemptNumber})`, 'warning');
  });

  socket.off('reconnect_error');
  socket.on('reconnect_error', (error) => {
    console.error('Reconnection error:', error);
  });

  socket.off('reconnect_failed');
  socket.on('reconnect_failed', () => {
    showConnectionStatus('Connection lost. Please refresh the page.', 'error');
  });

  socket.off('connect_error');
  socket.on('connect_error', (error) => {
    console.error('Connection error:', error);
    showConnectionStatus('Connection error - Retrying...', 'warning');
  });

  socket.off('character_created');
  socket.on('character_created', (character) => {
    loadCharacters();
  });

  socket.off('character_deleted');
  socket.on('character_deleted', (id) => {
    loadCharacters();
  });

  socket.off('session_created');
  socket.on('session_created', (session) => {
    loadSessions();
  });

  socket.off('session_deleted');
  socket.on('session_deleted', (sessionId) => {
    const currentSession = getState('currentSession');
    if (currentSession && currentSession.id === sessionId) {
      setState({ currentSession: null });
      document.getElementById('story-summary').textContent = '';
      document.getElementById('story-history').innerHTML = '';
      document.getElementById('turn-counter').textContent = 'Turn: 0';
      document.getElementById('token-counter').textContent = 'Tokens: 0';
      document.getElementById('waiting-counter').textContent = 'Waiting for: 0 players';
      document.getElementById('pending-actions').innerHTML = '';
    }
    loadSessions();
  });

  socket.off('action_submitted');
  socket.on('action_submitted', ({ sessionId, pendingActions, character_id }) => {
    const currentSession = getState('currentSession');
    if (currentSession && currentSession.id === sessionId) {
      updatePendingActions(pendingActions);
    }
  });

  socket.off('action_cancelled');
  socket.on('action_cancelled', ({ sessionId, pendingActions, character_id }) => {
    const currentSession = getState('currentSession');
    if (currentSession && currentSession.id === sessionId) {
      updatePendingActions(pendingActions);
    }
  });

  socket.off('turn_processing');
  socket.on('turn_processing', ({ sessionId }) => {
    const currentSession = getState('currentSession');
    if (currentSession && currentSession.id === sessionId) {
      setState({ isTurnProcessing: true });
      showNarratorTyping();
      updateActionFormState();
    }
  });

  socket.off('reroll_started');
  socket.on('reroll_started', ({ sessionId }) => {
    const currentSession = getState('currentSession');
    if (currentSession && currentSession.id === sessionId) {
      setState({ isTurnProcessing: true });
      showNarratorTyping();
      updateActionFormState();
      showNotification('Regenerating response...');
    }
  });

  // Streaming: receive incremental text chunks from AI
  socket.off('turn_chunk');
  socket.on('turn_chunk', ({ sessionId, text }) => {
    const currentSession = getState('currentSession');
    if (currentSession && currentSession.id === sessionId) {
      appendStreamChunk(text);
    }
  });

  socket.off('turn_processed');
  socket.on('turn_processed', ({ sessionId, response, turn, tokensUsed, compacted }) => {
    const currentSession = getState('currentSession');
    if (currentSession && currentSession.id === sessionId) {
      setState({ isTurnProcessing: false });
      hideNarratorTyping();
      // Replace streamed content with final formatted version, then reload
      finalizeStreamedContent();
      loadSession(sessionId);
      updateActionFormState();
      if (compacted) {
        showNotification('History was auto-compacted to save tokens!');
      }
    }
  });

  socket.off('character_updated');
  socket.on('character_updated', (character) => {
    const sessionCharacters = [...getState('sessionCharacters')];
    const sessionIdx = sessionCharacters.findIndex(c => c.id === character.id);
    if (sessionIdx !== -1) {
      sessionCharacters[sessionIdx] = character;
      setState({ sessionCharacters });
    }
    loadCharacters();
  });

  socket.off('character_leveled_up');
  socket.on('character_leveled_up', ({ character, summary }) => {
    const sessionCharacters = [...getState('sessionCharacters')];
    const sessionIdx = sessionCharacters.findIndex(c => c.id === character.id);
    if (sessionIdx !== -1) {
      sessionCharacters[sessionIdx] = character;
      setState({ sessionCharacters });
    }
    loadCharacters();
    showNotification(`${character.character_name} leveled up to ${character.level}! ${summary}`);
  });

  // Combat tracker events
  socket.off('combat_started');
  socket.on('combat_started', ({ sessionId, combat }) => {
    const currentSession = getState('currentSession');
    if (currentSession && currentSession.id === sessionId) {
      setState({ currentCombat: combat });
      renderCombatTracker();
      showNotification('Combat started!');
    }
  });

  socket.off('combat_updated');
  socket.on('combat_updated', ({ sessionId, combat }) => {
    const currentSession = getState('currentSession');
    if (currentSession && currentSession.id === sessionId) {
      setState({ currentCombat: combat });
      renderCombatTracker();
    }
  });

  socket.off('combat_ended');
  socket.on('combat_ended', ({ sessionId }) => {
    const currentSession = getState('currentSession');
    if (currentSession && currentSession.id === sessionId) {
      setState({ currentCombat: null });
      renderCombatTracker();
      showNotification('Combat ended');
    }
  });

  socket.off('session_compacted');
  socket.on('session_compacted', ({ sessionId, compactedCount }) => {
    showNotification(`Session history compacted! ${compactedCount} entries summarized.`);

    const summarySelect = document.getElementById('summary-session-select');
    if (summarySelect && summarySelect.value == sessionId) {
      loadSessionSummary();
    }

    const currentSession = getState('currentSession');
    if (currentSession && currentSession.id === sessionId) {
      loadSession(sessionId);
    }
  });
}
