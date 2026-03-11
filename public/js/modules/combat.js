// ============================================
// Combat Tracker UI
// ============================================

import { getState, setState } from '../state.js';
import { api } from '../api.js';
import { escapeHtml } from '../utils/formatters.js';

// Load combat state when session loads
export async function loadCombat() {
  const currentSession = getState('currentSession');
  if (!currentSession) return;

  try {
    const result = await api(`/api/sessions/${currentSession.id}/combat`);
    setState({ currentCombat: result.combat });
    renderCombatTracker();
  } catch (error) {
    console.error('Failed to load combat:', error);
  }
}

export function renderCombatTracker() {
  const currentCombat = getState('currentCombat');
  const noCombatMsg = document.getElementById('no-combat-message');
  const combatActive = document.getElementById('combat-active');

  if (!currentCombat) {
    noCombatMsg.style.display = 'block';
    combatActive.style.display = 'none';
    return;
  }

  noCombatMsg.style.display = 'none';
  combatActive.style.display = 'block';

  document.getElementById('combat-name').textContent = currentCombat.name || 'Combat';
  document.getElementById('combat-round').textContent = `Round ${currentCombat.round}`;

  const orderEl = document.getElementById('initiative-order');
  orderEl.innerHTML = currentCombat.combatants.map((c, idx) => {
    const isCurrent = idx === currentCombat.current_turn;
    const isPlayer = c.is_player;
    const hpPercent = c.max_hp > 0 ? (c.hp / c.max_hp) * 100 : 0;
    const hpClass = hpPercent > 50 ? 'hp-healthy' : hpPercent > 25 ? 'hp-wounded' : 'hp-critical';
    const conditions = (c.conditions || []).join(', ');

    return `
      <div class="combatant ${isCurrent ? 'current-turn' : ''} ${!c.is_active ? 'defeated' : ''} ${isPlayer ? 'player' : 'enemy'}">
        <div class="combatant-init">${c.initiative}</div>
        <div class="combatant-info">
          <div class="combatant-name">${escapeHtml(c.name)}</div>
          <div class="combatant-stats">
            <span class="combatant-hp ${hpClass}">${c.hp}/${c.max_hp}</span>
            <span class="combatant-ac">AC ${c.ac}</span>
          </div>
          ${conditions ? `<div class="combatant-conditions">${escapeHtml(conditions)}</div>` : ''}
        </div>
        ${isCurrent ? '<div class="turn-indicator">\u25B6</div>' : ''}
      </div>
    `;
  }).join('');
}
