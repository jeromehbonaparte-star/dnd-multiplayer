// ============================================
// Inventory Modal
// ============================================

import { getState, setState } from '../../state.js';
import { api } from '../../api.js';
import { escapeHtml } from '../../utils/formatters.js';
import { showNotification } from '../../utils/dom.js';
import { loadCharacters } from '../characters.js';
import { getCachedInventory, invalidateInventoryCache } from '../../utils/inventoryCache.js';

// Re-export for any existing consumers
export { getCachedInventory, invalidateInventoryCache };

export function openInventoryModal(charId) {
  setState({ inventoryModalCharId: charId });
  const characters = getState('characters');
  const char = characters.find(c => c.id === charId);
  if (!char) return;

  document.getElementById('inventory-modal-title').textContent = `${char.character_name}'s Inventory`;
  document.getElementById('inventory-gold-input').value = char.gold || 0;

  renderInventoryModalList(char);
  document.getElementById('inventory-modal').classList.add('active');
}

export function closeInventoryModal() {
  document.getElementById('inventory-modal').classList.remove('active');
  setState({ inventoryModalCharId: null });
}

function renderInventoryModalList(char) {
  const inventory = getCachedInventory(char.id, char.inventory);

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

export async function updateGold() {
  const inventoryModalCharId = getState('inventoryModalCharId');
  if (!inventoryModalCharId) return;

  const characters = getState('characters');
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

export async function addItemToInventory() {
  const inventoryModalCharId = getState('inventoryModalCharId');
  if (!inventoryModalCharId) return;

  const itemName = document.getElementById('new-item-name').value.trim();
  const quantity = parseInt(document.getElementById('new-item-qty').value) || 1;

  if (!itemName) { alert('Please enter an item name'); return; }

  try {
    const result = await api(`/api/characters/${inventoryModalCharId}/inventory`, 'POST', {
      action: 'add',
      item: itemName,
      quantity: quantity
    });

    document.getElementById('new-item-name').value = '';
    document.getElementById('new-item-qty').value = '1';

    // Server returns character object directly (not nested under .character)
    const characters = [...getState('characters')];
    const charIdx = characters.findIndex(c => c.id === inventoryModalCharId);
    if (charIdx !== -1) {
      characters[charIdx] = result;
      setState({ characters });
      renderInventoryModalList(result);
    }
    loadCharacters();
  } catch (error) {
    alert('Failed to add item: ' + error.message);
  }
}

export async function removeItemFromInventory(itemName) {
  const inventoryModalCharId = getState('inventoryModalCharId');
  if (!inventoryModalCharId) return;

  try {
    const result = await api(`/api/characters/${inventoryModalCharId}/inventory`, 'POST', {
      action: 'remove',
      item: itemName,
      quantity: 1
    });

    // Server returns character object directly (not nested under .character)
    const characters = [...getState('characters')];
    const charIdx = characters.findIndex(c => c.id === inventoryModalCharId);
    if (charIdx !== -1) {
      characters[charIdx] = result;
      setState({ characters });
      renderInventoryModalList(result);
    }
    loadCharacters();
  } catch (error) {
    alert('Failed to remove item: ' + error.message);
  }
}
