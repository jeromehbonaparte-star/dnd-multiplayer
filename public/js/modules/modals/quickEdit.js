// ============================================
// Quick Edit Modal (direct field editing)
// ============================================

import { getState, setState } from '../../state.js';
import { api } from '../../api.js';
import { showNotification } from '../../utils/dom.js';
import { loadCharacters } from '../characters.js';
import { refreshSessionCharacters } from '../sessions.js';

export function showQuickEditSection(sectionName) {
  document.querySelectorAll('.quick-edit-section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.quick-edit-tab').forEach(t => t.classList.remove('active'));

  document.getElementById(`quick-edit-${sectionName}`).classList.add('active');
  // Use window.event (available in inline onclick handlers) to highlight the clicked tab
  if (window.event && window.event.target) {
    window.event.target.classList.add('active');
  }
}

export function openQuickEditModal(charId) {
  const characters = getState('characters');
  const char = characters.find(c => c.id === charId);
  if (!char) return;

  setState({ quickEditCharId: charId });

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

export function closeQuickEditModal() {
  document.getElementById('quick-edit-modal').classList.remove('active');
  setState({ quickEditCharId: null });
}

export async function saveQuickEdit() {
  const quickEditCharId = getState('quickEditCharId');
  if (!quickEditCharId) return;

  const data = {
    player_name: document.getElementById('quick-edit-player-name').value,
    character_name: document.getElementById('quick-edit-character-name').value,
    race: document.getElementById('quick-edit-race').value,
    class: document.getElementById('quick-edit-class').value,
    level: parseInt(document.getElementById('quick-edit-level').value) || 1,
    xp: parseInt(document.getElementById('quick-edit-xp').value) || 0,
    gold: parseInt(document.getElementById('quick-edit-gold').value) || 0,
    background: document.getElementById('quick-edit-background').value,
    strength: parseInt(document.getElementById('quick-edit-strength').value) || 10,
    dexterity: parseInt(document.getElementById('quick-edit-dexterity').value) || 10,
    constitution: parseInt(document.getElementById('quick-edit-constitution').value) || 10,
    intelligence: parseInt(document.getElementById('quick-edit-intelligence').value) || 10,
    wisdom: parseInt(document.getElementById('quick-edit-wisdom').value) || 10,
    charisma: parseInt(document.getElementById('quick-edit-charisma').value) || 10,
    hp: parseInt(document.getElementById('quick-edit-hp').value) || 10,
    max_hp: parseInt(document.getElementById('quick-edit-max-hp').value) || 10,
    ac: parseInt(document.getElementById('quick-edit-ac').value) || 10,
    spell_slots: document.getElementById('quick-edit-spell-slots').value,
    spells: document.getElementById('quick-edit-spells').value,
    skills: document.getElementById('quick-edit-skills').value,
    class_features: document.getElementById('quick-edit-class-features').value,
    passives: document.getElementById('quick-edit-passives').value,
    feats: document.getElementById('quick-edit-feats').value,
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
