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

let roleAssignments = {
  narrator_api_config_id: '',
  agent_api_config_id: '',
  pov_api_config_id: ''
};

// ============================================
// Load settings
// ============================================

export async function loadSettings() {
  try {
    const settings = await api('/api/settings');
    document.getElementById('max-tokens').value = settings.max_tokens_before_compact || 8000;
    document.getElementById('youtube-dj-enabled').checked = settings.youtube_dj_enabled === 'true';
    document.getElementById('youtube-dj-status').textContent = settings.youtube_configured
      ? 'YouTube API key saved. Leave the field blank to keep it.'
      : 'Add a YouTube Data API v3 key to enable playback.';
    document.getElementById('pov-image-enabled').checked = settings.pov_image_enabled === 'true';
    document.getElementById('pov-image-auto-enabled').checked = settings.pov_image_auto_enabled === 'true';
    document.getElementById('pov-image-provider').value = settings.pov_image_provider || 'openai';
    document.getElementById('pov-image-endpoint').value = settings.pov_image_endpoint || 'https://api.openai.com/v1';
    document.getElementById('pov-image-model').value = settings.pov_image_model || 'gpt-image-1';
    document.getElementById('pov-image-style-prompt').value = settings.pov_image_style_prompt || '';
    document.getElementById('pov-image-status').textContent = settings.pov_image_configured
      ? 'Image API key saved. Leave the field blank to keep it.'
      : 'Add an image API key, endpoint, and model to enable illustrations.';
    roleAssignments = {
      narrator_api_config_id: settings.narrator_api_config_id || '',
      agent_api_config_id: settings.agent_api_config_id || '',
      pov_api_config_id: settings.pov_api_config_id || ''
    };
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
    max_tokens_before_compact: document.getElementById('max-tokens').value,
    narrator_api_config_id: document.getElementById('narrator-api-config').value,
    agent_api_config_id: document.getElementById('agent-api-config').value,
    pov_api_config_id: document.getElementById('pov-api-config').value,
    youtube_dj_enabled: document.getElementById('youtube-dj-enabled').checked,
    youtube_api_key: document.getElementById('youtube-api-key').value,
    pov_image_enabled: document.getElementById('pov-image-enabled').checked,
    pov_image_auto_enabled: document.getElementById('pov-image-auto-enabled').checked,
    pov_image_provider: document.getElementById('pov-image-provider').value,
    pov_image_endpoint: document.getElementById('pov-image-endpoint').value,
    pov_image_api_key: document.getElementById('pov-image-api-key').value,
    pov_image_model: document.getElementById('pov-image-model').value,
    pov_image_style_prompt: document.getElementById('pov-image-style-prompt').value
  };

  try {
    await api('/api/settings', 'POST', settings);
    roleAssignments.narrator_api_config_id = settings.narrator_api_config_id;
    roleAssignments.agent_api_config_id = settings.agent_api_config_id;
    roleAssignments.pov_api_config_id = settings.pov_api_config_id;
    document.getElementById('youtube-api-key').value = '';
    document.getElementById('pov-image-api-key').value = '';
    await loadApiConfigs();
    document.getElementById('settings-status').textContent = 'Settings saved successfully!';
    setTimeout(() => { document.getElementById('settings-status').textContent = ''; }, 3000);
  } catch (error) {
    document.getElementById('settings-status').textContent = 'Failed to save settings';
  }
}

export async function cleanupPOVImages() {
  if (!confirm('Remove older POV images while keeping the latest 3 illustrated turns in each campaign?')) return;
  const button = document.getElementById('pov-image-cleanup-btn');
  const status = document.getElementById('pov-image-status');
  if (button) {
    button.disabled = true;
    button.textContent = 'Cleaning...';
  }
  try {
    const result = await api('/api/settings/pov-images/cleanup', 'POST');
    if (status) {
      status.textContent = `Cleanup complete: removed ${result.removedImages} saved scenes and ${result.removedFiles} files; kept ${result.keptImages} recent scenes.`;
    }
  } catch (error) {
    if (status) status.textContent = error.message || 'Image cleanup failed.';
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = 'Clear older saved images';
    }
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
      renderRoleSelectors([]);
      return;
    }

    listEl.innerHTML = configs.map(config => `
      <div class="api-config-card ${config.is_active ? 'active-config' : ''}" data-id="${config.id}"
           data-name="${escapeHtml(config.name)}"
           data-endpoint="${escapeHtml(config.endpoint)}"
           data-model="${escapeHtml(config.model)}"
           data-reasoning-effort="${escapeHtml(config.reasoning_effort || '')}">
        <div class="config-header">
          <span class="config-name">${escapeHtml(config.name)}${renderRoleBadges(config.id)}</span>
        </div>
        <div class="config-details">
          <span><span class="label">Endpoint:</span> <span class="value">${escapeHtml(config.endpoint)}</span></span>
          <span><span class="label">Model:</span> <span class="value">${escapeHtml(config.model)}</span></span>
          <span><span class="label">Reasoning:</span> <span class="value">${escapeHtml(config.reasoning_effort || 'Provider default')}</span></span>
          <span><span class="label">API Key:</span> <span class="value">${escapeHtml(config.api_key)}</span></span>
        </div>
        <div class="config-actions">
          <button class="btn-activate" onclick="activateApiConfig('${config.id}')">${config.is_active ? 'Active' : 'Activate'}</button>
          <button class="btn-edit" onclick="editApiConfig('${config.id}')">Edit</button>
          <button class="btn-test-config" onclick="testApiConfig('${config.id}')">Test</button>
          <button class="btn-delete" onclick="deleteApiConfig('${config.id}')">Delete</button>
        </div>
      </div>
    `).join('');
    renderRoleSelectors(configs);
  } catch (error) {
    console.error('Failed to load API configs:', error);
  }
}

function renderRoleBadges(configId) {
  const badges = [];
  if (roleAssignments.narrator_api_config_id === configId) badges.push('Narrator');
  if (roleAssignments.agent_api_config_id === configId) badges.push('Agent');
  if (roleAssignments.pov_api_config_id === configId) badges.push('POV');
  return badges.map(role => ` <span class="config-role-badge">${role}</span>`).join('');
}

function renderRoleSelectors(configs) {
  const options = '<option value="">Use active configuration (fallback)</option>' + configs.map(config =>
    `<option value="${escapeHtml(config.id)}">${escapeHtml(config.name)} - ${escapeHtml(config.model)}</option>`
  ).join('');
  const narratorSelect = document.getElementById('narrator-api-config');
  const agentSelect = document.getElementById('agent-api-config');
  const povSelect = document.getElementById('pov-api-config');
  if (narratorSelect) {
    narratorSelect.innerHTML = options;
    narratorSelect.value = configs.some(config => config.id === roleAssignments.narrator_api_config_id)
      ? roleAssignments.narrator_api_config_id : '';
  }
  if (agentSelect) {
    agentSelect.innerHTML = options;
    agentSelect.value = configs.some(config => config.id === roleAssignments.agent_api_config_id)
      ? roleAssignments.agent_api_config_id : '';
  }
  if (povSelect) {
    povSelect.innerHTML = options;
    povSelect.value = configs.some(config => config.id === roleAssignments.pov_api_config_id)
      ? roleAssignments.pov_api_config_id : '';
  }
}

export async function addApiConfig() {
  const name = document.getElementById('new-config-name').value.trim();
  const endpoint = document.getElementById('new-config-endpoint').value.trim();
  const api_key = document.getElementById('new-config-key').value.trim();
  const model = document.getElementById('new-config-model').value.trim();
  const reasoning_effort = document.getElementById('new-config-reasoning-effort').value;
  const is_active = document.getElementById('new-config-active').checked;
  const statusEl = document.getElementById('new-config-status');

  if (!name || !endpoint || !api_key || !model) {
    statusEl.textContent = 'All fields are required';
    statusEl.className = 'error';
    return;
  }

  try {
    await api('/api/api-configs', 'POST', { name, endpoint, api_key, model, reasoning_effort, is_active });
    statusEl.textContent = 'Configuration added successfully!';
    statusEl.className = 'success';

    document.getElementById('new-config-name').value = '';
    document.getElementById('new-config-endpoint').value = '';
    document.getElementById('new-config-key').value = '';
    document.getElementById('new-config-model').value = '';
    document.getElementById('new-config-reasoning-effort').value = '';
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
    api_model: document.getElementById('new-config-model').value.trim(),
    reasoning_effort: document.getElementById('new-config-reasoning-effort').value
  };

  if (!testData.api_endpoint || !testData.api_key || !testData.api_model) {
    statusEl.textContent = 'Please fill in endpoint, API key, and model';
    statusEl.className = 'error';
    return;
  }

  try {
    const result = await api('/api/api-configs/test-connection', 'POST', testData);
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
    const result = await api(`/api/api-configs/test-connection/${id}`, 'POST');
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
  const activeCard = document.querySelector('.api-config-card.active-config');
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
