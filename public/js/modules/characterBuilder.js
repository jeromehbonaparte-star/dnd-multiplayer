// ============================================
// Character Builder Module
// - Multi-step form-based character creation
// - Race/class/stat/skill/spell/equipment selection
// - Image upload, AI-assisted backstory/appearance
// ============================================

import { api } from '../api.js';
import { getState } from '../state.js';
import { loadCharacters } from './characters.js';
import { escapeHtml } from '../utils/formatters.js';
import { showNotification } from '../utils/dom.js';
import {
  getRaces, getClasses, getSpellsByClass, getEquipment, getSkills, getBackgrounds,
  STANDARD_ARRAY, POINT_BUY_COSTS, POINT_BUY_TOTAL, ABILITY_NAMES, ABILITY_SHORT,
  calcModifier, modString, CASTER_DATA
} from '../utils/dndData.js';

// ============================================
// Internal State
// ============================================

const builder = {
  step: 0,
  steps: ['basics', 'stats', 'abilities', 'equipment', 'story'],
  races: [],
  classes: [],
  skills: [],
  backgrounds: [],
  selectedRace: null,
  selectedClass: null,
  selectedBackground: null,
  statMethod: 'standard-array',
  stats: { strength: 10, dexterity: 10, constitution: 10, intelligence: 10, wisdom: 10, charisma: 10 },
  racialBonuses: {},
  selectedSkills: new Set(),
  maxSkills: 2,
  availableSkills: [],
  selectedCantrips: new Set(),
  maxCantrips: 0,
  selectedSpells: new Set(),
  maxSpells: 0,
  selectedEquipment: [],
  imageFile: null,
  standardArrayRemaining: [...STANDARD_ARRAY],
  standardArrayAssignments: {},
  pointBuyValues: { strength: 8, dexterity: 8, constitution: 8, intelligence: 8, wisdom: 8, charisma: 8 },
  pointsRemaining: POINT_BUY_TOTAL,
  rolledValues: [],
  rolledAssignments: {},
  equipmentData: [],
};

// ============================================
// Hardcoded class starting equipment
// ============================================

const CLASS_STARTING_EQUIPMENT = {
  fighter: ['Chain Mail', 'Shield', 'Longsword', 'Handaxe', 'Handaxe'],
  wizard: ['Quarterstaff', 'Component Pouch', 'Scholar\'s Pack'],
  cleric: ['Mace', 'Scale Mail', 'Shield', 'Light Crossbow'],
  rogue: ['Shortsword', 'Shortbow', 'Leather Armor', 'Thieves\' Tools'],
  ranger: ['Longbow', 'Leather Armor', 'Shortsword', 'Shortsword', 'Explorer\'s Pack'],
  paladin: ['Longsword', 'Shield', 'Chain Mail', 'Holy Symbol'],
  barbarian: ['Greataxe', 'Handaxe', 'Handaxe', 'Explorer\'s Pack'],
  bard: ['Rapier', 'Lute', 'Leather Armor', 'Entertainer\'s Pack'],
  druid: ['Wooden Shield', 'Scimitar', 'Leather Armor', 'Explorer\'s Pack'],
  monk: ['Shortsword', 'Dart', 'Explorer\'s Pack'],
  sorcerer: ['Light Crossbow', 'Component Pouch', 'Dungeoneer\'s Pack'],
  warlock: ['Light Crossbow', 'Component Pouch', 'Scholar\'s Pack', 'Leather Armor'],
};

// ============================================
// Initialization
// ============================================

export function initCharacterBuilder() {
  // Mode toggle buttons
  const modeFormBtn = document.getElementById('mode-form-btn');
  const modeAiBtn = document.getElementById('mode-ai-btn');
  if (modeFormBtn) {
    modeFormBtn.addEventListener('click', () => {
      modeFormBtn.classList.add('active');
      modeAiBtn?.classList.remove('active');
      const builderEl = document.getElementById('char-builder');
      const aiEl = document.getElementById('char-ai-creator');
      if (builderEl) builderEl.classList.remove('hidden');
      if (aiEl) aiEl.classList.add('hidden');
    });
  }
  if (modeAiBtn) {
    modeAiBtn.addEventListener('click', () => {
      modeAiBtn.classList.add('active');
      modeFormBtn?.classList.remove('active');
      const builderEl = document.getElementById('char-builder');
      const aiEl = document.getElementById('char-ai-creator');
      if (builderEl) builderEl.classList.add('hidden');
      if (aiEl) aiEl.classList.remove('hidden');
    });
  }

  // Builder tab buttons
  document.querySelectorAll('.builder-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const stepIndex = parseInt(tab.dataset.step);
      if (!isNaN(stepIndex)) switchBuilderStep(stepIndex);
    });
  });

  // Stat method buttons
  document.querySelectorAll('.stat-method-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const method = btn.dataset.method;
      if (method) switchStatMethod(method);
    });
  });

  // Navigation buttons
  const prevBtn = document.getElementById('builder-prev');
  const nextBtn = document.getElementById('builder-next');
  const createBtn = document.getElementById('builder-create');
  if (prevBtn) prevBtn.addEventListener('click', () => switchBuilderStep(builder.step - 1));
  if (nextBtn) nextBtn.addEventListener('click', () => switchBuilderStep(builder.step + 1));
  if (createBtn) createBtn.addEventListener('click', () => saveNewCharacter());

  // Race/class/background select change handlers
  const raceSelect = document.getElementById('builder-race');
  const classSelect = document.getElementById('builder-class');
  const bgSelect = document.getElementById('builder-background');
  if (raceSelect) raceSelect.addEventListener('change', () => onRaceChange(raceSelect.value));
  if (classSelect) classSelect.addEventListener('change', () => onClassChange(classSelect.value));
  if (bgSelect) {
    bgSelect.addEventListener('change', () => {
      const idx = bgSelect.value;
      builder.selectedBackground = builder.backgrounds.find(b => b.index === idx) || null;
    });
  }

  // Image upload area
  const uploadArea = document.getElementById('image-upload-area');
  const fileInput = document.getElementById('builder-image');
  const removeImageBtn = document.getElementById('remove-image-btn');
  if (uploadArea && fileInput) {
    uploadArea.addEventListener('click', (e) => {
      if (e.target === removeImageBtn || e.target.closest('#remove-image-btn')) return;
      fileInput.click();
    });
    uploadArea.addEventListener('dragover', (e) => {
      e.preventDefault();
      uploadArea.classList.add('dragover');
    });
    uploadArea.addEventListener('dragleave', () => {
      uploadArea.classList.remove('dragover');
    });
    uploadArea.addEventListener('drop', (e) => {
      e.preventDefault();
      uploadArea.classList.remove('dragover');
      if (e.dataTransfer.files.length > 0) {
        handleImageFile(e.dataTransfer.files[0]);
      }
    });
    fileInput.addEventListener('change', () => {
      if (fileInput.files.length > 0) {
        handleImageFile(fileInput.files[0]);
      }
    });
  }
  if (removeImageBtn) {
    removeImageBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      clearImageUpload();
    });
  }

  // Roll stats button
  const rollBtn = document.getElementById('roll-stats-btn');
  if (rollBtn) rollBtn.addEventListener('click', rollStats);

  // AI help buttons
  const aiAppearanceBtn = document.getElementById('ai-help-appearance');
  const aiBackstoryBtn = document.getElementById('ai-help-backstory');
  if (aiAppearanceBtn) aiAppearanceBtn.addEventListener('click', generateAIAppearance);
  if (aiBackstoryBtn) aiBackstoryBtn.addEventListener('click', generateAIBackstory);

  // Equipment search
  const equipSearch = document.getElementById('equipment-search');
  if (equipSearch) {
    equipSearch.addEventListener('keyup', onEquipmentSearch);
    equipSearch.addEventListener('focus', onEquipmentSearch);
    // Close dropdown on outside click
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#builder-equipment .form-group')) {
        const dropdown = document.getElementById('equipment-search-results');
        if (dropdown) dropdown.classList.add('hidden');
      }
    });
  }

  // Pre-fetch data in parallel
  loadBuilderData();

  // Initialize stat assignment UI for default method
  renderStatMethodPanel();
}

// ============================================
// Data Loading
// ============================================

async function loadBuilderData() {
  try {
    const [races, classes, skills, backgrounds] = await Promise.all([
      getRaces().catch(() => []),
      getClasses().catch(() => []),
      getSkills().catch(() => []),
      getBackgrounds().catch(() => []),
    ]);

    builder.races = races;
    builder.classes = classes;
    builder.skills = skills;
    builder.backgrounds = backgrounds;

    populateSelect('builder-race', races, 'Select race...');
    populateSelect('builder-class', classes, 'Select class...');
    populateSelect('builder-background', backgrounds, 'Select background...');
  } catch (e) {
    console.error('Failed to load builder data:', e);
  }
}

function populateSelect(selectId, items, placeholder) {
  const select = document.getElementById(selectId);
  if (!select) return;
  select.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>` +
    items.map(item => `<option value="${escapeHtml(item.index)}">${escapeHtml(item.name)}</option>`).join('');
}

// ============================================
// Step Navigation
// ============================================

export function switchBuilderStep(stepIndex) {
  // Clamp
  if (stepIndex < 0 || stepIndex > builder.steps.length - 1) return;

  // Validate current step before advancing forward
  if (stepIndex > builder.step) {
    if (!validateStep(builder.step)) return;
  }

  builder.step = stepIndex;

  // Show/hide steps
  document.querySelectorAll('.builder-step').forEach(el => el.classList.remove('active'));
  const stepId = `builder-${builder.steps[stepIndex]}`;
  document.getElementById(stepId)?.classList.add('active');

  // Update tabs
  document.querySelectorAll('.builder-tab').forEach(tab => {
    const tabStep = parseInt(tab.dataset.step);
    tab.classList.toggle('active', tabStep === stepIndex);
    tab.classList.toggle('completed', tabStep < stepIndex);
  });

  // Update progress bar
  const progressFill = document.getElementById('builder-progress-fill');
  if (progressFill) {
    progressFill.style.width = `${((stepIndex + 1) / builder.steps.length) * 100}%`;
  }

  // Show/hide nav buttons
  const prevBtn = document.getElementById('builder-prev');
  const nextBtn = document.getElementById('builder-next');
  const createBtn = document.getElementById('builder-create');
  if (prevBtn) prevBtn.disabled = stepIndex === 0;
  if (nextBtn) nextBtn.classList.toggle('hidden', stepIndex === builder.steps.length - 1);
  if (createBtn) createBtn.classList.toggle('hidden', stepIndex !== builder.steps.length - 1);

  // Render step-specific content when entering
  if (stepIndex === 1) renderStatMethodPanel();
  if (stepIndex === 2) renderAbilitiesStep();
  if (stepIndex === 3) renderEquipmentSection();
}

function validateStep(step) {
  if (step === 0) {
    const charName = document.getElementById('builder-char-name')?.value.trim();
    const race = document.getElementById('builder-race')?.value;
    const cls = document.getElementById('builder-class')?.value;
    if (!charName) { showNotification('Please enter a character name'); return false; }
    if (!race) { showNotification('Please select a race'); return false; }
    if (!cls) { showNotification('Please select a class'); return false; }
    return true;
  }
  if (step === 1) {
    const stats = getFinalBaseStats();
    const allAssigned = ABILITY_NAMES.every(a => stats[a] >= 3);
    if (!allAssigned) { showNotification('Please assign all ability scores'); return false; }
    return true;
  }
  return true;
}

// ============================================
// Race Change
// ============================================

function onRaceChange(raceIndex) {
  builder.selectedRace = builder.races.find(r => r.index === raceIndex) || null;
  const infoPanel = document.getElementById('race-info');
  if (!infoPanel) return;

  if (!builder.selectedRace) {
    infoPanel.innerHTML = '';
    builder.racialBonuses = {};
    renderStatsSummary();
    return;
  }

  const race = builder.selectedRace;
  builder.racialBonuses = {};
  if (race.ability_bonuses) {
    race.ability_bonuses.forEach(b => {
      const abilityName = (b.ability || b.ability_score?.name || '').toLowerCase();
      if (abilityName) builder.racialBonuses[abilityName] = b.bonus;
    });
  }

  infoPanel.innerHTML = `
    <strong>${escapeHtml(race.name)}</strong><br>
    <strong>Speed:</strong> ${race.speed || 30}ft<br>
    <strong>Size:</strong> ${escapeHtml(race.size || 'Medium')}<br>
    ${race.ability_bonuses?.length ? `<strong>Ability Bonuses:</strong> ${race.ability_bonuses.map(b => `${escapeHtml(b.ability || b.ability_score?.name || '?')} +${b.bonus}`).join(', ')}<br>` : ''}
    ${race.traits?.length ? `<strong>Traits:</strong> ${race.traits.map(t => escapeHtml(typeof t === 'string' ? t : t.name || t)).join(', ')}<br>` : ''}
    ${race.languages?.length ? `<strong>Languages:</strong> ${race.languages.map(l => escapeHtml(typeof l === 'string' ? l : l.name || l)).join(', ')}` : ''}
  `;

  renderStatsSummary();
}

// ============================================
// Class Change
// ============================================

function onClassChange(classIndex) {
  builder.selectedClass = builder.classes.find(c => c.index === classIndex) || null;
  const infoPanel = document.getElementById('class-info');
  if (!infoPanel) return;

  if (!builder.selectedClass) {
    infoPanel.innerHTML = '';
    builder.maxSkills = 2;
    builder.availableSkills = [];
    builder.selectedSkills.clear();
    builder.selectedCantrips.clear();
    builder.selectedSpells.clear();
    return;
  }

  const cls = builder.selectedClass;

  // Parse proficiency choices
  if (cls.proficiency_choices && cls.proficiency_choices.length > 0) {
    const choice = cls.proficiency_choices[0];
    builder.maxSkills = choice.choose || 2;
    builder.availableSkills = [];
    if (choice.from?.options) {
      builder.availableSkills = choice.from.options.map(opt => {
        const item = opt.item || opt;
        const name = item.name || item.index || '';
        // Strip "Skill: " prefix if present
        return name.replace(/^Skill:\s*/i, '');
      }).filter(Boolean);
    }
  } else {
    builder.maxSkills = 2;
    builder.availableSkills = builder.skills.map(s => s.name);
  }

  builder.selectedSkills.clear();
  builder.selectedCantrips.clear();
  builder.selectedSpells.clear();

  // Determine caster info
  const clsName = cls.name.toLowerCase();
  const casterInfo = CASTER_DATA[clsName];
  builder.maxCantrips = casterInfo?.cantrips || 0;
  if (casterInfo) {
    const spellsKnown = casterInfo.spells_known;
    if (typeof spellsKnown === 'number') {
      builder.maxSpells = spellsKnown;
    } else if (typeof spellsKnown === 'string') {
      // e.g. 'wis+1' or 'int+1'
      builder.maxSpells = 2; // Default, will be recalculated in renderAbilitiesStep
    } else {
      builder.maxSpells = 0;
    }
  } else {
    builder.maxCantrips = 0;
    builder.maxSpells = 0;
  }

  infoPanel.innerHTML = `
    <strong>${escapeHtml(cls.name)}</strong><br>
    <strong>Hit Die:</strong> d${cls.hit_die || 10}<br>
    ${cls.saving_throws?.length ? `<strong>Saving Throws:</strong> ${cls.saving_throws.map(s => escapeHtml(typeof s === 'string' ? s : s.name || s)).join(', ')}<br>` : ''}
    ${cls.proficiencies?.length ? `<strong>Proficiencies:</strong> ${cls.proficiencies.map(p => escapeHtml(typeof p === 'string' ? p : p.name || p)).join(', ')}<br>` : ''}
    <strong>Skill Choices:</strong> Choose ${builder.maxSkills} from available skills<br>
    ${cls.is_caster ? `<strong>Spellcasting:</strong> Yes (${escapeHtml(cls.spellcasting_ability || 'unknown')} ability)` : '<strong>Spellcasting:</strong> None'}
  `;

  // Pre-render equipment suggestion
  renderEquipmentSuggestion();
}

// ============================================
// Stat Methods
// ============================================

function switchStatMethod(method) {
  builder.statMethod = method;

  // Update button active states
  document.querySelectorAll('.stat-method-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.method === method);
  });

  // Show matching panel
  document.querySelectorAll('.stat-method-panel').forEach(panel => panel.classList.remove('active'));
  const panelId = `stat-${method}`;
  document.getElementById(panelId)?.classList.add('active');

  renderStatMethodPanel();
}

function renderStatMethodPanel() {
  switch (builder.statMethod) {
    case 'standard-array': renderStandardArrayPanel(); break;
    case 'point-buy': renderPointBuyPanel(); break;
    case 'roll': renderRollPanel(); break;
    case 'manual': renderManualPanel(); break;
  }
  renderStatsSummary();
}

function renderStandardArrayPanel() {
  const grid = document.getElementById('stat-assign-grid');
  if (!grid) return;

  grid.innerHTML = ABILITY_NAMES.map(ability => {
    const assigned = builder.standardArrayAssignments[ability];
    const usedValues = Object.values(builder.standardArrayAssignments);
    const availableValues = STANDARD_ARRAY.filter(v =>
      !usedValues.includes(v) || v === assigned
    );

    return `
      <div class="form-group stat-input">
        <label>${ABILITY_SHORT[ability]}</label>
        <select data-ability="${ability}" class="std-array-select">
          <option value="">--</option>
          ${availableValues.map(v => `<option value="${v}" ${assigned === v ? 'selected' : ''}>${v}</option>`).join('')}
        </select>
      </div>
    `;
  }).join('');

  // Attach change listeners
  grid.querySelectorAll('.std-array-select').forEach(select => {
    select.addEventListener('change', (e) => {
      const ability = e.target.dataset.ability;
      const val = parseInt(e.target.value);
      if (isNaN(val)) {
        delete builder.standardArrayAssignments[ability];
      } else {
        builder.standardArrayAssignments[ability] = val;
      }
      // Re-render to update available options
      renderStandardArrayPanel();
    });
  });
}

function renderPointBuyPanel() {
  const grid = document.getElementById('stat-pointbuy-grid');
  if (!grid) return;

  // Recalculate points remaining
  let spent = 0;
  for (const ability of ABILITY_NAMES) {
    spent += POINT_BUY_COSTS[builder.pointBuyValues[ability]] || 0;
  }
  builder.pointsRemaining = POINT_BUY_TOTAL - spent;

  const remaining = document.getElementById('points-remaining');
  if (remaining) remaining.textContent = builder.pointsRemaining;

  grid.innerHTML = ABILITY_NAMES.map(ability => {
    const val = builder.pointBuyValues[ability];
    const canIncrease = val < 15 && (POINT_BUY_COSTS[val + 1] - POINT_BUY_COSTS[val]) <= builder.pointsRemaining;
    const canDecrease = val > 8;

    return `
      <div class="form-group stat-input">
        <label>${ABILITY_SHORT[ability]}</label>
        <div class="point-buy-stat">
          <button data-ability="${ability}" data-dir="down" ${canDecrease ? '' : 'disabled'}>-</button>
          <span class="stat-value">${val}</span>
          <button data-ability="${ability}" data-dir="up" ${canIncrease ? '' : 'disabled'}>+</button>
        </div>
      </div>
    `;
  }).join('');

  // Attach listeners
  grid.querySelectorAll('.point-buy-stat button').forEach(btn => {
    btn.addEventListener('click', () => {
      const ability = btn.dataset.ability;
      const dir = btn.dataset.dir;
      const current = builder.pointBuyValues[ability];
      if (dir === 'up' && current < 15) {
        const cost = POINT_BUY_COSTS[current + 1] - POINT_BUY_COSTS[current];
        if (cost <= builder.pointsRemaining) {
          builder.pointBuyValues[ability] = current + 1;
        }
      } else if (dir === 'down' && current > 8) {
        builder.pointBuyValues[ability] = current - 1;
      }
      renderPointBuyPanel();
      renderStatsSummary();
    });
  });
}

function renderRollPanel() {
  const grid = document.getElementById('stat-roll-grid');
  if (!grid) return;

  if (builder.rolledValues.length === 0) {
    grid.innerHTML = '<p class="form-hint">Click the button above to roll your stats.</p>';
    return;
  }

  // Show rolled values and assignment dropdowns
  grid.innerHTML = ABILITY_NAMES.map(ability => {
    const assigned = builder.rolledAssignments[ability];
    const usedValues = Object.values(builder.rolledAssignments);
    const availableIndices = builder.rolledValues
      .map((v, i) => ({ v, i }))
      .filter(({ v, i }) => {
        const usedIdx = Object.values(builder.rolledAssignments);
        // Check if this index is already assigned to another ability
        for (const [ab, aIdx] of Object.entries(builder.rolledAssignments)) {
          if (ab !== ability && aIdx === i) return false;
        }
        return true;
      });

    // For the assignment, we store the index into rolledValues
    return `
      <div class="form-group stat-input">
        <label>${ABILITY_SHORT[ability]}</label>
        <select data-ability="${ability}" class="roll-assign-select">
          <option value="">--</option>
          ${availableIndices.map(({ v, i }) => `<option value="${i}" ${assigned === i ? 'selected' : ''}>${v}</option>`).join('')}
        </select>
      </div>
    `;
  }).join('');

  grid.querySelectorAll('.roll-assign-select').forEach(select => {
    select.addEventListener('change', (e) => {
      const ability = e.target.dataset.ability;
      const idx = e.target.value === '' ? undefined : parseInt(e.target.value);
      if (idx === undefined || isNaN(idx)) {
        delete builder.rolledAssignments[ability];
      } else {
        builder.rolledAssignments[ability] = idx;
      }
      renderRollPanel();
      renderStatsSummary();
    });
  });
}

function renderManualPanel() {
  const grid = document.getElementById('stat-manual-grid');
  if (!grid) return;

  grid.innerHTML = ABILITY_NAMES.map(ability => {
    const val = builder.stats[ability] || 10;
    return `
      <div class="form-group stat-input">
        <label>${ABILITY_SHORT[ability]}</label>
        <input type="number" min="3" max="20" value="${val}" data-ability="${ability}" class="manual-stat-input">
      </div>
    `;
  }).join('');

  grid.querySelectorAll('.manual-stat-input').forEach(input => {
    input.addEventListener('change', (e) => {
      const ability = e.target.dataset.ability;
      let val = parseInt(e.target.value);
      if (isNaN(val)) val = 10;
      val = Math.max(3, Math.min(20, val));
      e.target.value = val;
      builder.stats[ability] = val;
      renderStatsSummary();
    });
  });
}

function rollStats() {
  builder.rolledValues = [];
  builder.rolledAssignments = {};

  for (let i = 0; i < 6; i++) {
    const dice = [1, 2, 3, 4].map(() => Math.floor(Math.random() * 6) + 1);
    dice.sort((a, b) => a - b);
    const total = dice[1] + dice[2] + dice[3]; // drop lowest
    builder.rolledValues.push(total);
  }

  // Brief animation
  const grid = document.getElementById('stat-roll-grid');
  if (grid) {
    grid.classList.add('stat-rolling');
    setTimeout(() => grid.classList.remove('stat-rolling'), 500);
  }

  renderRollPanel();
  renderStatsSummary();
}

// ============================================
// Stats Summary
// ============================================

function getFinalBaseStats() {
  const stats = {};
  switch (builder.statMethod) {
    case 'standard-array':
      ABILITY_NAMES.forEach(a => {
        stats[a] = builder.standardArrayAssignments[a] || 0;
      });
      break;
    case 'point-buy':
      ABILITY_NAMES.forEach(a => {
        stats[a] = builder.pointBuyValues[a] || 8;
      });
      break;
    case 'roll':
      ABILITY_NAMES.forEach(a => {
        const idx = builder.rolledAssignments[a];
        stats[a] = idx !== undefined ? builder.rolledValues[idx] : 0;
      });
      break;
    case 'manual':
      ABILITY_NAMES.forEach(a => {
        stats[a] = builder.stats[a] || 10;
      });
      break;
  }
  return stats;
}

function getFinalStats() {
  const base = getFinalBaseStats();
  const final = {};
  ABILITY_NAMES.forEach(a => {
    final[a] = (base[a] || 0) + (builder.racialBonuses[a] || 0);
  });
  return final;
}

function renderStatsSummary() {
  const container = document.getElementById('final-stats-summary');
  if (!container) return;

  const base = getFinalBaseStats();
  const final = getFinalStats();

  container.innerHTML = ABILITY_NAMES.map(ability => {
    const baseVal = base[ability] || 0;
    const bonus = builder.racialBonuses[ability] || 0;
    const total = final[ability] || 0;
    const mod = calcModifier(total);

    return `
      <div class="stat-final">
        <div class="stat-label">${ABILITY_SHORT[ability]}</div>
        <div class="stat-value">${total || '--'}</div>
        <div class="stat-mod">${total ? modString(mod) : ''}</div>
        ${bonus ? `<div class="stat-bonus">+${bonus} racial</div>` : ''}
      </div>
    `;
  }).join('');

  // Also update racial bonus display
  const racialDisplay = document.getElementById('racial-bonus-display');
  if (racialDisplay) {
    const bonuses = Object.entries(builder.racialBonuses);
    if (bonuses.length > 0) {
      racialDisplay.innerHTML = `<strong>Racial Bonuses:</strong> ${bonuses.map(([a, b]) => `${ABILITY_SHORT[a] || a} +${b}`).join(', ')}`;
    } else {
      racialDisplay.innerHTML = '';
    }
  }

  // Recalculate maxSpells for WIS/INT-based casters
  if (builder.selectedClass) {
    const clsName = builder.selectedClass.name.toLowerCase();
    const casterInfo = CASTER_DATA[clsName];
    if (casterInfo && typeof casterInfo.spells_known === 'string') {
      const match = casterInfo.spells_known.match(/^(\w+)\+(\d+)$/);
      if (match) {
        const abilityKey = match[1] === 'wis' ? 'wisdom' : match[1] === 'int' ? 'intelligence' : match[1];
        const bonus = parseInt(match[2]);
        const abilityMod = calcModifier(final[abilityKey] || 10);
        builder.maxSpells = Math.max(1, abilityMod + bonus);
      }
    }
  }
}

// ============================================
// Abilities Step (Skills + Spells)
// ============================================

function renderAbilitiesStep() {
  renderSkillCheckboxes();
  renderSpellSelectors();
  renderClassFeaturesDisplay();
}

function renderSkillCheckboxes() {
  const container = document.getElementById('skill-checkboxes');
  const hint = document.getElementById('skills-remaining');
  if (!container) return;

  if (builder.availableSkills.length === 0) {
    container.innerHTML = '<p class="form-hint">Select a class first to see available skills.</p>';
    if (hint) hint.textContent = 'Select race and class first';
    return;
  }

  const remaining = builder.maxSkills - builder.selectedSkills.size;
  if (hint) hint.textContent = `Choose ${builder.maxSkills} (${remaining} remaining)`;

  container.innerHTML = builder.availableSkills.map(skill => {
    const checked = builder.selectedSkills.has(skill);
    const disabled = !checked && remaining <= 0;
    return `
      <label class="${disabled ? 'disabled' : ''}">
        <input type="checkbox" value="${escapeHtml(skill)}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''} class="skill-checkbox">
        ${escapeHtml(skill)}
      </label>
    `;
  }).join('');

  container.querySelectorAll('.skill-checkbox').forEach(cb => {
    cb.addEventListener('change', (e) => {
      if (e.target.checked) {
        builder.selectedSkills.add(e.target.value);
      } else {
        builder.selectedSkills.delete(e.target.value);
      }
      renderSkillCheckboxes();
    });
  });
}

async function renderSpellSelectors() {
  const section = document.getElementById('spells-section');
  if (!section) return;

  if (!builder.selectedClass || (!builder.maxCantrips && !builder.maxSpells)) {
    section.classList.add('hidden');
    return;
  }

  section.classList.remove('hidden');
  const classIndex = builder.selectedClass.index;

  // Fetch cantrips and level 1 spells
  try {
    const [cantrips, spells] = await Promise.all([
      builder.maxCantrips > 0 ? getSpellsByClass(classIndex, 0).catch(() => []) : Promise.resolve([]),
      builder.maxSpells > 0 ? getSpellsByClass(classIndex, 1).catch(() => []) : Promise.resolve([]),
    ]);

    // Render cantrips
    const cantripContainer = document.getElementById('cantrip-selector');
    const cantripHint = document.getElementById('cantrips-remaining');
    if (cantripContainer && builder.maxCantrips > 0) {
      const cantripRemaining = builder.maxCantrips - builder.selectedCantrips.size;
      if (cantripHint) cantripHint.textContent = `Choose ${builder.maxCantrips} (${cantripRemaining} remaining)`;

      cantripContainer.innerHTML = cantrips.map(spell => {
        const name = spell.name || spell.index;
        const checked = builder.selectedCantrips.has(name);
        const disabled = !checked && cantripRemaining <= 0;
        return `
          <label class="${disabled ? 'disabled' : ''}">
            <input type="checkbox" value="${escapeHtml(name)}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''} class="cantrip-checkbox">
            ${escapeHtml(name)}
          </label>
        `;
      }).join('');

      cantripContainer.querySelectorAll('.cantrip-checkbox').forEach(cb => {
        cb.addEventListener('change', (e) => {
          if (e.target.checked) {
            builder.selectedCantrips.add(e.target.value);
          } else {
            builder.selectedCantrips.delete(e.target.value);
          }
          renderSpellSelectors();
        });
      });
    }

    // Render level 1 spells
    const spellContainer = document.getElementById('spell-selector');
    const spellHint = document.getElementById('spells-remaining-count');
    if (spellContainer && builder.maxSpells > 0) {
      const spellRemaining = builder.maxSpells - builder.selectedSpells.size;
      if (spellHint) spellHint.textContent = `Choose ${builder.maxSpells} (${spellRemaining} remaining)`;

      spellContainer.innerHTML = spells.map(spell => {
        const name = spell.name || spell.index;
        const checked = builder.selectedSpells.has(name);
        const disabled = !checked && spellRemaining <= 0;
        return `
          <label class="${disabled ? 'disabled' : ''}">
            <input type="checkbox" value="${escapeHtml(name)}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''} class="spell-checkbox">
            ${escapeHtml(name)}
          </label>
        `;
      }).join('');

      spellContainer.querySelectorAll('.spell-checkbox').forEach(cb => {
        cb.addEventListener('change', (e) => {
          if (e.target.checked) {
            builder.selectedSpells.add(e.target.value);
          } else {
            builder.selectedSpells.delete(e.target.value);
          }
          renderSpellSelectors();
        });
      });
    }
  } catch (e) {
    console.error('Failed to load spells:', e);
  }
}

function renderClassFeaturesDisplay() {
  const container = document.getElementById('class-features-display');
  if (!container || !builder.selectedClass) {
    if (container) container.innerHTML = '';
    return;
  }

  const cls = builder.selectedClass;
  const features = [];
  if (cls.saving_throws?.length) {
    features.push(`<strong>Saving Throws:</strong> ${cls.saving_throws.map(s => escapeHtml(typeof s === 'string' ? s : s.name || s)).join(', ')}`);
  }
  if (cls.proficiencies?.length) {
    features.push(`<strong>Proficiencies:</strong> ${cls.proficiencies.map(p => escapeHtml(typeof p === 'string' ? p : p.name || p)).join(', ')}`);
  }

  container.innerHTML = features.length > 0
    ? `<strong>Class Features (Level 1):</strong><br>${features.join('<br>')}`
    : '';
}

// ============================================
// Equipment
// ============================================

function renderEquipmentSection() {
  renderSelectedEquipment();
  renderEquipmentSuggestion();
}

function renderSelectedEquipment() {
  const container = document.getElementById('selected-equipment');
  if (!container) return;

  if (builder.selectedEquipment.length === 0) {
    container.innerHTML = '<p class="form-hint">No equipment selected. Search above or use suggested items.</p>';
    return;
  }

  container.innerHTML = builder.selectedEquipment.map((item, i) => `
    <div class="selected-item">
      <span>${escapeHtml(item.name)}${item.quantity > 1 ? ' x' + item.quantity : ''}</span>
      <button data-idx="${i}" class="remove-equipment-btn">&times;</button>
    </div>
  `).join('');

  container.querySelectorAll('.remove-equipment-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx);
      builder.selectedEquipment.splice(idx, 1);
      renderSelectedEquipment();
    });
  });
}

function renderEquipmentSuggestion() {
  const container = document.getElementById('suggested-equipment');
  if (!container) return;

  if (!builder.selectedClass) {
    container.innerHTML = '<strong>Suggested starting equipment:</strong><br>Select a class to see suggestions.';
    return;
  }

  const clsName = builder.selectedClass.name.toLowerCase();
  const suggested = CLASS_STARTING_EQUIPMENT[clsName] || [];

  if (suggested.length === 0) {
    container.innerHTML = '<strong>Suggested starting equipment:</strong><br>No default suggestions for this class.';
    return;
  }

  container.innerHTML = `
    <strong>Suggested starting equipment (${escapeHtml(builder.selectedClass.name)}):</strong><br>
    ${suggested.map(item => escapeHtml(item)).join(', ')}
    <br><button class="btn-tiny" id="add-suggested-equipment" style="margin-top: 6px;">Add All Suggested</button>
  `;

  document.getElementById('add-suggested-equipment')?.addEventListener('click', () => {
    // Count duplicates
    const counts = {};
    suggested.forEach(item => { counts[item] = (counts[item] || 0) + 1; });
    // Add to equipment, avoiding duplicates if already present
    Object.entries(counts).forEach(([name, qty]) => {
      const existing = builder.selectedEquipment.find(e => e.name === name);
      if (existing) {
        existing.quantity += qty;
      } else {
        builder.selectedEquipment.push({ name, quantity: qty });
      }
    });
    renderSelectedEquipment();
    showNotification('Suggested equipment added!');
  });
}

async function onEquipmentSearch(e) {
  const query = e.target.value.trim().toLowerCase();
  const dropdown = document.getElementById('equipment-search-results');
  if (!dropdown) return;

  if (query.length < 2) {
    dropdown.classList.add('hidden');
    return;
  }

  // Fetch equipment data if not cached
  if (builder.equipmentData.length === 0) {
    try {
      builder.equipmentData = await getEquipment('adventuring-gear');
    } catch (err) {
      console.error('Failed to load equipment:', err);
      return;
    }
  }

  const results = builder.equipmentData.filter(item =>
    (item.name || '').toLowerCase().includes(query)
  ).slice(0, 10);

  if (results.length === 0) {
    dropdown.innerHTML = '<div class="search-result-item" style="opacity:0.5;">No results found</div>';
    dropdown.classList.remove('hidden');
    return;
  }

  dropdown.innerHTML = results.map(item => `
    <div class="search-result-item" data-name="${escapeHtml(item.name)}">
      ${escapeHtml(item.name)}${item.cost ? ` (${item.cost.quantity} ${item.cost.unit})` : ''}
    </div>
  `).join('');
  dropdown.classList.remove('hidden');

  dropdown.querySelectorAll('.search-result-item').forEach(el => {
    el.addEventListener('click', () => {
      const name = el.dataset.name;
      if (!name) return;
      const existing = builder.selectedEquipment.find(e => e.name === name);
      if (existing) {
        existing.quantity++;
      } else {
        builder.selectedEquipment.push({ name, quantity: 1 });
      }
      renderSelectedEquipment();
      dropdown.classList.add('hidden');
      const searchInput = document.getElementById('equipment-search');
      if (searchInput) searchInput.value = '';
    });
  });
}

// ============================================
// Image Upload
// ============================================

function handleImageFile(file) {
  if (!file || !file.type.startsWith('image/')) {
    showNotification('Please select an image file');
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    showNotification('Image must be under 5MB');
    return;
  }

  builder.imageFile = file;
  const preview = document.getElementById('image-preview');
  const placeholder = document.getElementById('image-upload-placeholder');
  const removeBtn = document.getElementById('remove-image-btn');

  if (preview) {
    const reader = new FileReader();
    reader.onload = (e) => {
      preview.src = e.target.result;
      preview.classList.remove('hidden');
    };
    reader.readAsDataURL(file);
  }
  if (placeholder) placeholder.classList.add('hidden');
  if (removeBtn) removeBtn.classList.remove('hidden');
}

function clearImageUpload() {
  builder.imageFile = null;
  const preview = document.getElementById('image-preview');
  const placeholder = document.getElementById('image-upload-placeholder');
  const removeBtn = document.getElementById('remove-image-btn');
  const fileInput = document.getElementById('builder-image');

  if (preview) { preview.src = ''; preview.classList.add('hidden'); }
  if (placeholder) placeholder.classList.remove('hidden');
  if (removeBtn) removeBtn.classList.add('hidden');
  if (fileInput) fileInput.value = '';
}

// ============================================
// AI Assistance
// ============================================

async function generateAIAppearance() {
  const btn = document.getElementById('ai-help-appearance');
  const textarea = document.getElementById('builder-appearance');
  if (!btn || !textarea) return;

  if (textarea.value.trim() && !confirm('This will replace the current appearance text. Continue?')) return;

  btn.classList.add('loading');
  btn.textContent = 'Generating...';
  btn.disabled = true;

  try {
    const result = await api('/api/characters/ai-assist', 'POST', {
      field: 'appearance',
      context: {
        character_name: document.getElementById('builder-char-name')?.value || '',
        race: builder.selectedRace?.name || '',
        class: builder.selectedClass?.name || '',
        background: builder.selectedBackground?.name || '',
      }
    });
    textarea.value = result.text || '';
  } catch (e) {
    showNotification('AI generation failed: ' + e.message);
  } finally {
    btn.classList.remove('loading');
    btn.textContent = 'AI Help';
    btn.disabled = false;
  }
}

async function generateAIBackstory() {
  const btn = document.getElementById('ai-help-backstory');
  const textarea = document.getElementById('builder-backstory');
  if (!btn || !textarea) return;

  if (textarea.value.trim() && !confirm('This will replace the current backstory text. Continue?')) return;

  btn.classList.add('loading');
  btn.textContent = 'Generating...';
  btn.disabled = true;

  try {
    const result = await api('/api/characters/ai-assist', 'POST', {
      field: 'backstory',
      context: {
        character_name: document.getElementById('builder-char-name')?.value || '',
        race: builder.selectedRace?.name || '',
        class: builder.selectedClass?.name || '',
        background: builder.selectedBackground?.name || '',
      }
    });
    textarea.value = result.text || '';
  } catch (e) {
    showNotification('AI generation failed: ' + e.message);
  } finally {
    btn.classList.remove('loading');
    btn.textContent = 'AI Help';
    btn.disabled = false;
  }
}

// ============================================
// Spell Slots Helper
// ============================================

function getStartingSpellSlots() {
  if (!builder.selectedClass?.is_caster) return {};
  const cls = builder.selectedClass.name.toLowerCase();
  if (['wizard', 'cleric', 'druid', 'bard', 'sorcerer'].includes(cls)) {
    return { '1': { current: 2, max: 2 } };
  }
  if (cls === 'warlock') return { '1': { current: 1, max: 1 } };
  return {};
}

// ============================================
// Save New Character
// ============================================

export async function saveNewCharacter() {
  const charName = document.getElementById('builder-char-name')?.value.trim();
  if (!charName) {
    showNotification('Please enter a character name');
    return;
  }
  if (!builder.selectedRace) {
    showNotification('Please select a race');
    return;
  }
  if (!builder.selectedClass) {
    showNotification('Please select a class');
    return;
  }

  const stats = getFinalStats();
  const hitDie = builder.selectedClass?.hit_die || 10;
  const conMod = calcModifier(stats.constitution);
  const hp = hitDie + conMod;
  const dexMod = calcModifier(stats.dexterity);
  const ac = 10 + dexMod;

  const payload = {
    player_name: document.getElementById('builder-player-name')?.value.trim() || 'Player',
    character_name: charName,
    race: builder.selectedRace?.name || '',
    class: builder.selectedClass?.name || '',
    classes: JSON.stringify({ [builder.selectedClass?.name || 'Fighter']: 1 }),
    strength: stats.strength,
    dexterity: stats.dexterity,
    constitution: stats.constitution,
    intelligence: stats.intelligence,
    wisdom: stats.wisdom,
    charisma: stats.charisma,
    hp,
    max_hp: hp,
    ac,
    background: builder.selectedBackground?.name || document.getElementById('builder-background')?.value || '',
    skills: [...builder.selectedSkills].join(', '),
    spells: [...builder.selectedCantrips, ...builder.selectedSpells].join(', '),
    passives: `Passive Perception: ${10 + calcModifier(stats.wisdom)}`,
    class_features: '',
    feats: '',
    appearance: document.getElementById('builder-appearance')?.value.trim() || '',
    backstory: document.getElementById('builder-backstory')?.value.trim() || '',
    gold: parseInt(document.getElementById('builder-gold')?.value) || 0,
    inventory: JSON.stringify(builder.selectedEquipment),
    spell_slots: JSON.stringify(getStartingSpellSlots()),
  };

  try {
    const character = await api('/api/characters', 'POST', payload);

    // Upload image if selected (raw fetch, not api() wrapper)
    if (builder.imageFile) {
      const formData = new FormData();
      formData.append('image', builder.imageFile);
      await fetch(`/api/characters/${character.id}/image`, {
        method: 'POST',
        headers: { 'X-Admin-Password': getState('adminPassword') || '' },
        body: formData
      });
    }

    loadCharacters();
    resetBuilder();
    showNotification(`${payload.character_name} created!`);
  } catch (e) {
    alert('Failed to create character: ' + e.message);
  }
}

// ============================================
// Reset Builder
// ============================================

export function resetBuilder() {
  builder.step = 0;
  builder.selectedRace = null;
  builder.selectedClass = null;
  builder.selectedBackground = null;
  builder.statMethod = 'standard-array';
  builder.stats = { strength: 10, dexterity: 10, constitution: 10, intelligence: 10, wisdom: 10, charisma: 10 };
  builder.racialBonuses = {};
  builder.selectedSkills = new Set();
  builder.maxSkills = 2;
  builder.availableSkills = [];
  builder.selectedCantrips = new Set();
  builder.maxCantrips = 0;
  builder.selectedSpells = new Set();
  builder.maxSpells = 0;
  builder.selectedEquipment = [];
  builder.imageFile = null;
  builder.standardArrayRemaining = [...STANDARD_ARRAY];
  builder.standardArrayAssignments = {};
  builder.pointBuyValues = { strength: 8, dexterity: 8, constitution: 8, intelligence: 8, wisdom: 8, charisma: 8 };
  builder.pointsRemaining = POINT_BUY_TOTAL;
  builder.rolledValues = [];
  builder.rolledAssignments = {};
  builder.equipmentData = [];

  // Reset form fields
  const fields = ['builder-player-name', 'builder-char-name', 'builder-appearance', 'builder-backstory'];
  fields.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });

  const goldInput = document.getElementById('builder-gold');
  if (goldInput) goldInput.value = '10';

  // Reset selects
  ['builder-race', 'builder-class', 'builder-background'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.selectedIndex = 0;
  });

  // Clear image
  clearImageUpload();

  // Clear info panels
  ['race-info', 'class-info', 'racial-bonus-display', 'final-stats-summary', 'class-features-display'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '';
  });

  // Reset stat method
  document.querySelectorAll('.stat-method-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.method === 'standard-array');
  });
  document.querySelectorAll('.stat-method-panel').forEach(panel => panel.classList.remove('active'));
  document.getElementById('stat-standard-array')?.classList.add('active');

  // Reset spells section
  const spellsSection = document.getElementById('spells-section');
  if (spellsSection) spellsSection.classList.add('hidden');

  // Reset navigation to step 0
  switchBuilderStep(0);
}
