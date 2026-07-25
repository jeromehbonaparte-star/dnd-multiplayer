import { api } from '../api.js';
import { getState, setState } from '../state.js';
import { showNotification } from '../utils/dom.js';
import { escapeHtml } from '../utils/formatters.js';

const TERRAIN_COST = { plains: 1, forest: 2, ruins: 1, water: 99, wall: 99 };
let actionMode = 'idle';
let selectedPowerId = null;
let modeVersion = null;
let actionPending = false;
const queuedVersions = new Set();

function unitAt(state, x, y) {
  return state.units.find(unit => unit.hp > 0 && unit.x === x && unit.y === y) || null;
}

function isOwnedActiveUnit(unit) {
  const user = getState('currentUser');
  return !!unit && unit.side === 'party' && !!user && (user.is_admin || unit.sourceCharacterId && getState('sessionCharacters').some(character => character.id === unit.sourceCharacterId && character.user_id === user.id));
}

function reachableTiles(state, unit) {
  const queue = [{ x: unit.x, y: unit.y, cost: 0 }];
  const found = new Map([[`${unit.x},${unit.y}`, 0]]);
  const occupied = new Set(state.units.filter(other => other.hp > 0 && other.id !== unit.id).map(other => `${other.x},${other.y}`));
  while (queue.length) {
    const current = queue.shift();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = current.x + dx;
      const y = current.y + dy;
      if (x < 0 || y < 0 || x >= state.grid.width || y >= state.grid.height || occupied.has(`${x},${y}`)) continue;
      const cost = current.cost + (TERRAIN_COST[state.grid.tiles[y][x]] || 1);
      const key = `${x},${y}`;
      if (cost > unit.movement || found.has(key)) continue;
      found.set(key, cost);
      queue.push({ x, y, cost });
    }
  }
  return new Set(found.keys());
}

function currentUnit(state) {
  return state.units.find(unit => unit.id === state.turnOrder[state.turnIndex]) || null;
}

function powerReady(unit, power) {
  if (power.slotLevel > 0 && Number(unit.spellSlots?.[power.slotLevel]?.current || 0) <= 0) return false;
  return power.maxUses == null || Number(unit.powerUses?.[power.id] || 0) < power.maxUses;
}

function selectedPower(unit) {
  return unit?.powers?.find(power => power.id === selectedPowerId) || null;
}

function healthBar(unit) {
  const width = Math.max(0, Math.min(100, Math.round((unit.hp / Math.max(1, unit.maxHp)) * 100)));
  return `<span class="tactical-unit-hp"><span style="width:${width}%"></span></span>`;
}

function renderInitiative(state) {
  return state.turnOrder.map(id => {
    const unit = state.units.find(candidate => candidate.id === id);
    if (!unit) return '';
    return `<span class="initiative-chip ${unit.id === state.turnOrder[state.turnIndex] ? 'active' : ''} ${unit.side}">${escapeHtml(unit.name)}</span>`;
  }).join('');
}

export function renderTacticalCombat(combat) {
  const panel = document.getElementById('tactical-combat-panel');
  if (!panel) return;
  document.querySelector('.story-main')?.classList.toggle('combat-mode-active', !!combat?.state);
  setState({ activeCombat: combat || null });
  if (!combat?.state) {
    panel.hidden = true;
    panel.innerHTML = '';
    actionMode = 'idle';
    selectedPowerId = null;
    modeVersion = null;
    return;
  }
  const { state } = combat;
  if (modeVersion !== state.version) {
    actionMode = 'idle';
    selectedPowerId = null;
    modeVersion = state.version;
  }
  panel.hidden = false;
  const unit = currentUnit(state);
  const controllable = isOwnedActiveUnit(unit) && !state.outcome;
  const canMove = controllable && !unit.hasMoved && !unit.hasActed;
  const canAct = controllable && !unit.hasActed;
  const power = selectedPower(unit);
  const moves = actionMode === 'move' && canMove ? reachableTiles(state, unit) : new Set();
  const targets = new Set(actionMode === 'attack' && canAct
    ? state.units.filter(candidate => candidate.side === 'enemy' && candidate.hp > 0 && Math.abs(candidate.x - unit.x) + Math.abs(candidate.y - unit.y) <= unit.range).map(candidate => candidate.id)
    : []);
  const powerTargets = new Set(actionMode === 'power' && canAct && power
    ? state.units.filter(candidate => candidate.side === (power.kind === 'attack' ? 'enemy' : 'party') && candidate.hp > 0 && Math.abs(candidate.x - unit.x) + Math.abs(candidate.y - unit.y) <= power.range).map(candidate => candidate.id)
    : []);
  const board = state.grid.tiles.map((row, y) => row.map((terrain, x) => {
    const occupant = unitAt(state, x, y);
    const isMove = moves.has(`${x},${y}`);
    const isTarget = occupant && (targets.has(occupant.id) || powerTargets.has(occupant.id));
    const unitHtml = occupant
      ? `<span class="tactical-token ${occupant.side} ${occupant.id === unit?.id ? 'active' : ''}" data-unit-id="${escapeHtml(occupant.id)}" title="${escapeHtml(`${occupant.name}: ${occupant.hp}/${occupant.maxHp} HP, AC ${occupant.ac}`)}"${occupant.imageUrl ? ` style="--token-image:url(&quot;${escapeHtml(occupant.imageUrl)}&quot;)"` : ''}><span class="tactical-token-name">${escapeHtml(occupant.name.slice(0, 2).toUpperCase())}</span>${healthBar(occupant)}</span>`
      : '';
    return `<button class="tactical-tile terrain-${terrain} ${isMove ? 'move-target' : ''} ${isTarget ? 'attack-target' : ''}" data-x="${x}" data-y="${y}" onclick="tacticalTileClick(${x}, ${y})" aria-label="${escapeHtml(terrain)}${occupant ? `, ${occupant.name}` : ''}">${unitHtml}</button>`;
  }).join('')).join('');
  const status = state.outcome
    ? (state.outcome === 'victory' ? 'Victory' : 'Defeat')
    : unit?.side === 'party' ? `${unit.name}'s turn` : 'Resolving enemy turn';
  const instructions = actionMode === 'move' ? 'Choose a highlighted tile.' : actionMode === 'attack' ? 'Choose a highlighted enemy.' : actionMode === 'power' && power ? `Choose a target for ${power.name}.` : controllable ? 'Move, attack, use a power, defend, or end your turn.' : 'Waiting for the active player.';
  const powers = unit?.powers || [];
  const powerMenu = controllable && actionMode === 'powers' ? `<div class="tactical-power-menu">${powers.length
    ? powers.map(candidate => {
      const ready = canAct && powerReady(unit, candidate);
      const resource = candidate.slotLevel > 0 ? `Level ${candidate.slotLevel} slot: ${unit.spellSlots?.[candidate.slotLevel]?.current || 0}` : candidate.maxUses != null ? `${Math.max(0, candidate.maxUses - Number(unit.powerUses?.[candidate.id] || 0))} use(s)` : 'At will';
      return `<button onclick="selectTacticalPower('${escapeHtml(candidate.id)}')" ${ready ? '' : 'disabled'}><strong>${escapeHtml(candidate.name)}</strong><span>${escapeHtml(candidate.kind)} · ${escapeHtml(resource)}</span></button>`;
    }).join('') : '<span>No combat spells or abilities are listed for this character.</span>'}</div>` : '';

  panel.innerHTML = `
    <div class="tactical-combat-header">
      <div><span class="tactical-eyebrow">Tactical Encounter</span><h2>${escapeHtml(combat.name || 'Encounter')}</h2></div>
      <div class="tactical-status"><strong>${escapeHtml(status)}</strong><span>Round ${state.round}</span></div>
    </div>
    <div class="tactical-initiative" aria-label="Initiative order">${renderInitiative(state)}</div>
    <div class="tactical-board" style="--tactical-columns:${state.grid.width}">${board}</div>
    <div class="tactical-controls">
      <div class="tactical-help">${escapeHtml(instructions)}</div>
      ${controllable ? `<div class="tactical-actions">
        <button onclick="selectTacticalAction('move')" ${canMove ? '' : 'disabled'}>${actionMode === 'move' ? 'Cancel Move' : 'Move'}</button>
        <button onclick="selectTacticalAction('attack')" ${canAct ? '' : 'disabled'}>${actionMode === 'attack' ? 'Cancel Attack' : `Attack (${unit.range})`}</button>
        <button onclick="selectTacticalAction('powers')" ${canAct && powers.length ? '' : 'disabled'}>${actionMode === 'powers' || actionMode === 'power' ? 'Cancel Powers' : 'Spells & Abilities'}</button>
        <button onclick="tacticalDefend()" ${canAct ? '' : 'disabled'}>Defend</button>
        <button onclick="tacticalEndTurn()">End Turn</button>
      </div>` : ''}
      ${getState('currentUser')?.is_admin ? `<div class="tactical-gm-actions"><button onclick="setDJTrack()">Set Music</button><button onclick="stopDJTrack()">Stop Music</button><button onclick="endTacticalCombat()">End Encounter</button></div>` : ''}
    </div>
    ${powerMenu}
    <div class="tactical-log">${state.log.slice(-4).reverse().map(event => `<div>${escapeHtml(event.text)}</div>`).join('')}</div>`;
}

export function selectTacticalAction(mode) {
  actionMode = actionMode === mode ? 'idle' : mode;
  selectedPowerId = null;
  renderTacticalCombat(getState('activeCombat'));
}

export function selectTacticalPower(powerId) {
  const state = getState('activeCombat')?.state;
  const unit = state && currentUnit(state);
  const power = unit?.powers?.find(candidate => candidate.id === powerId);
  if (!power || !powerReady(unit, power)) return;
  selectedPowerId = powerId;
  if (power.range === 0) {
    submitTacticalAction({ type: 'power', powerId, targetId: unit.id });
    return;
  }
  actionMode = 'power';
  renderTacticalCombat(getState('activeCombat'));
}

export async function tacticalTileClick(x, y) {
  const combat = getState('activeCombat');
  const state = combat?.state;
  const unit = state && currentUnit(state);
  if (!combat || !state || !unit || actionPending) return;
  if (actionMode === 'move') {
    if (!reachableTiles(state, unit).has(`${x},${y}`)) return;
    await submitTacticalAction({ type: 'move', x, y });
  } else if (actionMode === 'attack') {
    const target = unitAt(state, x, y);
    if (!target || target.side !== 'enemy' || Math.abs(target.x - unit.x) + Math.abs(target.y - unit.y) > unit.range) return;
    await submitTacticalAction({ type: 'attack', targetId: target.id });
  } else if (actionMode === 'power') {
    const power = selectedPower(unit);
    const target = unitAt(state, x, y);
    const targetSide = power?.kind === 'attack' ? 'enemy' : 'party';
    if (!power || !target || target.side !== targetSide || Math.abs(target.x - unit.x) + Math.abs(target.y - unit.y) > power.range) return;
    await submitTacticalAction({ type: 'power', powerId: power.id, targetId: target.id });
  }
}

export async function tacticalDefend() {
  await submitTacticalAction({ type: 'defend' });
}

export async function tacticalEndTurn() {
  await submitTacticalAction({ type: 'endTurn' });
}

async function submitTacticalAction(action) {
  const session = getState('currentSession');
  const combat = getState('activeCombat');
  if (!session || !combat || actionPending) return;
  actionPending = true;
  try {
    const result = await api(`/api/sessions/${session.id}/combat/action`, 'POST', { version: combat.state.version, action });
    actionMode = 'idle';
    selectedPowerId = null;
    handleCombatUpdate(session.id, result.combat, result.events, result.version);
    const { updateActionFormState } = await import('./sessions.js');
    updateActionFormState();
    if (result.outcome) showNotification(result.outcome === 'victory' ? 'Victory!' : 'The party was defeated.');
  } catch (error) {
    showNotification(error.message || 'Combat action failed.');
  } finally {
    actionPending = false;
  }
}

export function openTacticalCombatSetup() {
  if (!getState('currentSession')) return showNotification('Select a session first.');
  document.getElementById('combat-setup-modal')?.classList.add('active');
  document.getElementById('combat-setup-status').textContent = '';
}

export function closeTacticalCombatSetup() {
  document.getElementById('combat-setup-modal')?.classList.remove('active');
}

function parseEnemies(value) {
  return value.split('\n').map((line, index) => {
    const [name, hp, ac, attackBonus, damageDie, damageBonus] = line.split('|').map(part => part.trim());
    return name ? { id: String(index + 1), name, hp: Number(hp), ac: Number(ac), attackBonus: Number(attackBonus), damageDie: Number(damageDie), damageBonus: Number(damageBonus) } : null;
  }).filter(Boolean);
}

export async function startTacticalCombat() {
  const session = getState('currentSession');
  if (!session) return;
  const enemies = parseEnemies(document.getElementById('combat-enemies').value);
  const status = document.getElementById('combat-setup-status');
  const button = document.getElementById('start-combat-btn');
  if (!enemies.length) { status.textContent = 'Add at least one enemy.'; return; }
  button.disabled = true;
  try {
    const result = await api(`/api/sessions/${session.id}/combat`, 'POST', {
      name: document.getElementById('combat-name').value,
      environment: document.getElementById('combat-environment').value,
      enemies
    });
    closeTacticalCombatSetup();
    renderTacticalCombat(result.combat);
  } catch (error) {
    status.textContent = error.message || 'Unable to start encounter.';
  } finally {
    button.disabled = false;
  }
}

export async function endTacticalCombat() {
  const session = getState('currentSession');
  if (!session || !window.confirm('End this encounter?')) return;
  try {
    await api(`/api/sessions/${session.id}/combat/end`, 'POST');
    renderTacticalCombat(null);
  } catch (error) {
    showNotification(error.message || 'Unable to end encounter.');
  }
}

export function handleCombatUpdate(sessionId, combat, events = [], version = combat?.state?.version) {
  if (getState('currentSession')?.id !== sessionId) return;
  if (Number.isInteger(version) && (queuedVersions.has(version) || version <= Number(modeVersion || 0))) return;
  if (Number.isInteger(version)) queuedVersions.add(version);
  setState({ activeCombat: combat || null });
  actionMode = 'idle';
  selectedPowerId = null;
  Promise.resolve()
    .then(() => playTacticalEvents(events))
    .then(() => renderTacticalCombat(combat))
    .finally(() => {
      if (Number.isInteger(version)) queuedVersions.delete(version);
    });
}

function findToken(unitId) {
  return [...document.querySelectorAll('.tactical-token')].find(token => token.dataset.unitId === unitId) || null;
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function playTacticalEvents(events) {
  for (const event of Array.isArray(events) ? events : []) {
    if (event.type === 'move' && event.from && event.to) {
      const token = findToken(event.unitId);
      const destination = document.querySelector(`.tactical-tile[data-x="${event.to.x}"][data-y="${event.to.y}"]`);
      if (token && destination) {
        const start = token.getBoundingClientRect();
        const end = destination.getBoundingClientRect();
        const ghost = token.cloneNode(true);
        ghost.classList.add('tactical-moving-token');
        Object.assign(ghost.style, { left: `${start.left}px`, top: `${start.top}px`, width: `${start.width}px`, height: `${start.height}px` });
        document.body.appendChild(ghost);
        token.style.opacity = '0';
        await ghost.animate([
          { transform: 'translate(0, 0) scale(1)' },
          { transform: `translate(${end.left + (end.width - start.width) / 2 - start.left}px, ${end.top + (end.height - start.height) / 2 - start.top}px) scale(1.08)` }
        ], { duration: 320, easing: 'ease-in-out', fill: 'forwards' }).finished.catch(() => {});
        ghost.remove();
        token.style.opacity = '';
      }
    } else if (event.type === 'attack' || event.type === 'critical' || event.type === 'miss' || event.type === 'spell' || event.type === 'ability') {
      const attacker = findToken(event.attackerId);
      const target = findToken(event.targetId);
      attacker?.classList.add(event.type === 'spell' ? 'tactical-cast' : 'tactical-lunge');
      if (event.type === 'spell' && attacker && target) {
        const from = attacker.getBoundingClientRect();
        const to = target.getBoundingClientRect();
        const projectile = document.createElement('span');
        projectile.className = 'tactical-projectile';
        Object.assign(projectile.style, { left: `${from.left + from.width / 2}px`, top: `${from.top + from.height / 2}px` });
        document.body.appendChild(projectile);
        projectile.animate([{ transform: 'translate(-50%, -50%) scale(.4)' }, { transform: `translate(${to.left + to.width / 2 - from.left}px, ${to.top + to.height / 2 - from.top}px) scale(1.3)` }], { duration: 300, easing: 'ease-in', fill: 'forwards' });
        await delay(280);
        projectile.remove();
      } else {
        await delay(170);
      }
      if (event.effect !== 'miss' && event.type !== 'miss') target?.classList.add(event.effect === 'heal' ? 'tactical-heal' : 'tactical-hit');
      await delay(180);
      attacker?.classList.remove('tactical-cast', 'tactical-lunge');
      target?.classList.remove('tactical-hit', 'tactical-heal');
    }
  }
}
