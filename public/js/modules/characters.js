// ============================================
// Characters Module
// - Character list, cards, section toggles
// - Character creation (AI-guided)
// ============================================

import { getState, setState } from '../state.js';
import { api } from '../api.js';
import { escapeHtml, formatChatMessage } from '../utils/formatters.js';
import { getRequiredXP, canLevelUp } from '../utils/gameRules.js';
import { showNotification, scrollChatToBottom } from '../utils/dom.js';
import { saveAppState } from './auth.js';
import { getCachedInventory } from '../utils/inventoryCache.js';

// ============================================
// Available sections for expand/collapse
// ============================================
const CHARACTER_SECTIONS = [
  'appearance', 'backstory', 'spellSlots', 'skills',
  'spells', 'passives', 'classFeatures', 'feats', 'inventory'
];

// ============================================
// Section expand/collapse state management
// ============================================

export function loadSectionStates() {
  try {
    const saved = localStorage.getItem('dnd-section-states');
    if (saved) {
      setState({ sectionExpandedStates: JSON.parse(saved) });
    }
  } catch (e) { /* ignore */ }
}

function saveSectionStates() {
  try {
    localStorage.setItem('dnd-section-states', JSON.stringify(getState('sectionExpandedStates')));
  } catch (e) { /* ignore */ }
}

export function getSectionState(charId, section) {
  const states = getState('sectionExpandedStates');
  if (!states[charId]) {
    states[charId] = {};
    setState({ sectionExpandedStates: states });
  }
  return states[charId][section] || false;
}

export function toggleSection(charId, section) {
  console.log('toggleSection called:', { charId, section });

  const states = getState('sectionExpandedStates');
  if (!states[charId]) states[charId] = {};
  states[charId][section] = !getSectionState(charId, section);
  setState({ sectionExpandedStates: states });
  saveSectionStates();

  // Update ALL matching sections visually
  const selector = `.section-collapsible[data-char="${charId}"][data-section="${section}"]`;
  const sectionEls = document.querySelectorAll(selector);
  console.log('Found elements:', sectionEls.length);

  sectionEls.forEach(sectionEl => {
    sectionEl.classList.toggle('expanded', states[charId][section]);
    const icon = sectionEl.querySelector('.section-toggle-icon');
    if (icon) {
      icon.textContent = states[charId][section] ? '\u25BC' : '\u25B6';
    }
  });

  console.log('Section toggled, expanded:', states[charId][section]);
}

export function expandAllSections(charId) {
  const states = getState('sectionExpandedStates');
  if (!states[charId]) states[charId] = {};
  CHARACTER_SECTIONS.forEach(s => { states[charId][s] = true; });
  setState({ sectionExpandedStates: states });
  saveSectionStates();
  renderCharactersList();
  updatePartyList();
}

export function collapseAllSections(charId) {
  const states = getState('sectionExpandedStates');
  if (!states[charId]) states[charId] = {};
  CHARACTER_SECTIONS.forEach(s => { states[charId][s] = false; });
  setState({ sectionExpandedStates: states });
  saveSectionStates();
  renderCharactersList();
  updatePartyList();
}

// Use event delegation for section toggle - attach once to document
export function attachSectionToggleListeners() {
  if (getState('sectionToggleListenerAttached')) return;
  setState({ sectionToggleListenerAttached: true });

  document.addEventListener('click', function(e) {
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

// Legacy function kept for compatibility
function handleSectionToggleClick(e) {
  e.stopPropagation();
  const charId = e.currentTarget.dataset.toggleChar;
  const section = e.currentTarget.dataset.toggleSection;
  if (charId && section) {
    toggleSection(charId, section);
  }
}

// ============================================
// Spell slots formatting
// ============================================

export function formatSpellSlots(spellSlots) {
  const levels = Object.keys(spellSlots).sort((a, b) => parseInt(a) - parseInt(b));
  if (levels.length === 0) return '';

  return '<strong>Spell Slots:</strong> ' + levels.map(lvl => {
    const slot = spellSlots[lvl];
    const available = (slot.max || 0) - (slot.used || 0);
    return `${lvl}st: ${available}/${slot.max || 0}`;
  }).join(' | ').replace(/1st/g, '1st').replace(/2st/g, '2nd').replace(/3st/g, '3rd');
}

export function formatSpellSlotsShort(spellSlots) {
  const levels = Object.keys(spellSlots).sort((a, b) => parseInt(a) - parseInt(b));
  if (levels.length === 0) return '';

  return 'Slots: ' + levels.map(lvl => {
    const slot = spellSlots[lvl];
    const available = (slot.max || 0) - (slot.used || 0);
    return `L${lvl}:${available}/${slot.max || 0}`;
  }).join(' ');
}

// ============================================
// AC effects parsing & formatting
// ============================================

export function parseAcEffects(acEffectsJson) {
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

export function formatAcDisplay(character) {
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

export function formatAcShort(character) {
  const acEffects = parseAcEffects(character.ac_effects);
  const totalAc = character.ac || (acEffects.base_value + acEffects.effects.reduce((sum, e) => sum + (e.value || 0), 0));
  const hasEffects = acEffects.effects.length > 0;

  let title = `${acEffects.base_source}: ${acEffects.base_value}`;
  if (hasEffects) {
    title += '\n' + acEffects.effects.map(e => `${e.name}: +${e.value} (${e.type})`).join('\n');
  }

  return `<span class="ac-info${hasEffects ? ' has-effects' : ''}" title="${escapeHtml(title)}">AC: ${totalAc}${hasEffects ? '*' : ''}</span>`;
}

// ============================================
// Load & render characters
// ============================================

export async function loadCharacters() {
  try {
    const chars = await api('/api/characters');
    setState({ characters: chars });
    renderCharactersList();
    updateCharacterSelect();
    updatePartyList();
  } catch (error) {
    console.error('Failed to load characters:', error);
  }
}

export function renderCharactersList() {
  const characters = getState('characters');
  const grid = document.getElementById('characters-grid');
  if (!grid) return;

  grid.innerHTML = characters.map(c => {
    const xp = c.xp || 0;
    const requiredXP = getRequiredXP(c.level);
    const xpPercent = Math.min((xp / requiredXP) * 100, 100);
    const canLevel = canLevelUp(xp, c.level);
    const gold = c.gold || 0;
    const inventory = getCachedInventory(c.id, c.inventory);
    const itemCount = inventory.reduce((sum, item) => sum + (item.quantity || 1), 0);

    // Parse spell slots
    let spellSlots = {};
    try { spellSlots = JSON.parse(c.spell_slots || '{}'); } catch (e) { spellSlots = {}; }
    const spellSlotsDisplay = formatSpellSlots(spellSlots);
    const hasSpellSlots = Object.keys(spellSlots).length > 0;

    // Parse multiclass
    let classDisplay = `${c.class} (Level ${c.level})`;
    try {
      const classes = JSON.parse(c.classes || '{}');
      if (Object.keys(classes).length > 0) {
        classDisplay = Object.entries(classes).map(([cls, lvl]) => `${cls} ${lvl}`).join(' / ');
      }
    } catch (e) { /* ignore */ }

    const feats = c.feats || '';
    const acDisplay = formatAcDisplay(c);

    const createSection = (sectionId, label, content, colorClass, isHtml = false) => {
      if (!content) return '';
      const isExpanded = getSectionState(c.id, sectionId);
      const safeContent = isHtml ? content : escapeHtml(content).replace(/\n/g, '<br>');
      return `
        <div class="section-collapsible ${colorClass} ${isExpanded ? 'expanded' : ''}" data-char="${c.id}" data-section="${sectionId}">
          <div class="section-header" onclick="event.stopPropagation(); toggleSection('${c.id}', '${sectionId}')">
            <span class="section-toggle-icon">${isExpanded ? '\u25BC' : '\u25B6'}</span>
            <strong>${escapeHtml(label)}</strong>
          </div>
          <div class="section-content">${safeContent}</div>
        </div>
      `;
    };

    return `
    <div class="character-card ${canLevel ? 'ready-to-level' : ''}" data-id="${c.id}">
      <button class="delete-btn" onclick="event.stopPropagation(); deleteCharacter('${c.id}')">X</button>

      <div class="card-header">
        <div class="card-header-main">
          ${c.image_url ? `<img src="${escapeHtml(c.image_url)}" class="char-avatar" alt="${escapeHtml(c.character_name)}">` : `<div class="char-avatar-placeholder"></div>`}
          <div>
            <h3>${escapeHtml(c.character_name)}</h3>
            <div class="player">Played by ${escapeHtml(c.player_name)}</div>
          </div>
        </div>
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

  attachSectionToggleListeners();
}

export function updateCharacterSelect() {
  const sessionCharacters = getState('sessionCharacters');
  const select = document.getElementById('action-character');
  if (!select) return;

  // Remember current selection (from element or localStorage)
  const savedId = select.value || localStorage.getItem('dnd-selected-character');

  select.innerHTML = '<option value="">Select your character</option>' +
    sessionCharacters.map(c => `<option value="${c.id}">${escapeHtml(c.character_name)} (${escapeHtml(c.player_name)})</option>`).join('');

  // Restore selection if the character is still in this session
  if (savedId && sessionCharacters.some(c => c.id === savedId)) {
    select.value = savedId;
  }
}

export function updatePartyList() {
  const characters = getState('characters');
  const sessionCharacters = getState('sessionCharacters');
  const currentSession = getState('currentSession');

  const list = document.getElementById('party-list');
  if (!list) return;

  const partyChars = currentSession && sessionCharacters.length > 0 ? sessionCharacters : characters;
  list.innerHTML = partyChars.map(c => {
    const xp = c.xp || 0;
    const requiredXP = getRequiredXP(c.level);
    const gold = c.gold || 0;
    const canLevel = canLevelUp(xp, c.level);
    const inventory = getCachedInventory(c.id, c.inventory);
    const itemCount = inventory.reduce((sum, item) => sum + (item.quantity || 1), 0);

    let spellSlots = {};
    try { spellSlots = JSON.parse(c.spell_slots || '{}'); } catch (e) { spellSlots = {}; }
    const spellSlotsShort = formatSpellSlotsShort(spellSlots);
    const hasSpellSlots = Object.keys(spellSlots).length > 0;

    const acShortDisplay = formatAcShort(c);

    const createPartySection = (sectionId, label, content, colorClass, isHtml = false) => {
      if (!content) return '';
      const isExpanded = getSectionState(c.id, sectionId);
      const safeContent = isHtml ? content : escapeHtml(content).replace(/\n/g, '<br>');
      return `
        <div class="section-collapsible party-section ${colorClass} ${isExpanded ? 'expanded' : ''}" data-char="${c.id}" data-section="${sectionId}">
          <div class="section-header" onclick="event.stopPropagation(); toggleSection('${c.id}', '${sectionId}')">
            <span class="section-toggle-icon">${isExpanded ? '\u25BC' : '\u25B6'}</span>
            <strong>${escapeHtml(label)}</strong>
          </div>
          <div class="section-content">${safeContent}</div>
        </div>
      `;
    };

    return `
    <div class="party-item" data-id="${c.id}">
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

      <div class="party-actions">
        <button class="party-btn" onclick="event.stopPropagation(); openInventoryModal('${c.id}')">Inv</button>
        <button class="party-btn" onclick="event.stopPropagation(); openSpellSlotsModal('${c.id}')">Spells</button>
        <button class="party-btn ${canLevel ? 'party-btn-levelup' : ''}" onclick="event.stopPropagation(); levelUpCharacter('${c.id}')" ${canLevel ? '' : 'disabled'}>${canLevel ? 'Level Up!' : 'Need XP'}</button>
      </div>
    </div>
  `}).join('');

  attachSectionToggleListeners();
}

export function toggleInventory(charId) {
  const list = document.getElementById(`inventory-${charId}`);
  if (!list) return;
  const isHidden = list.style.display === 'none';
  list.style.display = isHidden ? 'block' : 'none';
  const card = list.closest('.character-card');
  if (card) {
    const toggle = card.querySelector('.inventory-toggle');
    if (toggle) toggle.textContent = isHidden ? '-' : '+';
  }
}

// ============================================
// Character CRUD
// ============================================

export async function deleteCharacter(id) {
  if (!confirm('Are you sure you want to delete this character?')) return;
  try {
    await api(`/api/characters/${id}`, 'DELETE');
  } catch (error) {
    console.error('Failed to delete character:', error);
  }
}

export async function resetXP(id, name) {
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

export async function resetLevel(id, name) {
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

// ============================================
// AI Character Creation
// ============================================

export async function startCharacterCreation() {
  if (getState('charCreationInProgress')) return;

  setState({ charCreationMessages: [], charCreationInProgress: true });

  document.getElementById('start-creation-btn').disabled = true;
  document.getElementById('char-chat-input').disabled = false;
  document.getElementById('char-chat-send').disabled = false;

  const messagesContainer = document.getElementById('char-chat-messages');
  messagesContainer.innerHTML = '<div class="chat-message assistant"><div class="message-content">Starting character creation...</div></div>';

  try {
    const result = await api('/api/characters/ai-create', 'POST', {
      messages: [{ role: 'user', content: 'I want to create a new character. Please guide me through the process.' }]
    });

    const msgs = [
      { role: 'user', content: 'I want to create a new character. Please guide me through the process.' },
      { role: 'assistant', content: result.message }
    ];
    setState({ charCreationMessages: msgs });

    messagesContainer.innerHTML = `<div class="chat-message assistant"><div class="message-content">${formatChatMessage(result.message)}</div></div>`;
    scrollChatToBottom();
    saveAppState();

    document.getElementById('char-chat-input').focus();
  } catch (error) {
    messagesContainer.innerHTML = `<div class="chat-message assistant"><div class="message-content">Error: ${escapeHtml(error.message)}. Make sure your API is configured in Settings.</div></div>`;
    resetCharacterCreation();
  }
}

export async function sendCharacterMessage() {
  const input = document.getElementById('char-chat-input');
  const message = input.value.trim();

  if (!message || !getState('charCreationInProgress')) return;

  input.value = '';
  input.disabled = true;
  document.getElementById('char-chat-send').disabled = true;

  const messagesContainer = document.getElementById('char-chat-messages');
  messagesContainer.innerHTML += `<div class="chat-message user"><div class="message-content">${escapeHtml(message)}</div></div>`;
  scrollChatToBottom();

  const charCreationMessages = [...getState('charCreationMessages')];
  charCreationMessages.push({ role: 'user', content: message });
  setState({ charCreationMessages });

  messagesContainer.innerHTML += '<div class="chat-message assistant" id="loading-msg"><div class="message-content">Thinking...</div></div>';
  scrollChatToBottom();

  try {
    const result = await api('/api/characters/ai-create', 'POST', {
      messages: charCreationMessages
    });

    document.getElementById('loading-msg')?.remove();

    charCreationMessages.push({ role: 'assistant', content: result.message });
    setState({ charCreationMessages });

    messagesContainer.innerHTML += `<div class="chat-message assistant"><div class="message-content">${formatChatMessage(result.message)}</div></div>`;
    scrollChatToBottom();

    if (result.complete) {
      messagesContainer.innerHTML += `<div class="chat-message assistant"><div class="message-content"><strong>Character created successfully!</strong> Check the Characters list.</div></div>`;
      messagesContainer.innerHTML += `<div class="chat-message assistant"><div class="message-content">Want to create another character? Just describe them!</div></div>`;
      scrollChatToBottom();
      loadCharacters();
      setState({ charCreationMessages: [] });
      input.disabled = false;
      document.getElementById('char-chat-send').disabled = false;
      input.focus();
      saveAppState();
    } else {
      input.disabled = false;
      document.getElementById('char-chat-send').disabled = false;
      input.focus();
      saveAppState();
    }
  } catch (error) {
    document.getElementById('loading-msg')?.remove();
    messagesContainer.innerHTML += `<div class="chat-message assistant"><div class="message-content">Error: ${escapeHtml(error.message)}</div></div>`;
    input.disabled = false;
    document.getElementById('char-chat-send').disabled = false;
  }
}

export function resetCharacterCreation() {
  setState({ charCreationMessages: [], charCreationInProgress: false });

  document.getElementById('start-creation-btn').disabled = false;
  document.getElementById('char-chat-input').disabled = true;
  document.getElementById('char-chat-input').value = '';
  document.getElementById('char-chat-send').disabled = true;

  document.getElementById('char-chat-messages').innerHTML = `
    <div class="chat-message assistant">
      <div class="message-content">Click "Start Character Creation" to begin creating your Level 1 character with AI guidance!</div>
    </div>
  `;
  saveAppState();
}

// Helper to format multiclass display
export function formatMulticlass(classes) {
  if (!classes || Object.keys(classes).length === 0) return '';
  return Object.entries(classes).map(([cls, lvl]) => `${cls} ${lvl}`).join(' / ');
}

// ============================================
// Avatar Upload (click avatar to change image)
// ============================================

let avatarFileInput = null;
let avatarTargetCharId = null;

export function initAvatarUpload() {
  avatarFileInput = document.createElement('input');
  avatarFileInput.type = 'file';
  avatarFileInput.accept = 'image/jpeg,image/png,image/webp,image/gif';
  avatarFileInput.style.display = 'none';
  document.body.appendChild(avatarFileInput);

  avatarFileInput.addEventListener('change', async () => {
    if (!avatarFileInput.files[0] || !avatarTargetCharId) return;
    const file = avatarFileInput.files[0];
    if (file.size > 5 * 1024 * 1024) {
      showNotification('Image must be under 5MB');
      return;
    }
    const formData = new FormData();
    formData.append('image', file);
    try {
      const res = await fetch(`/api/characters/${avatarTargetCharId}/image`, {
        method: 'POST',
        headers: { 'X-Admin-Password': getState('adminPassword') || '' },
        body: formData
      });
      if (!res.ok) throw new Error('Upload failed');
      showNotification('Avatar updated!');
      loadCharacters();
    } catch (e) {
      showNotification('Failed to upload avatar: ' + e.message);
    }
    avatarFileInput.value = '';
    avatarTargetCharId = null;
  });

  document.addEventListener('click', (e) => {
    const avatar = e.target.closest('.char-avatar, .char-avatar-placeholder');
    if (!avatar) return;
    const card = avatar.closest('.character-card[data-id]');
    if (!card) return;
    e.stopPropagation();
    avatarTargetCharId = card.dataset.id;
    avatarFileInput.click();
  });
}
