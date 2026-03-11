// ============================================
// API Config Edit Modal
// ============================================

import { getState, setState } from '../../state.js';
import { api } from '../../api.js';
import { escapeHtml } from '../../utils/formatters.js';
import { loadApiConfigs } from '../settings.js';

export function editApiConfig(id) {
  const card = document.querySelector(`.api-config-card[data-id="${id}"]`);
  if (!card) return;

  setState({ editingConfigId: id });

  const name = card.dataset.name;
  const endpoint = card.dataset.endpoint;
  const model = card.dataset.model;

  const modal = document.getElementById('api-edit-modal');
  document.getElementById('edit-config-name').value = name;
  document.getElementById('edit-config-endpoint').value = endpoint;
  document.getElementById('edit-config-model').value = model;
  document.getElementById('edit-config-key').value = '';
  document.getElementById('edit-config-key').placeholder = 'Leave blank to keep current key';
  document.getElementById('edit-config-status').textContent = '';

  modal.classList.add('active');
}

export function closeApiEditModal() {
  const modal = document.getElementById('api-edit-modal');
  modal.classList.remove('active');
  setState({ editingConfigId: null });
}

export async function saveApiConfigEdit() {
  const editingConfigId = getState('editingConfigId');
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
  if (api_key) updateData.api_key = api_key;

  try {
    await api(`/api/api-configs/${editingConfigId}`, 'PUT', updateData);
    statusEl.textContent = 'Configuration updated!';
    statusEl.className = 'success';

    await loadApiConfigs();
    setTimeout(() => { closeApiEditModal(); }, 1000);
  } catch (error) {
    statusEl.textContent = error.message || 'Failed to update configuration';
    statusEl.className = 'error';
  }
}
