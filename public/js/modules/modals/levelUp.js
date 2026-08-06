// ============================================
// Rules-driven Level Up Modal
// ============================================

import { getState, setState } from '../../state.js';
import { api } from '../../api.js';
import { escapeHtml } from '../../utils/formatters.js';
import { showNotification } from '../../utils/dom.js';
import { getRequiredXP, canLevelUp } from '../../utils/gameRules.js';
import { getSubclasses } from '../../utils/dndData.js';
import { loadCharacters } from '../characters.js';

const ABILITIES = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'];
const CUSTOM_SUBCLASS = '__custom__';

export async function levelUpCharacter(charId) {
  const characters = getState('characters');
  const char = characters.find(c => c.id === charId);
  if (!char) return;

  if (!canLevelUp(char.xp || 0, char.level)) {
    alert(`${char.character_name} needs ${getRequiredXP(char.level)} XP to level up. Current: ${char.xp || 0} XP`);
    return;
  }

  setState({ levelUpModalCharId: charId, levelUpMessages: [] });
  document.getElementById('modal-title').textContent = `Level Up ${char.character_name}`;
  document.getElementById('modal-input-area')?.classList.add('hidden');
  document.getElementById('modal-chat-messages').innerHTML = '<div class="chat-message assistant"><div class="message-content">Loading the rules for this level...</div></div>';
  document.getElementById('char-modal').classList.add('active');

  loadLevelInfo(charId, char);
}

/**
 * Load (or reload) the level info in place. A 409 unresolved_class renders the
 * repair widget instead of a dead-end error.
 */
async function loadLevelInfo(charId, char, requestedClass) {
  const query = requestedClass ? `?class=${encodeURIComponent(requestedClass)}` : '';
  try {
    const info = await api(`/api/characters/${charId}/levelinfo${query}`);
    renderLevelUpForm(charId, char, info);
  } catch (error) {
    if (error.status === 409 && error.data?.error === 'unresolved_class') {
      renderClassRepair(charId, char, error.data);
      return;
    }
    renderError(error.message);
  }
}

function renderLevelUpForm(charId, char, info) {
  const progression = info.nextProgression;
  if (!progression) {
    renderError('No progression data is available for this level.');
    return;
  }

  const classOptions = (info.classOptions || []).filter(option => option.available);
  const classSelect = classOptions.map(option => {
    const selected = option.name === info.currentClass ? ' selected' : '';
    const label = option.level ? `${option.name} (level ${option.level})` : `${option.name} (multiclass)`;
    return `<option value="${escapeHtml(option.name)}"${selected}>${escapeHtml(label)}</option>`;
  }).join('');
  const asi = progression.asi ? `
    <div class="levelup-choice-group">
      <label for="levelup-asi">Ability Score Improvement</label>
      <select id="levelup-asi" class="levelup-asi-select">
        <option value="none">Choose a +2 increase</option>
        ${ABILITIES.map(ability => `<option value="${ability}">+2 ${ability[0].toUpperCase() + ability.slice(1)}</option>`).join('')}
        <option value="split">+1 to two abilities</option>
        <option value="feat">Take a feat instead</option>
      </select>
      <div id="levelup-asi-split" class="hidden">
        <select id="levelup-asi-first">${ABILITIES.map(ability => `<option value="${ability}">${ability}</option>`).join('')}</select>
        <select id="levelup-asi-second">${ABILITIES.map(ability => `<option value="${ability}">${ability}</option>`).join('')}</select>
      </div>
      <input id="levelup-feat" class="hidden" maxlength="120" placeholder="Feat name">
    </div>` : '';
  const subclass = progression.subclass ? `
    <div class="levelup-choice-group" id="levelup-subclass-group">
      <label for="levelup-subclass">Subclass choice</label>
      <input id="levelup-subclass" maxlength="120" placeholder="Subclass, oath, domain, path, tradition, or patron">
      <div id="levelup-subclass-features" class="info-panel"></div>
    </div>` : '';
  const spellcasting = progression.spell_slots?.some(slot => slot > 0) ? `
    <div class="levelup-choice-group">
      <label for="levelup-spells">New spells or cantrips</label>
      <textarea id="levelup-spells" rows="2" placeholder="Optional: separate spell names with commas"></textarea>
    </div>` : '';

  const subclassLabel = info.currentSubclass ? ` (${escapeHtml(info.currentSubclass)})` : '';

  document.getElementById('modal-chat-messages').innerHTML = `
    <div class="chat-message assistant"><div class="message-content">
      <strong>Level ${info.nextLevel}: ${escapeHtml(info.currentClass)}${subclassLabel} ${info.currentClassLevel + 1}</strong><br>
      Choose the class level to take. The server applies HP, features, proficiencies, ASI/feat rules, and spell slots from the stored 2014/5e progression.
      <ul>${progression.features.map(feature => `<li>${escapeHtml(feature)}</li>`).join('') || '<li>No named feature at this level</li>'}</ul>
      <ul id="levelup-subclass-upcoming"></ul>
      <p>Fixed HP increase: ${Math.floor(progression.hitDie / 2) + 1 + Math.floor((Number(char.constitution || 10) - 10) / 2)} (minimum 1).</p>
    </div></div>
    <div class="levelup-form" id="levelup-form">
      <div class="levelup-choice-group"><label for="levelup-class">Class level</label><select id="levelup-class">${classSelect}</select></div>
      ${asi}${subclass}${spellcasting}
      <button class="btn-primary" onclick="submitStructuredLevelUp('${escapeHtml(charId)}')">Apply Level Up</button>
    </div>`;

  document.getElementById('levelup-class')?.addEventListener('change', event => {
    loadLevelInfo(charId, char, event.target.value);
  });
  document.getElementById('levelup-asi')?.addEventListener('change', event => {
    document.getElementById('levelup-asi-split')?.classList.toggle('hidden', event.target.value !== 'split');
    document.getElementById('levelup-feat')?.classList.toggle('hidden', event.target.value !== 'feat');
  });

  // Static subclass data is a nice-to-have: both hydrations degrade to the
  // plain free-text input / no extra features when the fetch fails.
  if (progression.subclass) {
    hydrateSubclassChoice(info.currentClass, info.currentClassLevel + 1, info.currentSubclass);
  } else if (info.currentSubclass) {
    hydrateUpcomingSubclassFeatures(info.currentClass, info.currentSubclass, info.currentClassLevel + 1);
  }
}

// ============================================
// Subclass helpers
// ============================================

function matchesSubclass(subclass, value) {
  const needle = String(value || '').trim().toLowerCase();
  if (!needle) return false;
  return String(subclass.index || '').toLowerCase() === needle
    || String(subclass.name || '').toLowerCase() === needle;
}

function renderSubclassFeatures(subclasses, value, classLevel) {
  const panel = document.getElementById('levelup-subclass-features');
  if (!panel) return;
  const subclass = subclasses.find(sub => matchesSubclass(sub, value));
  const features = subclass ? (subclass.features_by_level || {})[String(classLevel)] || [] : [];
  panel.innerHTML = features.length
    ? `<strong>${escapeHtml(subclass.name)} at class level ${classLevel}:</strong> ${features.map(feature => escapeHtml(feature)).join(', ')}`
    : '';
}

/**
 * Swap the free-text subclass input for a select built from the SRD list.
 * Leaves the input in place (and visible) when the data cannot be loaded.
 */
async function hydrateSubclassChoice(className, classLevel, currentSubclass) {
  const group = document.getElementById('levelup-subclass-group');
  if (!group) return;

  let subclasses = [];
  try {
    subclasses = await getSubclasses(className);
  } catch (error) {
    console.error('Failed to load subclasses:', error);
    return;
  }
  // The modal may have re-rendered (class switch) while the fetch was in flight.
  if (!subclasses.length || document.getElementById('levelup-subclass-group') !== group) return;

  const input = document.getElementById('levelup-subclass');
  if (!input) return;

  const flavor = subclasses[0].flavor_name || 'Subclass';
  const matched = subclasses.find(sub => matchesSubclass(sub, currentSubclass));
  const label = group.querySelector('label');
  if (label) {
    label.textContent = `${flavor} choice`;
    label.htmlFor = 'levelup-subclass-select';
  }

  input.insertAdjacentHTML('beforebegin', `
    <select id="levelup-subclass-select">
      <option value="">Choose a ${escapeHtml(flavor.toLowerCase())}...</option>
      ${subclasses.map(sub => `<option value="${escapeHtml(sub.name)}"${sub === matched ? ' selected' : ''}>${escapeHtml(sub.name)}</option>`).join('')}
      <option value="${CUSTOM_SUBCLASS}">Homebrew / custom...</option>
    </select>`);
  input.classList.add('hidden');

  document.getElementById('levelup-subclass-select')?.addEventListener('change', event => {
    const custom = event.target.value === CUSTOM_SUBCLASS;
    input.classList.toggle('hidden', !custom);
    renderSubclassFeatures(subclasses, custom ? '' : event.target.value, classLevel);
  });
  renderSubclassFeatures(subclasses, matched ? matched.name : '', classLevel);
}

/**
 * List the already-chosen subclass's features for the incoming level next to
 * the class features.
 */
async function hydrateUpcomingSubclassFeatures(className, subclassName, classLevel) {
  const list = document.getElementById('levelup-subclass-upcoming');
  if (!list) return;

  let subclasses = [];
  try {
    subclasses = await getSubclasses(className);
  } catch (error) {
    console.error('Failed to load subclasses:', error);
    return;
  }
  if (document.getElementById('levelup-subclass-upcoming') !== list) return;

  const subclass = subclasses.find(sub => matchesSubclass(sub, subclassName));
  const features = subclass ? (subclass.features_by_level || {})[String(classLevel)] || [] : [];
  list.innerHTML = features.map(feature => `<li>${escapeHtml(feature)} <em>(${escapeHtml(subclass.name)})</em></li>`).join('');
}

function readSubclassChoice() {
  const select = document.getElementById('levelup-subclass-select');
  const input = document.getElementById('levelup-subclass');
  if (select && select.value !== CUSTOM_SUBCLASS) return select.value || '';
  return input?.value || '';
}

// ============================================
// Unresolvable class repair
// ============================================

function renderClassRepair(charId, char, details) {
  const suggestions = details.suggestions || [];
  const buttons = suggestions.map(name =>
    `<button class="btn-secondary levelup-repair-btn" data-class="${escapeHtml(name)}">${escapeHtml(name)}</button>`).join(' ');

  document.getElementById('modal-chat-messages').innerHTML = `
    <div class="chat-message assistant"><div class="message-content">
      This character's class "${escapeHtml(details.unresolvedClass || '')}" isn't recognized, so the level-up rules can't be applied.
      Pick the class it should be and the sheet is repaired in place.
    </div></div>
    <div class="levelup-form" id="levelup-repair-form">
      ${buttons ? `<div class="levelup-choice-group">${buttons}</div>` : ''}
      <div class="levelup-choice-group">
        <label for="levelup-repair-input">Or type the class name</label>
        <input id="levelup-repair-input" maxlength="60" placeholder="Fighter, Wizard, Rogue...">
        <button class="btn-primary" id="levelup-repair-apply">Apply</button>
      </div>
      <div id="levelup-repair-error" class="form-hint"></div>
    </div>`;

  document.getElementById('levelup-repair-form')?.querySelectorAll('.levelup-repair-btn').forEach(btn => {
    btn.addEventListener('click', () => repairClass(charId, char, btn.dataset.class, details));
  });
  document.getElementById('levelup-repair-apply')?.addEventListener('click', () => {
    repairClass(charId, char, document.getElementById('levelup-repair-input')?.value.trim(), details);
  });
}

/**
 * Rebuild a character's `classes` map with the unresolvable key swapped for the
 * class the player picked.
 *
 * The multiclass migration copied the broken class string into `classes` as a
 * KEY, so repairing only the `class` column leaves /levelinfo 409ing on the very
 * same string forever — the repair widget loops. Levels merge with Math.max when
 * the canonical key is already present (Warlock + "warlock " → one Warlock).
 *
 * @returns {Object|null} the remapped map, or null when the broken string is not
 *   a key at all (then only `class` needs writing and the map is left alone).
 */
function remapClassesMap(char, unresolvedClass, className) {
  const broken = String(unresolvedClass || '').trim().toLowerCase();
  if (!broken) return null;
  const parsed = parseClasses(char?.classes, char?.class, char?.level);
  const keys = Object.keys(parsed);
  if (!keys.some(key => String(key).trim().toLowerCase() === broken)) return null;

  const remapped = {};
  for (const key of keys) {
    const target = String(key).trim().toLowerCase() === broken ? className : key;
    const level = Math.max(0, Number(parsed[key]) || 0);
    remapped[target] = Math.max(remapped[target] || 0, level);
  }
  return remapped;
}

async function repairClass(charId, char, className, details) {
  const errorEl = document.getElementById('levelup-repair-error');
  if (!className) {
    if (errorEl) errorEl.textContent = 'Enter a class name first.';
    return;
  }
  if (errorEl) errorEl.textContent = 'Repairing...';

  // Re-read the row: `char` was captured when the modal opened and may predate a
  // socket-driven refresh.
  const fresh = (getState('characters') || []).find(candidate => candidate.id === charId) || char;
  const classes = remapClassesMap(fresh, details?.unresolvedClass, className);

  try {
    await api(`/api/characters/${charId}/quick-update`, 'POST', {
      class: className,
      // `classes` is normalized server-side by normalizeClassesMap, which takes a
      // plain object or a JSON string; send the object.
      ...(classes ? { classes } : {})
    });
  } catch (error) {
    const hints = error.data?.suggestions || [];
    // `input` names WHICH key the server rejected — with the classes map now in
    // the payload that may be a second broken key, not the one just picked.
    const offender = error.data?.input && error.data.input !== className ? ` ("${error.data.input}")` : '';
    if (errorEl) errorEl.textContent = `${error.message}${offender}${hints.length ? `. Try: ${hints.join(', ')}` : ''}`;
    return;
  }
  await loadCharacters();
  const reloaded = (getState('characters') || []).find(candidate => candidate.id === charId) || fresh;
  loadLevelInfo(charId, reloaded);
}

export async function submitStructuredLevelUp(charId) {
  const asi = document.getElementById('levelup-asi')?.value || 'none';
  const abilityIncreases = {};
  if (asi === 'split') {
    const first = document.getElementById('levelup-asi-first')?.value;
    const second = document.getElementById('levelup-asi-second')?.value;
    if (first === second) return renderError('Choose two different abilities for a split increase.');
    abilityIncreases[first] = 1;
    abilityIncreases[second] = 1;
  } else if (ABILITIES.includes(asi)) {
    abilityIncreases[asi] = 2;
  }
  try {
    const result = await api(`/api/characters/${charId}/levelup`, 'POST', {
      choices: {
        class_name: document.getElementById('levelup-class')?.value,
        ability_increases: abilityIncreases,
        feat: asi === 'feat' ? document.getElementById('levelup-feat')?.value : '',
        subclass: readSubclassChoice(),
        spells: document.getElementById('levelup-spells')?.value || ''
      }
    });
    // The slot warning is advisory — the level up already went through.
    const warning = result.slotWarning ? `<p class="form-hint">Note: ${escapeHtml(result.slotWarning)}</p>` : '';
    document.getElementById('modal-chat-messages').innerHTML = `<div class="chat-message assistant"><div class="message-content">${escapeHtml(result.message)}${warning}</div></div>`;
    if (result.complete) {
      loadCharacters();
      showNotification(`${result.character.character_name} is now level ${result.character.level}!`);
    }
  } catch (error) {
    renderError(error.message);
  }
}

function parseClasses(raw, primaryClass, totalLevel) {
  try {
    const parsed = JSON.parse(raw || '{}');
    if (Object.keys(parsed).length) return parsed;
  } catch (e) { /* use the legacy primary class below */ }
  return primaryClass ? { [primaryClass]: totalLevel || 1 } : {};
}

function renderError(message) {
  document.getElementById('modal-chat-messages').innerHTML = `<div class="chat-message assistant"><div class="message-content">Error: ${escapeHtml(message)}</div></div>`;
}
