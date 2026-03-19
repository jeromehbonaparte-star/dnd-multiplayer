// ============================================
// Spell Slots & AC Modal
// ============================================

import { getState, setState } from '../../state.js';
import { api } from '../../api.js';
import { escapeHtml } from '../../utils/formatters.js';
import { showNotification } from '../../utils/dom.js';
import { loadCharacters, parseAcEffects } from '../characters.js';

export function openSpellSlotsModal(charId) {
  setState({ spellSlotsModalCharId: charId });
  const characters = getState('characters');
  const char = characters.find(c => c.id === charId);
  if (!char) return;

  document.getElementById('spell-slots-modal-title').textContent = `${char.character_name}'s Spell Slots & AC`;

  const acEffects = parseAcEffects(char.ac_effects);
  document.getElementById('ac-base-source').value = acEffects.base_source || 'Unarmored';
  document.getElementById('ac-base-value').value = acEffects.base_value || 10;
  document.getElementById('ac-total-value').textContent = char.ac || 10;

  renderAcEffectsList(char);
  renderSpellSlotsList(char);

  document.getElementById('spell-slots-modal').classList.add('active');
}

export function closeSpellSlotsModal() {
  document.getElementById('spell-slots-modal').classList.remove('active');
  setState({ spellSlotsModalCharId: null });
}

// ============================================
// AC Effects
// ============================================

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

  document.getElementById('ac-total-value').textContent = char.ac || 10;
}

export async function updateAcBase() {
  const spellSlotsModalCharId = getState('spellSlotsModalCharId');
  if (!spellSlotsModalCharId) return;

  const baseSource = document.getElementById('ac-base-source').value.trim() || 'Unarmored';
  const baseValue = parseInt(document.getElementById('ac-base-value').value) || 10;

  try {
    const result = await api(`/api/characters/${spellSlotsModalCharId}/ac`, 'POST', {
      action: 'set_base',
      base_source: baseSource,
      base_value: baseValue
    });

    const characters = [...getState('characters')];
    const charIdx = characters.findIndex(c => c.id === spellSlotsModalCharId);
    if (charIdx !== -1) {
      characters[charIdx] = result.character;
      setState({ characters });
      renderAcEffectsList(result.character);
    }
    loadCharacters();
    showNotification('Base AC updated');
  } catch (error) {
    alert('Failed to update AC: ' + error.message);
  }
}

export async function addAcEffect() {
  const spellSlotsModalCharId = getState('spellSlotsModalCharId');
  if (!spellSlotsModalCharId) return;

  const name = document.getElementById('new-effect-name').value.trim();
  const value = parseInt(document.getElementById('new-effect-value').value) || 0;
  const type = document.getElementById('new-effect-type').value;
  const temporary = document.getElementById('new-effect-temp').checked;

  if (!name) { alert('Please enter an effect name'); return; }

  try {
    const result = await api(`/api/characters/${spellSlotsModalCharId}/ac`, 'POST', {
      action: 'add_effect',
      effect: { name, value, type, temporary }
    });

    const characters = [...getState('characters')];
    const charIdx = characters.findIndex(c => c.id === spellSlotsModalCharId);
    if (charIdx !== -1) {
      characters[charIdx] = result.character;
      setState({ characters });
      renderAcEffectsList(result.character);
    }

    document.getElementById('new-effect-name').value = '';
    document.getElementById('new-effect-value').value = '2';
    document.getElementById('new-effect-temp').checked = false;

    loadCharacters();
    showNotification('AC effect added');
  } catch (error) {
    alert('Failed to add AC effect: ' + error.message);
  }
}

export async function removeAcEffect(effectId) {
  const spellSlotsModalCharId = getState('spellSlotsModalCharId');
  if (!spellSlotsModalCharId) return;

  try {
    const result = await api(`/api/characters/${spellSlotsModalCharId}/ac`, 'POST', {
      action: 'remove_effect',
      effect: { id: effectId }
    });

    const characters = [...getState('characters')];
    const charIdx = characters.findIndex(c => c.id === spellSlotsModalCharId);
    if (charIdx !== -1) {
      characters[charIdx] = result.character;
      setState({ characters });
      renderAcEffectsList(result.character);
    }
    loadCharacters();
    showNotification('AC effect removed');
  } catch (error) {
    alert('Failed to remove AC effect: ' + error.message);
  }
}

export async function clearTempAcEffects() {
  const spellSlotsModalCharId = getState('spellSlotsModalCharId');
  if (!spellSlotsModalCharId) return;

  try {
    const result = await api(`/api/characters/${spellSlotsModalCharId}/ac`, 'POST', {
      action: 'clear_temporary'
    });

    const characters = [...getState('characters')];
    const charIdx = characters.findIndex(c => c.id === spellSlotsModalCharId);
    if (charIdx !== -1) {
      characters[charIdx] = result.character;
      setState({ characters });
      renderAcEffectsList(result.character);
    }
    loadCharacters();
    showNotification('Temporary AC effects cleared');
  } catch (error) {
    alert('Failed to clear temporary effects: ' + error.message);
  }
}

// ============================================
// Spell Slots
// ============================================

function renderSpellSlotsList(char) {
  let spellSlots = {};
  try { spellSlots = JSON.parse(char.spell_slots || '{}'); } catch (e) { spellSlots = {}; }

  const listEl = document.getElementById('spell-slots-list');
  const levels = Object.keys(spellSlots).sort((a, b) => parseInt(a) - parseInt(b));

  if (levels.length === 0) {
    listEl.innerHTML = '<div class="spell-slots-empty">No spell slots configured. Add spell slot levels below.</div>';
  } else {
    listEl.innerHTML = levels.map(lvl => {
      const slot = spellSlots[lvl];
      const current = slot.current ?? slot.max ?? 0;
      const max = slot.max || 0;
      const used = max - current;
      const levelName = lvl === '1' ? '1st' : lvl === '2' ? '2nd' : lvl === '3' ? '3rd' : `${lvl}th`;
      return `
        <div class="spell-slot-row">
          <span class="slot-level">${levelName} Level</span>
          <span class="slot-count">${current} / ${max}</span>
          <button class="btn-tiny" onclick="useSpellSlot('${lvl}')" ${current <= 0 ? 'disabled' : ''}>Use</button>
          <button class="btn-tiny btn-restore" onclick="restoreSpellSlot('${lvl}')" ${used <= 0 ? 'disabled' : ''}>+1</button>
          <button class="btn-tiny btn-remove" onclick="removeSpellSlotLevel('${lvl}')">X</button>
        </div>
      `;
    }).join('');
  }
}

export async function useSpellSlot(level) {
  const spellSlotsModalCharId = getState('spellSlotsModalCharId');
  if (!spellSlotsModalCharId) return;

  try {
    const result = await api(`/api/characters/${spellSlotsModalCharId}/spell-slots`, 'POST', {
      action: 'use',
      level: level
    });

    const characters = [...getState('characters')];
    const charIdx = characters.findIndex(c => c.id === spellSlotsModalCharId);
    if (charIdx !== -1) {
      characters[charIdx] = result.character;
      setState({ characters });
      renderSpellSlotsList(result.character);
    }
    loadCharacters();
  } catch (error) {
    alert('Failed to use spell slot: ' + error.message);
  }
}

export async function restoreSpellSlot(level) {
  const spellSlotsModalCharId = getState('spellSlotsModalCharId');
  if (!spellSlotsModalCharId) return;

  try {
    const result = await api(`/api/characters/${spellSlotsModalCharId}/spell-slots`, 'POST', {
      action: 'restore',
      level: level
    });

    const characters = [...getState('characters')];
    const charIdx = characters.findIndex(c => c.id === spellSlotsModalCharId);
    if (charIdx !== -1) {
      characters[charIdx] = result.character;
      setState({ characters });
      renderSpellSlotsList(result.character);
    }
    loadCharacters();
  } catch (error) {
    alert('Failed to restore spell slot: ' + error.message);
  }
}

export async function longRest() {
  const spellSlotsModalCharId = getState('spellSlotsModalCharId');
  if (!spellSlotsModalCharId) return;

  try {
    const result = await api(`/api/characters/${spellSlotsModalCharId}/spell-slots`, 'POST', {
      action: 'rest'
    });

    const characters = [...getState('characters')];
    const charIdx = characters.findIndex(c => c.id === spellSlotsModalCharId);
    if (charIdx !== -1) {
      characters[charIdx] = result.character;
      setState({ characters });
      renderSpellSlotsList(result.character);
    }
    loadCharacters();
    showNotification('All spell slots restored!');
  } catch (error) {
    alert('Failed to restore spell slots: ' + error.message);
  }
}

export async function addSpellSlotLevel() {
  const spellSlotsModalCharId = getState('spellSlotsModalCharId');
  if (!spellSlotsModalCharId) return;

  const level = document.getElementById('new-slot-level').value;
  const maxSlots = parseInt(document.getElementById('new-slot-max').value) || 2;

  const characters = getState('characters');
  const char = characters.find(c => c.id === spellSlotsModalCharId);
  if (!char) return;

  let spellSlots = {};
  try { spellSlots = JSON.parse(char.spell_slots || '{}'); } catch (e) { spellSlots = {}; }

  spellSlots[level] = { max: maxSlots, used: 0 };

  try {
    const result = await api(`/api/characters/${spellSlotsModalCharId}/spell-slots`, 'POST', {
      action: 'set',
      slots: spellSlots
    });

    const chars = [...getState('characters')];
    const charIdx = chars.findIndex(c => c.id === spellSlotsModalCharId);
    if (charIdx !== -1) {
      chars[charIdx] = result.character;
      setState({ characters: chars });
      renderSpellSlotsList(result.character);
    }
    loadCharacters();
  } catch (error) {
    alert('Failed to add spell slot level: ' + error.message);
  }
}

export async function removeSpellSlotLevel(level) {
  const spellSlotsModalCharId = getState('spellSlotsModalCharId');
  if (!spellSlotsModalCharId) return;

  const characters = getState('characters');
  const char = characters.find(c => c.id === spellSlotsModalCharId);
  if (!char) return;

  let spellSlots = {};
  try { spellSlots = JSON.parse(char.spell_slots || '{}'); } catch (e) { spellSlots = {}; }

  delete spellSlots[level];

  try {
    const result = await api(`/api/characters/${spellSlotsModalCharId}/spell-slots`, 'POST', {
      action: 'set',
      slots: spellSlots
    });

    const chars = [...getState('characters')];
    const charIdx = chars.findIndex(c => c.id === spellSlotsModalCharId);
    if (charIdx !== -1) {
      chars[charIdx] = result.character;
      setState({ characters: chars });
      renderSpellSlotsList(result.character);
    }
    loadCharacters();
  } catch (error) {
    alert('Failed to remove spell slot level: ' + error.message);
  }
}
