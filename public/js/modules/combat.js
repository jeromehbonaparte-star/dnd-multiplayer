// ============================================
// Narrative Turn-Based Combat (NTC)
// - Compact initiative tracker (replaces the tactical grid board)
// - Action-bar mode helpers (initiative roll / your turn / waiting)
// - Combat beats rendered into the story stream
// The story stream stays visible during a fight: combat IS text.
// ============================================

import { api } from '../api.js';
import { getState, setState } from '../state.js';
import { showNotification } from '../utils/dom.js';
import { escapeHtml, formatContent } from '../utils/formatters.js';

const OUTCOME_MESSAGES = {
  victory: 'Victory!',
  defeat: 'Defeat...',
  resolved: 'The fight is over.'
};

const MAX_PIPS = 8;
const SWORDS = '⚔';

// Phones open the tracker collapsed (chip strip only) so the story stream keeps
// the screen. `renderCombatTracker` rebuilds `panel.innerHTML` on every socket
// update, so the flag has to live outside the DOM. Desktop ignores it entirely.
let trackerCollapsed = true;

// ============================================
// State access + normalization
// ============================================

/**
 * REST (`GET /api/sessions/:id`) wraps the public combat state in the combats-row
 * envelope; sockets send the public state directly. Everything downstream works
 * on the bare public state, so both shapes funnel through here.
 * @returns {Object|null} public combat state, or null when there is no fight
 */
export function normalizeCombatState(input) {
  if (!input || typeof input !== 'object') return null;
  if (Array.isArray(input.units)) return input;
  if (input.state && typeof input.state === 'object' && Array.isArray(input.state.units)) return input.state;
  return null;
}

/** The active public combat state, or null. */
export function getCombatState() {
  return getState('activeCombat') || null;
}

function selectedCharacterId() {
  return document.getElementById('action-character')?.value || '';
}

function findCharacter(characterId) {
  if (!characterId) return null;
  const sessionChars = getState('sessionCharacters') || [];
  const allChars = getState('characters') || [];
  return sessionChars.find(c => c.id === characterId) || allChars.find(c => c.id === characterId) || null;
}

/** Same ownership rule the story action bar uses: admins act for anyone. */
function controlsCharacter(character) {
  const user = getState('currentUser');
  if (!character || !user) return false;
  return !!(user.is_admin || character.user_id === user.id || !character.user_id);
}

function findPartyUnit(state, characterId) {
  if (!state || !characterId) return null;
  return state.units.find(unit => unit.side === 'party' && String(unit.sourceCharacterId) === String(characterId)) || null;
}

function findUnit(state, unitId) {
  if (!state || !unitId) return null;
  return state.units.find(unit => unit.id === unitId) || null;
}

/**
 * Action-bar mode for the currently selected character.
 * @returns {{active:boolean, mode:'story'|'initiative'|'turn'|'waiting', banner:string,
 *            characterId?:string, unit?:Object, currentUnit?:Object, version?:number,
 *            phase?:string, round?:number}}
 */
export function getCombatActionMode() {
  const state = getCombatState();
  if (!state) return { active: false, mode: 'story', banner: '' };

  const characterId = selectedCharacterId();
  const unit = findPartyUnit(state, characterId);
  const controls = controlsCharacter(findCharacter(characterId));
  const currentUnit = findUnit(state, state.currentUnitId);
  const base = {
    active: true,
    characterId,
    unit,
    currentUnit,
    version: Number.isInteger(state.version) ? state.version : undefined,
    phase: state.phase,
    round: Number(state.round) || 1
  };

  if (state.phase === 'initiative') {
    const pendingIds = Array.isArray(state.pendingInitiative) ? state.pendingInitiative : [];
    if (unit && controls && pendingIds.includes(unit.id)) {
      return { ...base, mode: 'initiative', banner: `Roll for initiative as ${unit.name} — the DM adds your DEX bonus.` };
    }
    const waiting = pendingIds.map(id => findUnit(state, id)).filter(Boolean).map(candidate => candidate.name);
    return {
      ...base,
      mode: 'waiting',
      banner: waiting.length
        ? `Rolling initiative — waiting on ${waiting.join(', ')}.`
        : 'Initiative is locking in...'
    };
  }

  if (unit && controls && state.currentUnitId === unit.id && !unit.down) {
    return {
      ...base,
      mode: 'turn',
      banner: `Your turn — Round ${base.round} — AP ${unit.ap}/${unit.apMax} · BP ${unit.bp}/${unit.bpMax}`
    };
  }

  return {
    ...base,
    mode: 'waiting',
    banner: currentUnit
      ? `Waiting: ${currentUnit.name}'s turn (Round ${base.round}).`
      : `Round ${base.round} — the encounter is resolving...`
  };
}

// ============================================
// Tracker rendering
// ============================================

/** Blocks attribute breakout: no quotes/whitespace, path- or http(s)-rooted only. */
function safeImageUrl(url) {
  const value = String(url || '').trim();
  if (!value || /["'<>\\\s]/.test(value)) return '';
  if (/^\/[^/]/.test(value)) return value;
  return /^https?:\/\//i.test(value) ? value : '';
}

function initials(name) {
  return String(name || '?').trim().slice(0, 2).toUpperCase();
}

function healthPercent(unit) {
  return Math.max(0, Math.min(100, Math.round((Number(unit.hp) || 0) / Math.max(1, Number(unit.maxHp) || 1) * 100)));
}

function renderPips(current, max) {
  const total = Math.min(MAX_PIPS, Math.max(0, Number(max) || 0));
  if (!total) return '';
  let html = '';
  for (let index = 0; index < total; index++) {
    html += `<span class="combat-pip${index < (Number(current) || 0) ? ' filled' : ''}"></span>`;
  }
  return html;
}

function renderConditions(unit) {
  const conditions = Array.isArray(unit.conditions) ? unit.conditions : [];
  if (!conditions.length) return '';
  return `<div class="combat-unit-conditions">${conditions
    .slice(0, 6)
    .map(condition => `<span class="combat-condition-chip">${escapeHtml(String(condition))}</span>`)
    .join('')}</div>`;
}

function orderedUnits(state) {
  const turnOrder = Array.isArray(state.turnOrder) ? state.turnOrder : [];
  if (state.phase === 'active' && turnOrder.length) {
    const ordered = turnOrder.map(id => findUnit(state, id)).filter(Boolean);
    const extras = state.units.filter(unit => !turnOrder.includes(unit.id));
    return [...ordered, ...extras];
  }
  return [...state.units].sort((left, right) => {
    const leftValue = left.initiative == null ? -Infinity : Number(left.initiative);
    const rightValue = right.initiative == null ? -Infinity : Number(right.initiative);
    return rightValue - leftValue;
  });
}

function renderUnitRow(state, unit, position) {
  const acting = state.currentUnitId === unit.id;
  const image = safeImageUrl(unit.imageUrl);
  const classes = [
    'combat-unit',
    unit.side === 'enemy' ? 'enemy' : 'party',
    acting ? 'acting' : '',
    unit.down ? 'down' : ''
  ].filter(Boolean).join(' ');
  const initiative = unit.initiative == null ? '--' : String(unit.initiative);
  const points = acting && (unit.apMax || unit.bpMax)
    ? `<div class="combat-unit-points" title="Action points / bonus points">
        <span class="combat-point-group"><em>AP</em>${renderPips(unit.ap, unit.apMax)}</span>
        <span class="combat-point-group"><em>BP</em>${renderPips(unit.bp, unit.bpMax)}</span>
      </div>`
    : '';

  return `
    <li class="${classes}">
      <span class="combat-unit-slot">${position}</span>
      <span class="combat-unit-avatar"${image ? ` style="background-image:url('${image}')"` : ''} aria-hidden="true">${image ? '' : escapeHtml(initials(unit.name))}</span>
      <div class="combat-unit-main">
        <div class="combat-unit-line">
          <span class="combat-unit-name">${unit.down ? '☠ ' : ''}${escapeHtml(unit.name)}</span>
          <span class="combat-unit-numbers">
            <span class="combat-unit-init" title="Initiative">INIT ${escapeHtml(initiative)}</span>
            <span class="combat-unit-ac" title="Armor class">AC ${escapeHtml(String(unit.ac))}</span>
            <span class="combat-unit-hp-text" title="Hit points">${escapeHtml(String(unit.hp))}/${escapeHtml(String(unit.maxHp))}</span>
          </span>
        </div>
        <span class="combat-hp-bar"><span style="width:${healthPercent(unit)}%"></span></span>
        ${renderConditions(unit)}
        ${points}
      </div>
    </li>`;
}

function renderGmControls(state) {
  if (!getState('currentUser')?.is_admin) return '';
  const rollRemaining = state.phase === 'initiative'
    ? '<button type="button" onclick="rollRemainingInitiative()">Roll Remaining</button>'
    : '';
  return `<div class="combat-gm-actions">${rollRemaining}<button type="button" class="combat-end-btn" onclick="endEncounter()">End Encounter</button></div>`;
}

/** Unit ids that still owe a d20 — empty outside the initiative phase. */
function pendingInitiativeIds(state) {
  if (state.phase !== 'initiative' || !Array.isArray(state.pendingInitiative)) return [];
  return state.pendingInitiative;
}

function renderPendingInitiative(state) {
  if (state.phase !== 'initiative') return '';
  const pendingIds = pendingInitiativeIds(state);
  const pending = pendingIds.map(id => findUnit(state, id)).filter(Boolean);
  const rolled = state.units.filter(unit => unit.side === 'party' && unit.initiative != null);
  return `
    <div class="combat-initiative-strip">
      <span class="combat-strip-label">Still rolling</span>
      ${pending.length
        ? pending.map(unit => `<span class="initiative-chip party">${escapeHtml(unit.name)}</span>`).join('')
        : '<span class="combat-strip-empty">everyone has rolled</span>'}
      ${rolled.length
        ? `<span class="combat-strip-label">Rolled</span>${rolled.map(unit => `<span class="initiative-chip party rolled">${escapeHtml(unit.name)} ${escapeHtml(String(unit.initiative))}</span>`).join('')}`
        : ''}
    </div>`;
}

/**
 * Turn order as a single scrollable row of chips. Always built; only the mobile
 * collapsed panel shows it, so it has to stay cheap.
 */
function renderChipStrip(state) {
  const pendingIds = pendingInitiativeIds(state);
  const chips = orderedUnits(state).map(unit => {
    const image = safeImageUrl(unit.imageUrl);
    const waiting = pendingIds.includes(unit.id);
    const classes = [
      'combat-chip',
      unit.side === 'enemy' ? 'enemy' : 'party',
      state.currentUnitId === unit.id ? 'acting' : '',
      unit.down ? 'down' : '',
      waiting ? 'waiting' : ''
    ].filter(Boolean).join(' ');
    const name = String(unit.name || '?');
    const short = name.trim().split(/\s+/)[0] || '?';
    return `
      <span class="${classes}" title="${escapeHtml(name)}">
        <span class="combat-chip-avatar"${image ? ` style="background-image:url('${image}')"` : ''} aria-hidden="true">${image ? '' : escapeHtml(initials(name))}</span>
        <span class="combat-chip-name">${unit.down ? '☠ ' : ''}${escapeHtml(short)}</span>
        ${waiting ? '<span class="combat-chip-init">--</span>' : ''}
        <span class="combat-chip-hp"><span style="width:${healthPercent(unit)}%"></span></span>
      </span>`;
  }).join('');
  return `<div class="combat-chip-strip" aria-label="Turn order">${chips}</div>`;
}

function renderTrackerToggle() {
  const label = trackerCollapsed ? 'Show the full initiative tracker' : 'Collapse the initiative tracker';
  return `<button type="button" class="combat-tracker-toggle" onclick="toggleCombatTracker()" aria-expanded="${trackerCollapsed ? 'false' : 'true'}" aria-label="${label}" title="${label}">${trackerCollapsed ? '▾' : '▴'}</button>`;
}

function buildTrackerHtml(state) {
  const phaseLabel = state.phase === 'initiative' ? 'Initiative' : 'Round ' + (Number(state.round) || 1);
  const acting = findUnit(state, state.currentUnitId);
  const pendingCount = pendingInitiativeIds(state).length;
  // Collapsed panels hide the "Still rolling" strip, so the count rides the status line.
  const status = state.phase === 'initiative'
    ? `Everyone rolls a d20${pendingCount ? ` (${pendingCount} waiting)` : ''}`
    : acting
      ? `${acting.name} is acting`
      : 'Resolving...';

  return `
    <div class="combat-tracker-head">
      <div class="combat-tracker-title">
        <span class="combat-eyebrow">Encounter</span>
        <h2>${escapeHtml(state.name || 'Encounter')}</h2>
        ${state.environment ? `<span class="combat-environment">${escapeHtml(state.environment)}</span>` : ''}
      </div>
      <div class="combat-tracker-meta" aria-live="polite">
        <span class="combat-phase-badge ${state.phase === 'initiative' ? 'phase-initiative' : 'phase-active'}">${escapeHtml(phaseLabel)}</span>
        <span class="combat-tracker-status">${escapeHtml(status)}</span>
      </div>
      ${renderTrackerToggle()}
      ${renderGmControls(state)}
    </div>
    ${renderChipStrip(state)}
    ${renderPendingInitiative(state)}
    <ol class="combat-unit-list">
      ${orderedUnits(state).map((unit, index) => renderUnitRow(state, unit, index + 1)).join('')}
    </ol>`;
}

/** Mobile collapse toggle; a no-op when there is no fight to re-render. */
export function toggleCombatTracker() {
  const state = getCombatState();
  if (!state) return;
  trackerCollapsed = !trackerCollapsed;
  const panel = document.getElementById('combat-tracker-panel');
  if (!panel) return;
  panel.classList.toggle('collapsed', trackerCollapsed);
  panel.innerHTML = buildTrackerHtml(state);
}

/**
 * Render the tracker from either shape (REST envelope or bare public state) and
 * store the normalized public state in `activeCombat`. Passing null tears the
 * tracker down and hands the action bar back to the story flow.
 */
export function renderCombatTracker(input) {
  const state = normalizeCombatState(input);
  const previous = getCombatState();
  // A slow `GET /api/sessions/:id` must never overwrite a newer socket update.
  // Teardown (null) always wins; the server 409s a second concurrent encounter,
  // so a lower version can only mean an out-of-order view of the same fight.
  if (state && previous
    && Number.isInteger(previous.version) && Number.isInteger(state.version)
    && state.version < previous.version) {
    refreshActionBar();
    return;
  }
  setState({ activeCombat: state });
  document.querySelector('.story-main')?.classList.toggle('combat-mode-active', !!state);

  const panel = document.getElementById('combat-tracker-panel');
  if (panel) {
    if (state) {
      panel.hidden = false;
      panel.classList.toggle('collapsed', trackerCollapsed);
      panel.innerHTML = buildTrackerHtml(state);
    } else {
      panel.hidden = true;
      panel.innerHTML = '';
    }
  }
  refreshActionBar();
}

/** sessions.js owns the action bar; imported lazily to avoid an import cycle. */
function refreshActionBar() {
  import('./sessions.js')
    .then(module => module.updateActionFormState())
    .catch(() => {});
}

// ============================================
// Combat beats in the story stream
// ============================================

/**
 * The compact story view only renders `.active-scene-entry`, and the Logs /
 * Expand buttons live inside whichever entry holds the stage. A combat beat on
 * the stage therefore has to carry them too.
 */
function stageControls() {
  const container = document.getElementById('story-container');
  const logsOpen = !!container?.classList.contains('logs-open');
  const expanded = !!container?.classList.contains('story-expanded');
  return `
    <button class="story-logs-btn" onclick="toggleStoryLogs(this)" title="Show or hide story logs">${logsOpen ? 'Close Logs' : 'Logs'}</button>
    <button class="story-expand-btn" onclick="toggleStoryExpand(this)" aria-expanded="${expanded ? 'true' : 'false'}" title="${expanded ? 'Restore the compact story window' : 'Expand the story window'}">${expanded ? 'Restore' : 'Expand'}</button>`;
}

function combatBeatHtml({ unitName, content, round, warnings = [], globalIndex = null, live = false, active = false }) {
  const heading = unitName
    ? `${SWORDS} ${escapeHtml(unitName)} — Round ${escapeHtml(String(round))}`
    : `${SWORDS} Combat — Round ${escapeHtml(String(round))}`;
  const warningHtml = warnings.length
    ? `<div class="combat-beat-warnings">${warnings.map(warning => escapeHtml(String(warning))).join(' · ')}</div>`
    : '';
  const deleteBtn = globalIndex == null
    ? ''
    : `<button class="delete-msg-btn" onclick="deleteStoryMessage(${globalIndex})" title="Delete this beat">🗑️</button>`;
  const classes = ['story-entry', 'combat-beat'];
  if (active) classes.push('active-scene-entry');
  if (live) classes.push('combat-beat-live');
  return `
    <div class="${classes.join(' ')}"${globalIndex == null ? '' : ` data-index="${globalIndex}"`}>
      <div class="combat-beat-header">
        <span class="combat-beat-title">${heading}</span>
        <div class="combat-beat-controls">${active ? stageControls() : ''}${deleteBtn}</div>
      </div>
      <div class="content">${formatContent(content)}</div>
      ${warningHtml}
    </div>`;
}

/** History rendering for `{type:'combat_turn'}` entries (see renderStoryHistory). */
export function renderCombatHistoryEntry(entry, globalIndex, active = false) {
  return combatBeatHtml({
    unitName: entry?.unitName || '',
    content: entry?.content || '',
    round: Number(entry?.round) || 1,
    globalIndex,
    active
  });
}

/** Live append from the `combat_turn_narration` socket event. */
export function appendCombatBeat({ unitName, narration, round, warnings } = {}) {
  const historyContainer = document.getElementById('story-history');
  if (!historyContainer) return;
  // The newest beat takes the stage, exactly like a fresh narration does.
  historyContainer.querySelectorAll('.active-scene-entry').forEach(entry => entry.classList.remove('active-scene-entry'));
  const wrapper = document.createElement('div');
  wrapper.innerHTML = combatBeatHtml({
    unitName: unitName || '',
    content: narration || '',
    round: Number(round) || 1,
    warnings: Array.isArray(warnings) ? warnings : [],
    live: true,
    active: true
  });
  while (wrapper.firstElementChild) historyContainer.appendChild(wrapper.firstElementChild);
  const container = document.getElementById('story-container');
  if (container) container.scrollTop = container.scrollHeight;
}

// ============================================
// Socket + error plumbing
// ============================================

/**
 * `combat_updated` handler. A null `combat` means the fight is over: tear the
 * tracker down and toast the outcome.
 */
export function handleCombatUpdate(payload = {}) {
  const { sessionId, combat, automatic, outcome } = payload;
  if (getState('currentSession')?.id !== sessionId) return;

  const next = normalizeCombatState(combat);
  const previous = getCombatState();
  // Out-of-order socket delivery must never roll the tracker backwards.
  if (next && previous
    && Number.isInteger(previous.version) && Number.isInteger(next.version)
    && next.version < previous.version) return;

  renderCombatTracker(next);

  if (!next) {
    if (previous) showNotification(OUTCOME_MESSAGES[outcome] || OUTCOME_MESSAGES.resolved);
    return;
  }
  if (automatic && !previous) showNotification(`${SWORDS} ${next.name} — roll for initiative!`);
}

/**
 * Shared failure path for every combat POST. 409 responses may carry fresh
 * state (or null once the fight ended) — re-render from it so the player is
 * never left looking at a stale tracker.
 * @returns {{status:number|undefined, retryable:boolean}} retryable → keep the typed action
 */
export function handleCombatApiError(error, fallback = 'Combat action failed.') {
  const status = error?.status;
  const data = error?.data;
  if (status === 404) {
    renderCombatTracker(null);
  } else if (data && Object.prototype.hasOwnProperty.call(data, 'combat')) {
    renderCombatTracker(data.combat);
  }
  showNotification(error?.message || fallback);
  return { status, retryable: status === 502 };
}

// ============================================
// Player actions
// ============================================

/** POST the d20 the player rolled for initiative. */
export async function postInitiativeRoll(characterId, roll) {
  const session = getState('currentSession');
  if (!session) throw new Error('Select a session first.');
  const result = await api(`/api/sessions/${session.id}/combat/initiative`, 'POST', {
    roll,
    ...(characterId ? { characterId } : {})
  });
  renderCombatTracker(result.combat || null);
  return result;
}

/** POST a freeform combat action (with its [DICE ROLL] appendix) for adjudication. */
export async function postCombatTurnAction(characterId, action, version) {
  const session = getState('currentSession');
  if (!session) throw new Error('Select a session first.');
  const result = await api(`/api/sessions/${session.id}/combat/turn-action`, 'POST', {
    action,
    ...(characterId ? { characterId } : {}),
    ...(Number.isInteger(version) ? { version } : {})
  });
  renderCombatTracker(result.combat || null);
  return result;
}

/** POST a voluntary end of turn — no action text, no narration, no dice. */
export async function postCombatEndTurn(characterId, version) {
  const session = getState('currentSession');
  if (!session) throw new Error('Select a session first.');
  const result = await api(`/api/sessions/${session.id}/combat/end-turn`, 'POST', {
    ...(characterId ? { characterId } : {}),
    ...(Number.isInteger(version) ? { version } : {})
  });
  renderCombatTracker(result.combat || null);
  return result;
}

// ============================================
// GM controls
// ============================================

export async function rollRemainingInitiative() {
  const session = getState('currentSession');
  if (!session) return;
  try {
    const result = await api(`/api/sessions/${session.id}/combat/roll-remaining`, 'POST');
    renderCombatTracker(result.combat || null);
    showNotification(result.rolled ? `Rolled initiative for ${result.rolled} combatant(s).` : 'Everyone had already rolled.');
  } catch (error) {
    handleCombatApiError(error, 'Unable to roll the remaining initiative.');
  }
}

export async function endEncounter() {
  const session = getState('currentSession');
  if (!session || !window.confirm('End this encounter? The DM will narrate the aftermath.')) return;
  try {
    const result = await api(`/api/sessions/${session.id}/combat/end`, 'POST');
    renderCombatTracker(null);
    showNotification(OUTCOME_MESSAGES[result?.outcome] || OUTCOME_MESSAGES.resolved);
  } catch (error) {
    handleCombatApiError(error, 'Unable to end the encounter.');
  }
}

// ============================================
// GM encounter setup
// ============================================

export function openCombatSetup() {
  if (!getState('currentSession')) return showNotification('Select a session first.');
  document.getElementById('combat-setup-modal')?.classList.add('active');
  const status = document.getElementById('combat-setup-status');
  if (status) status.textContent = '';
}

export function closeCombatSetup() {
  document.getElementById('combat-setup-modal')?.classList.remove('active');
}

/** `Name | hp | ac | attackBonus | damageDie | damageBonus`, one enemy per line. */
function parseEnemies(value) {
  return String(value || '').split('\n').map((line, index) => {
    const [name, hp, ac, attackBonus, damageDie, damageBonus] = line.split('|').map(part => part.trim());
    return name
      ? {
        id: String(index + 1),
        name,
        hp: Number(hp),
        ac: Number(ac),
        attackBonus: Number(attackBonus),
        damageDie: Number(damageDie),
        damageBonus: Number(damageBonus)
      }
      : null;
  }).filter(Boolean);
}

export async function startEncounter() {
  const session = getState('currentSession');
  if (!session) return;
  const enemies = parseEnemies(document.getElementById('combat-enemies')?.value);
  const status = document.getElementById('combat-setup-status');
  const button = document.getElementById('start-combat-btn');
  if (!enemies.length) {
    if (status) status.textContent = 'Add at least one enemy.';
    return;
  }
  if (button) button.disabled = true;
  try {
    const result = await api(`/api/sessions/${session.id}/combat`, 'POST', {
      name: document.getElementById('combat-name')?.value || '',
      environment: document.getElementById('combat-environment')?.value || '',
      enemies
    });
    closeCombatSetup();
    renderCombatTracker(result.combat);
    showNotification(`${SWORDS} Encounter started — everyone rolls for initiative.`);
  } catch (error) {
    if (status) status.textContent = error.message || 'Unable to start the encounter.';
  } finally {
    if (button) button.disabled = false;
  }
}
