// ============================================
// Settings Module
// - Settings tab, GM mode, TTS, summary management
// ============================================

import { getState, setState } from '../state.js';
import { api } from '../api.js';
import { escapeHtml } from '../utils/formatters.js';
import { showNotification } from '../utils/dom.js';
import { ttsManager } from './tts.js';
import { loadCharacters } from './characters.js';
import { refreshSessionCharacters, loadSession } from './sessions.js';
import { saveAppState } from './auth.js';

// ============================================
// Load settings
// ============================================

export async function loadSettings() {
  try {
    const settings = await api('/api/settings');
    document.getElementById('max-tokens').value = settings.max_tokens_before_compact || 8000;
    await loadApiConfigs();

    // Restore TTS settings from localStorage
    const ttsVoiceEl = document.getElementById('tts-voice');
    const ttsSpeedEl = document.getElementById('tts-speed');
    const ttsSpeedValueEl = document.getElementById('tts-speed-value');

    if (ttsVoiceEl) ttsVoiceEl.value = ttsManager.voice;
    if (ttsSpeedEl) ttsSpeedEl.value = ttsManager.speed;
    if (ttsSpeedValueEl) ttsSpeedValueEl.textContent = ttsManager.speed + 'x';

    await loadGMSessionDropdown();
    await loadSummarySessionDropdown();
  } catch (error) {
    console.error('Failed to load settings:', error);
  }
}

export async function saveSettings() {
  const settings = {
    max_tokens_before_compact: document.getElementById('max-tokens').value
  };

  try {
    await api('/api/settings', 'POST', settings);
    document.getElementById('settings-status').textContent = 'Settings saved successfully!';
    setTimeout(() => { document.getElementById('settings-status').textContent = ''; }, 3000);
  } catch (error) {
    document.getElementById('settings-status').textContent = 'Failed to save settings';
  }
}

// ============================================
// API Configurations
// ============================================

export async function loadApiConfigs() {
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

export async function addApiConfig() {
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

    document.getElementById('new-config-name').value = '';
    document.getElementById('new-config-endpoint').value = '';
    document.getElementById('new-config-key').value = '';
    document.getElementById('new-config-model').value = '';
    document.getElementById('new-config-active').checked = false;

    await loadApiConfigs();
    setTimeout(() => { statusEl.textContent = ''; }, 3000);
  } catch (error) {
    statusEl.textContent = error.message || 'Failed to add configuration';
    statusEl.className = 'error';
  }
}

export async function testNewConfig() {
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

export async function activateApiConfig(id) {
  try {
    await api(`/api/api-configs/${id}/activate`, 'POST');
    await loadApiConfigs();
  } catch (error) {
    alert('Failed to activate configuration: ' + error.message);
  }
}

export async function testApiConfig(id) {
  const card = document.querySelector(`.api-config-card[data-id="${id}"]`);
  const btn = card.querySelector('.btn-test-config');
  const originalText = btn.textContent;
  btn.textContent = 'Testing...';
  btn.disabled = true;

  try {
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

export async function deleteApiConfig(id) {
  if (!confirm('Are you sure you want to delete this API configuration?')) return;
  try {
    await api(`/api/api-configs/${id}`, 'DELETE');
    await loadApiConfigs();
  } catch (error) {
    alert('Failed to delete configuration: ' + error.message);
  }
}

export async function testConnection() {
  const activeCard = document.querySelector('.api-config-card.active');
  if (activeCard) {
    const id = activeCard.dataset.id;
    await testApiConfig(id);
  } else {
    alert('No active API configuration. Please add and activate one first.');
  }
}

// ============================================
// GM Mode
// ============================================

export async function loadGMSessionDropdown() {
  try {
    const sessions = await api('/api/sessions');
    const sessionOptions = '<option value="">-- Select a session --</option>' +
      sessions.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');

    const gmSelect = document.getElementById('gm-session-select');
    if (gmSelect) {
      gmSelect.innerHTML = sessionOptions;
      document.getElementById('gm-session-info').style.display = 'none';
    }

    const autoReplySelect = document.getElementById('autoreply-session-select');
    if (autoReplySelect) autoReplySelect.innerHTML = sessionOptions;

    const summarySelect = document.getElementById('summary-session-select');
    if (summarySelect) summarySelect.innerHTML = sessionOptions;
  } catch (error) {
    console.error('Failed to load sessions for settings dropdowns:', error);
  }
}

export async function loadGMSessionInfo() {
  const sessionId = document.getElementById('gm-session-select').value;
  const infoDiv = document.getElementById('gm-session-info');

  if (!sessionId) { infoDiv.style.display = 'none'; return; }

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

export async function sendGMMessage() {
  const sessionId = document.getElementById('gm-session-select').value;
  const message = document.getElementById('gm-message-input').value.trim();
  const statusEl = document.getElementById('gm-status');
  const sendBtn = document.getElementById('gm-send-btn');

  if (!sessionId) { statusEl.textContent = 'Please select a session first.'; statusEl.style.color = 'var(--danger)'; return; }
  if (!message) { statusEl.textContent = 'Please enter a message.'; statusEl.style.color = 'var(--danger)'; return; }

  sendBtn.disabled = true;
  sendBtn.textContent = 'Sending...';
  statusEl.textContent = '';

  try {
    const result = await api(`/api/sessions/${sessionId}/gm-message`, 'POST', { message });
    statusEl.textContent = result.message || 'GM message sent! It will influence the next AI response.';
    statusEl.style.color = 'var(--success)';
    document.getElementById('gm-message-input').value = '';
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
// Summary Management
// ============================================

export async function loadSummarySessionDropdown() {
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

export async function loadSessionSummary() {
  const sessionId = document.getElementById('summary-session-select').value;
  const infoDiv = document.getElementById('summary-info');
  const textarea = document.getElementById('summary-textarea');
  const statusEl = document.getElementById('summary-status');

  if (!sessionId) { infoDiv.style.display = 'none'; textarea.value = ''; return; }

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

export async function saveSummary() {
  const sessionId = document.getElementById('summary-session-select').value;
  const summary = document.getElementById('summary-textarea').value;
  const statusEl = document.getElementById('summary-status');

  if (!sessionId) { statusEl.textContent = 'Please select a session first.'; statusEl.style.color = 'var(--danger)'; return; }

  try {
    await api(`/api/sessions/${sessionId}/summary`, 'POST', { summary });
    statusEl.textContent = 'Summary saved successfully!';
    statusEl.style.color = 'var(--success)';
  } catch (error) {
    statusEl.textContent = 'Error saving summary: ' + error.message;
    statusEl.style.color = 'var(--danger)';
  }
}

export async function forceCompact() {
  const sessionId = document.getElementById('summary-session-select').value;
  const statusEl = document.getElementById('summary-status');
  const btn = document.getElementById('force-compact-btn');

  if (!sessionId) { statusEl.textContent = 'Please select a session first.'; statusEl.style.color = 'var(--danger)'; return; }

  btn.disabled = true;
  btn.textContent = 'Compacting...';
  statusEl.textContent = 'Generating summary from recent messages...';
  statusEl.style.color = 'var(--text-muted)';

  try {
    const result = await api(`/api/sessions/${sessionId}/force-compact`, 'POST');
    statusEl.textContent = result.message;
    statusEl.style.color = 'var(--success)';
    await loadSessionSummary();
  } catch (error) {
    statusEl.textContent = 'Error: ' + error.message;
    statusEl.style.color = 'var(--danger)';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Force Compact Now';
  }
}

// ============================================
// AI Auto-Reply
// ============================================

export async function loadAutoReplyCharacters() {
  const sessionId = document.getElementById('autoreply-session-select').value;
  const charSelect = document.getElementById('autoreply-character-select');
  const statusEl = document.getElementById('autoreply-status');

  saveAppState();

  if (!sessionId) {
    charSelect.innerHTML = '<option value="">-- Select a session first --</option>';
    charSelect.disabled = true;
    return;
  }

  try {
    const data = await api(`/api/sessions/${sessionId}`);
    const chars = data.sessionCharacters || [];

    if (chars.length === 0) {
      charSelect.innerHTML = '<option value="">No characters in this session</option>';
      charSelect.disabled = true;
      return;
    }

    charSelect.innerHTML = '<option value="">-- Select a character --</option>' +
      chars.map(c => `<option value="${c.id}">${escapeHtml(c.character_name)} (${escapeHtml(c.race)} ${escapeHtml(c.class)})</option>`).join('');
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

export function onAutoReplyCharacterChange() {
  saveAppState();
}

export async function generateAutoReply() {
  const sessionId = document.getElementById('autoreply-session-select').value;
  const characterId = document.getElementById('autoreply-character-select').value;
  const context = document.getElementById('autoreply-context').value.trim();
  const statusEl = document.getElementById('autoreply-status');
  const btn = document.getElementById('autoreply-btn');

  if (!sessionId) { statusEl.textContent = 'Please select a session first.'; statusEl.style.color = 'var(--danger)'; return; }
  if (!characterId) { statusEl.textContent = 'Please select a character.'; statusEl.style.color = 'var(--danger)'; return; }

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
