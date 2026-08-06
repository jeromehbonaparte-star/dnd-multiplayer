/**
 * Narrative-combat integration helpers (unit C3).
 *
 * Everything in here is pure and DB-free: the session routes own the SQLite and
 * Socket.IO side effects, this module owns the decisions those side effects are
 * built from (broadcast shaping, writeback SQL arguments, the enemy fallback
 * adjudication, the per-turn stall cap, input normalization, and the sheet
 * fields a migrated schema-1 unit needs re-read from the character row).
 */

const combatService = require('./combatService');

/** Adjudications one unit may submit in a single turn before the turn is forced to end. */
const MAX_TURN_ACTIONS = 10;
/** Hard cap on consecutive enemy turns resolved by one driver pass. */
const MAX_ENEMY_TURNS = 12;
const COMBAT_ACTION_MAX_CHARS = 2000;
const COMBAT_NARRATION_MAX_CHARS = 4000;
const BROADCAST_LOG_ENTRIES = 12;
const PUBLIC_LOG_ENTRIES = 40;
const SHEET_CONTEXT_MAX_CHARS = 6000;
const MAX_INVENTORY_ITEMS = 60;

/* ------------------------------------------------------------------ *
 * Input normalization
 * ------------------------------------------------------------------ */

/** Keeps newlines/tabs (a [DICE ROLL] tag may be on its own line), drops the rest. */
function stripControlCharacters(value) {
  return String(value == null ? '' : value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
}

/**
 * Validates a freeform turn action.
 * @returns {{action:string}|{error:string}}
 */
function normalizeCombatAction(raw) {
  if (typeof raw !== 'string') return { error: 'Describe what your character does.' };
  const action = stripControlCharacters(raw).trim().slice(0, COMBAT_ACTION_MAX_CHARS);
  if (!action) return { error: 'Describe what your character does.' };
  return { action };
}

/** @returns {{roll:number}|{error:string}} — the d20 the player physically rolled. */
function normalizeInitiativeRoll(raw) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 20) {
    return { error: 'Initiative needs a d20 roll between 1 and 20.' };
  }
  return { roll: value };
}

/* ------------------------------------------------------------------ *
 * Schema-1 migration hydration
 * ------------------------------------------------------------------ */

/** `characters.inventory` is JSON `[{name, quantity}]`; anything else degrades to []. */
function parseStoredInventory(value) {
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed || '[]'); } catch (error) { parsed = []; }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map(entry => {
      if (typeof entry === 'string') return { name: stripControlCharacters(entry).trim().slice(0, 80), quantity: 1 };
      if (!entry || typeof entry !== 'object') return null;
      return {
        name: stripControlCharacters(entry.name).trim().slice(0, 80),
        quantity: Math.max(0, Math.min(9999, Math.floor(Number(entry.quantity) || 0)))
      };
    })
    .filter(entry => entry && entry.name)
    .slice(0, MAX_INVENTORY_ITEMS);
}

/** Free-form sheet text carried on a unit purely as adjudicator context. */
function sheetContext(value, limit = SHEET_CONTEXT_MAX_CHARS) {
  if (value == null) return null;
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  const trimmed = text.trim();
  return trimmed ? trimmed.slice(0, limit) : null;
}

/**
 * Fills the sheet fields `fromTacticalState` left as the `null` sentinel from a
 * character row. Mutates and returns the unit. A missing character row leaves
 * `inventory` null so the writeback keeps ignoring stored inventory.
 * @param {Object} unit - migrated party unit
 * @param {Object|null} characterRow - `characters` row, or null when it is gone
 * @returns {boolean} whether anything was hydrated
 */
function hydrateMigratedUnit(unit, characterRow) {
  if (!unit || unit.side !== 'party' || unit.inventory !== null) return false;
  if (!characterRow) return false;
  unit.inventory = parseStoredInventory(characterRow.inventory);
  unit.spellsText = sheetContext(characterRow.spells);
  unit.classFeatures = sheetContext(characterRow.class_features);
  unit.classResourcesRaw = sheetContext(characterRow.class_resources);
  return true;
}

/** Party units still carrying the migration sentinel, in load order. */
function unitsNeedingHydration(state) {
  if (!state || !Array.isArray(state.units)) return [];
  return state.units.filter(unit => unit.side === 'party' && unit.inventory === null && unit.sourceCharacterId != null);
}

/* ------------------------------------------------------------------ *
 * Character writeback
 * ------------------------------------------------------------------ */

/**
 * Turns `collectCharacterWriteback` rows into ready-to-run UPDATE statements.
 *
 * `null` is the "this unit never carried that sheet field" sentinel and means
 * the stored column MUST NOT be overwritten — `inventory: null` for a migrated
 * unit that never tracked inventory, `spellSlots: null` for a unit with no
 * spell-slot object at all (writing `{}` there wiped the sheet's slots). Only
 * the columns the unit actually carries appear in the statement.
 *
 * @param {Array} writebacks
 * @returns {Array<{characterId:string, sql:string, args:Array}>}
 */
function buildCharacterWritebackStatements(writebacks) {
  if (!Array.isArray(writebacks)) return [];
  return writebacks
    .filter(entry => entry && entry.characterId != null)
    .map(entry => {
      const assignments = ['hp = ?'];
      const args = [Math.max(0, Math.floor(Number(entry.hp) || 0))];
      if (entry.spellSlots && typeof entry.spellSlots === 'object' && !Array.isArray(entry.spellSlots)) {
        assignments.push('spell_slots = ?');
        args.push(JSON.stringify(entry.spellSlots));
      }
      if (Array.isArray(entry.inventory)) {
        assignments.push('inventory = ?');
        args.push(JSON.stringify(entry.inventory));
      }
      args.push(entry.characterId);
      return {
        characterId: entry.characterId,
        sql: `UPDATE characters SET ${assignments.join(', ')} WHERE id = ?`,
        args
      };
    });
}

/* ------------------------------------------------------------------ *
 * Broadcast shaping
 * ------------------------------------------------------------------ */

/** Tracker-facing view of a unit: no powers, no sheet text, no inventory. */
function publicCombatUnit(unit) {
  const view = {
    id: unit.id,
    name: unit.name,
    side: unit.side,
    imageUrl: unit.imageUrl || '',
    hp: Math.max(0, Number(unit.hp) || 0),
    maxHp: Math.max(1, Number(unit.maxHp) || 1),
    ac: Number(unit.ac) || 0,
    initiative: unit.initiative == null ? null : Number(unit.initiative),
    initiativeBonus: Number(unit.initiativeBonus) || 0,
    ap: Math.max(0, Number(unit.ap) || 0),
    apMax: Math.max(0, Number(unit.apMax) || 0),
    bp: Math.max(0, Number(unit.bp) || 0),
    bpMax: Math.max(0, Number(unit.bpMax) || 0),
    conditions: Array.isArray(unit.conditions) ? [...unit.conditions] : [],
    down: !combatService.isActionable(unit)
  };
  if (unit.sourceCharacterId != null) view.sourceCharacterId = unit.sourceCharacterId;
  return view;
}

function publicLogEntry(entry) {
  return {
    type: String(entry?.type || 'info'),
    text: String(entry?.text || ''),
    round: Number(entry?.round) || 1,
    ...(entry?.unitId ? { unitId: entry.unitId } : {})
  };
}

/**
 * Strips everything the tracker UI does not need — unit sheet context strings
 * (`spellsText`, `classFeatures`, `classResourcesRaw`), `inventory`, enemy
 * `powers`/`powerUses`, spell slots, the RNG state and the deferred turn.
 */
function publicCombatState(state) {
  if (!state || !Array.isArray(state.units)) return null;
  const active = combatService.currentUnit(state);
  return {
    schema: Number(state.schema) || combatService.COMBAT_SCHEMA_VERSION,
    name: state.name,
    environment: state.environment,
    phase: state.outcome ? 'ended' : state.phase,
    round: Number(state.round) || 1,
    turnIndex: Number.isInteger(state.turnIndex) ? state.turnIndex : -1,
    turnOrder: Array.isArray(state.turnOrder) ? [...state.turnOrder] : [],
    pendingInitiative: Array.isArray(state.pendingInitiative) ? [...state.pendingInitiative] : [],
    outcome: state.outcome || null,
    currentUnitId: active ? active.id : null,
    version: Number(state.version) || 0,
    units: state.units.map(publicCombatUnit),
    log: (Array.isArray(state.log) ? state.log : []).slice(-PUBLIC_LOG_ENTRIES).map(publicLogEntry)
  };
}

/**
 * `combat_updated` payload. `combat` is null once the encounter has an outcome,
 * which is the signal for clients to tear the tracker down.
 */
function buildCombatUpdatedPayload({ sessionId, combatId, state, events, automatic } = {}) {
  const publicState = publicCombatState(state);
  const ended = !publicState || Boolean(publicState.outcome);
  return {
    sessionId,
    combatId: ended ? null : (combatId || null),
    combat: ended ? null : publicState,
    events: (Array.isArray(events) ? events : []).slice(-BROADCAST_LOG_ENTRIES).map(publicLogEntry),
    version: publicState ? publicState.version : 0,
    phase: publicState ? publicState.phase : 'ended',
    currentUnitId: publicState ? publicState.currentUnitId : null,
    outcome: publicState ? publicState.outcome : null,
    ...(automatic ? { automatic: true } : {})
  };
}

/** `combat_turn_narration` payload — the live story-stream append. */
function buildNarrationPayload({ sessionId, unitName, narration, round, warnings } = {}) {
  return {
    sessionId,
    unitName: unitName ? String(unitName).slice(0, 84) : '',
    narration: String(narration == null ? '' : narration).slice(0, COMBAT_NARRATION_MAX_CHARS),
    round: Math.max(1, Math.floor(Number(round) || 1)),
    warnings: Array.isArray(warnings) ? warnings.filter(Boolean).map(String) : []
  };
}

/**
 * A visible `full_history` entry for one combat beat. Deliberately carries NO
 * `role`, so `buildConversationMessages` skips it (the narrator learns the
 * outcome from the combat-conclusion summary instead) and the compaction token
 * estimate is unaffected.
 */
function buildCombatHistoryEntry({ content, unitName, round } = {}) {
  return {
    type: 'combat_turn',
    content: String(content == null ? '' : content).slice(0, COMBAT_NARRATION_MAX_CHARS),
    unitName: unitName ? String(unitName).slice(0, 84) : '',
    round: Math.max(1, Math.floor(Number(round) || 1)),
    ts: new Date().toISOString()
  };
}

/* ------------------------------------------------------------------ *
 * Enemy-turn fallback
 * ------------------------------------------------------------------ */

/**
 * Deterministic basic attack used when the enemy-turn AI call fails, so a dead
 * adjudicator can never stall combat. Built from the engine's seeded pre-rolls:
 * hit when `attackRoll.total >= target AC`, damage from `damageRoll.total`.
 * @param {Object} state
 * @param {string} enemyUnitId
 * @param {Object} [preRolls] - pre-computed rolls (tests); otherwise rolled here
 * @returns {Object|null} an Adjudication JSON object
 */
function buildEnemyFallbackAdjudication(state, enemyUnitId, preRolls) {
  const unit = combatService.findUnit(state, enemyUnitId);
  if (!unit || unit.side !== 'enemy') return null;
  const costs = { ap: 1, bp: 0 };
  const rolls = preRolls || combatService.buildEnemyPreRolls(state, enemyUnitId);
  if (!rolls || rolls.error) {
    return { narration: `${unit.name} holds position, watching for an opening.`, costs, effects: [], turnEnds: true };
  }
  const target = rolls.targetSuggestion;
  if (!target) {
    return { narration: `${unit.name} finds no one left standing to strike and holds position.`, costs, effects: [], turnEnds: true };
  }
  const total = Number(rolls.attackRoll?.total) || 0;
  const targetAc = Number(target.ac) || 10;
  if (total < targetAc) {
    return { narration: `${unit.name} lunges at ${target.name} and misses.`, costs, effects: [], turnEnds: true };
  }
  const damage = Math.max(1, Math.floor(Number(rolls.damageRoll?.total) || 1));
  return {
    narration: `${unit.name} strikes ${target.name} for ${damage} damage.`,
    costs,
    effects: [{ type: 'damage', target: target.id, amount: damage }],
    turnEnds: true
  };
}

/* ------------------------------------------------------------------ *
 * Stall cap
 * ------------------------------------------------------------------ */

/** Adjudications applied for the current unit's turn so far. */
function turnActionCount(state) {
  return Math.max(0, Math.floor(Number(state?.turnActionCount) || 0));
}

/** Count carried into the next request: reset whenever the turn moved on. */
function nextTurnActionCount(state, turnAdvanced) {
  return turnAdvanced ? 0 : turnActionCount(state) + 1;
}

function shouldForceTurnEnd(count) {
  return Math.floor(Number(count) || 0) >= MAX_TURN_ACTIONS;
}

/**
 * Ends the current turn without an adjudication. Logs the reason, advances the
 * walker and bumps the version so clients refresh.
 *
 * `options.reason` picks the log wording: `'stall'` (the default) is the stall
 * cap tripping, `'pass'` is the acting player voluntarily ending their turn.
 * `options.message` overrides the line outright.
 */
function forceTurnEnd(state, options = {}) {
  if (!state || state.phase !== 'active' || state.outcome) return state;
  const unit = combatService.currentUnit(state);
  const who = unit?.name || 'The combatant';
  const text = options.message
    ? String(options.message).slice(0, 200)
    : options.reason === 'pass'
      ? `${who} ends their turn.`
      : `${who} has taken ${MAX_TURN_ACTIONS} actions this turn; the turn passes.`;
  if (!Array.isArray(state.log)) state.log = [];
  state.log.push({
    round: Number(state.round) || 1,
    type: 'turn',
    text,
    ...(unit?.id ? { unitId: unit.id } : {})
  });
  if (state.log.length > combatService.MAX_LOG_ENTRIES) {
    state.log.splice(0, state.log.length - combatService.MAX_LOG_ENTRIES);
  }
  combatService.advanceToNextActor(state);
  state.version = (Number(state.version) || 0) + 1;
  state.turnActionCount = 0;
  return state;
}

/** Voluntary "I'm done" from the acting player — same walk, neutral log line. */
function passTurn(state) {
  return forceTurnEnd(state, { reason: 'pass' });
}

module.exports = {
  MAX_TURN_ACTIONS,
  MAX_ENEMY_TURNS,
  COMBAT_ACTION_MAX_CHARS,
  BROADCAST_LOG_ENTRIES,
  buildCharacterWritebackStatements,
  buildCombatHistoryEntry,
  buildCombatUpdatedPayload,
  buildEnemyFallbackAdjudication,
  buildNarrationPayload,
  forceTurnEnd,
  hydrateMigratedUnit,
  nextTurnActionCount,
  normalizeCombatAction,
  normalizeInitiativeRoll,
  parseStoredInventory,
  passTurn,
  publicCombatState,
  publicCombatUnit,
  sheetContext,
  shouldForceTurnEnd,
  turnActionCount,
  unitsNeedingHydration
};
