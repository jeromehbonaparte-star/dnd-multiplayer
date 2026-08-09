/**
 * Narrative Turn-Based Combat (NTC) engine — schema 2.
 *
 * Pure and DB-free: every function takes/returns plain state objects so routes,
 * turnProcessor and tests can drive it without touching SQLite.
 *
 * Combat is text-first: there is no grid. Units roll initiative, then spend a
 * per-turn Action Point / Bonus Point budget on freeform actions that the AI
 * adjudicator resolves into the Adjudication JSON contract handled by
 * `applyAdjudication`. Party units carry their whole character sheet (spell
 * slots, inventory, class features) so the adjudicator can reason about it and
 * `collectCharacterWriteback` can sync it back to the database every turn.
 */

// The only dependency this module takes: a pure console logger, no DB. Party
// units are built from character rows here, and a caster whose stored slot
// table degrades to nothing has to be visible BEFORE a spell fizzles mid-fight.
const logger = require('../lib/logger');

const COMBAT_SCHEMA_VERSION = 2;
const MAX_COMBATANTS_PER_SIDE = 12;
const MAX_LOG_ENTRIES = 80;
const MAX_POWERS_PER_UNIT = 20;
const MAX_CONDITIONS_PER_UNIT = 10;
const MAX_CONDITION_LENGTH = 40;
const MAX_EFFECTS_PER_ADJUDICATION = 12;
const MAX_EFFECT_AMOUNT = 500;
const MAX_NARRATION_LENGTH = 4000;
const MAX_POINTS = 5;
const MAX_INVENTORY_ITEMS = 60;
const MAX_CONTEXT_LENGTH = 6000;

const OUTCOMES = ['victory', 'defeat', 'resolved'];
const DOWN_CONDITIONS = ['unconscious', 'dead'];
const ENVIRONMENTS = ['plains', 'forest', 'dungeon', 'ruins', 'water', 'city'];

const CANTRIPS = new Set([
  'acid splash', 'blade ward', 'chill touch', 'dancing lights', 'druidcraft', 'eldritch blast',
  'fire bolt', 'guidance', 'light', 'mage hand', 'magic stone', 'mending', 'message',
  'minor illusion', 'poison spray', 'prestidigitation', 'produce flame', 'ray of frost',
  'resistance', 'sacred flame', 'shillelagh', 'shocking grasp', 'spare the dying',
  'thaumaturgy', 'thorn whip', 'true strike', 'vicious mockery'
]);

const SPELL_LEVELS = {
  'armor of agathys': 1, 'bane': 1, 'bless': 1, 'burning hands': 1, 'charm person': 1,
  'chromatic orb': 1, 'command': 1, 'cure wounds': 1, 'detect magic': 1, 'divine favor': 1,
  'entangle': 1, 'faerie fire': 1, 'false life': 1, 'feather fall': 1, 'guiding bolt': 1,
  'healing word': 1, 'hellish rebuke': 1, 'heroism': 1, 'hex': 1, 'hunter\'s mark': 1,
  'inflict wounds': 1, 'magic missile': 1, 'shield': 1, 'sleep': 1, 'thunderwave': 1,
  'aid': 2, 'blur': 2, 'branding smite': 2, 'darkness': 2, 'flaming sphere': 2,
  'hold person': 2, 'lesser restoration': 2, 'magic weapon': 2, 'mirror image': 2,
  'misty step': 2, 'moonbeam': 2, 'prayer of healing': 2, 'scorching ray': 2,
  'shatter': 2, 'spiritual weapon': 2, 'web': 2,
  'call lightning': 3, 'counterspell': 3, 'dispel magic': 3, 'fireball': 3, 'fly': 3,
  'haste': 3, 'lightning bolt': 3, 'mass healing word': 3, 'revivify': 3, 'spirit guardians': 3,
  'banishment': 4, 'blight': 4, 'dimension door': 4, 'greater invisibility': 4, 'ice storm': 4,
  'polymorph': 4, 'wall of fire': 4,
  'cloudkill': 5, 'cone of cold': 5, 'flame strike': 5, 'greater restoration': 5,
  'hold monster': 5, 'mass cure wounds': 5, 'wall of force': 5,
  'chain lightning': 6, 'disintegrate': 6, 'harm': 6, 'heal': 6, 'sunbeam': 6,
  'finger of death': 7, 'fire storm': 7, 'resurrection': 7,
  'dominate monster': 8, 'earthquake': 8, 'holy aura': 8, 'sunburst': 8,
  'mass heal': 9, 'meteor swarm': 9, 'power word kill': 9, 'time stop': 9, 'wish': 9
};

/* ------------------------------------------------------------------ *
 * Small shared helpers (carried over from the retired grid combat service)
 * ------------------------------------------------------------------ */

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Strips control characters, trims and truncates. */
function sanitizeText(value, limit) {
  const text = String(value == null ? '' : value);
  let cleaned = '';
  for (const character of text) {
    const code = character.codePointAt(0);
    cleaned += (code < 32 || code === 127) ? ' ' : character;
  }
  return cleaned.trim().slice(0, limit);
}

/** Free-form sheet text kept on the unit purely as adjudicator context. */
function contextString(value, limit = MAX_CONTEXT_LENGTH) {
  if (value == null) return null;
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  const trimmed = text.trim();
  return trimmed ? trimmed.slice(0, limit) : null;
}

function abilityModifier(score) {
  return Math.floor(((Number(score) || 10) - 10) / 2);
}

function proficiencyBonus(level) {
  return 2 + Math.floor((Math.max(1, Number(level) || 1) - 1) / 4);
}

function normalizedClass(value) {
  return String(value || '').toLowerCase();
}

function splitNames(value) {
  return [...new Set(String(value || '')
    .split(/[,;\n]/)
    .map(name => name.replace(/\s*\([^)]*\)\s*$/g, '').trim())
    .filter(Boolean))];
}

function parseSpellSlots(value) {
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed || '{}'); } catch (error) { parsed = {}; }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return Object.fromEntries(Object.entries(parsed).map(([level, slot]) => [String(level), {
    current: clamp(Number(slot?.current) || 0, 0, 20),
    max: clamp(Number(slot?.max) || 0, 0, 20)
  }]));
}

/** `characters.inventory` is JSON `[{name, quantity}]`; bad JSON degrades to []. */
function parseInventory(value) {
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed || '[]'); } catch (error) { parsed = []; }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map(entry => {
      if (typeof entry === 'string') return { name: sanitizeText(entry, 80), quantity: 1 };
      if (!entry || typeof entry !== 'object') return null;
      return {
        name: sanitizeText(entry.name, 80),
        quantity: clamp(Math.floor(Number(entry.quantity) || 0), 0, 9999)
      };
    })
    .filter(entry => entry && entry.name)
    .slice(0, MAX_INVENTORY_ITEMS);
}

function lowestAvailableSlot(spellSlots) {
  return Object.keys(spellSlots).map(Number).filter(level => level > 0 && spellSlots[level]?.max > 0).sort((a, b) => a - b)[0] || 1;
}

function classifyPower(name) {
  const normalized = name.toLowerCase();
  if (/heal|cure|restoration|lay on hands|second wind|prayer/.test(normalized)) return 'heal';
  if (/shield|ward|blur|mirror image|sanctuary|rage|wild shape|defen[cs]e|inspiration/.test(normalized)) return 'support';
  return 'attack';
}

function classProfile(character) {
  const className = normalizedClass(character.class);
  const ranged = /artificer|bard|cleric|druid|ranger|sorcerer|warlock|wizard/.test(className);
  const heavy = /barbarian|fighter|paladin/.test(className);
  const agile = /monk|rogue|ranger/.test(className);
  const castingStat = Math.max(abilityModifier(character.intelligence), abilityModifier(character.wisdom), abilityModifier(character.charisma));
  return {
    damageDie: heavy ? 10 : agile ? 6 : 8,
    attackStat: ranged ? Math.max(castingStat, abilityModifier(character.dexterity)) : Math.max(abilityModifier(character.strength), abilityModifier(character.dexterity)),
    castingStat
  };
}

/**
 * Spell / class-ability list used as prompt context for the adjudicator and as
 * the key space for `powerUses`. Grid `range` is gone; everything else is kept
 * so migrated characters keep their bookkeeping.
 */
function buildPowers(character, profile, spellSlots) {
  const castingBonus = proficiencyBonus(character.level) + profile.castingStat;
  const fallbackSlot = lowestAvailableSlot(spellSlots);
  const powers = splitNames(character.spells).slice(0, MAX_POWERS_PER_UNIT).map((name, index) => {
    const normalized = name.toLowerCase();
    const slotLevel = CANTRIPS.has(normalized) ? 0 : (SPELL_LEVELS[normalized] || fallbackSlot);
    const kind = classifyPower(name);
    return {
      id: `spell:${index}`,
      name,
      source: 'spell',
      kind,
      slotLevel,
      attackBonus: castingBonus,
      damageDie: clamp(6 + slotLevel * 2, 6, 12),
      bonus: Math.max(0, profile.castingStat)
    };
  });

  const className = normalizedClass(character.class);
  const classPower = className.includes('fighter') ? { name: 'Second Wind', kind: 'heal', maxUses: 1 }
    : className.includes('barbarian') ? { name: 'Rage', kind: 'support', maxUses: 2 }
    : className.includes('rogue') ? { name: 'Sneak Attack', kind: 'attack', maxUses: null }
    : className.includes('paladin') && Number(character.level) >= 2 ? { name: 'Divine Smite', kind: 'attack', maxUses: null, usesSlot: true }
    : className.includes('monk') && Number(character.level) >= 2 ? { name: 'Flurry of Blows', kind: 'attack', maxUses: 2 }
    : className.includes('cleric') && Number(character.level) >= 2 ? { name: 'Channel Divinity', kind: 'heal', maxUses: 1 }
    : className.includes('druid') && Number(character.level) >= 2 ? { name: 'Wild Shape', kind: 'support', maxUses: 2 }
    : className.includes('bard') ? { name: 'Bardic Inspiration', kind: 'support', maxUses: proficiencyBonus(character.level) }
    : null;
  if (classPower && !powers.some(power => power.name.toLowerCase() === classPower.name.toLowerCase())) {
    powers.push({
      id: 'ability:class',
      source: 'ability',
      slotLevel: classPower.usesSlot ? fallbackSlot : 0,
      attackBonus: proficiencyBonus(character.level) + profile.attackStat,
      damageDie: classPower.name === 'Divine Smite' ? 10 : 8,
      bonus: Math.max(0, profile.attackStat),
      ...classPower
    });
  }
  return powers.slice(0, MAX_POWERS_PER_UNIT);
}

/* ------------------------------------------------------------------ *
 * Seeded RNG (xorshift, identical to the tactical engine)
 * ------------------------------------------------------------------ */

function seeded(state) {
  let value = (Number(state.rngState) || 1) >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  state.rngState = value >>> 0;
  return (state.rngState >>> 0) / 4294967296;
}

function roll(state, sides) {
  return Math.floor(seeded(state) * sides) + 1;
}

/* ------------------------------------------------------------------ *
 * Unit helpers
 * ------------------------------------------------------------------ */

function isAlive(unit) {
  return Boolean(unit) && Number(unit.hp) > 0;
}

function hasCondition(unit, condition) {
  return Array.isArray(unit?.conditions) && unit.conditions.some(entry => String(entry).toLowerCase() === condition);
}

/** Alive and not knocked out — these are the units the turn walker stops on. */
function isActionable(unit) {
  return isAlive(unit) && !DOWN_CONDITIONS.some(condition => hasCondition(unit, condition));
}

function findUnit(state, unitId) {
  return state.units.find(unit => unit.id === unitId) || null;
}

function currentUnit(state) {
  if (!state || !Array.isArray(state.turnOrder)) return null;
  const unitId = state.turnOrder[state.turnIndex];
  return unitId ? findUnit(state, unitId) : null;
}

function beginTurn(unit) {
  unit.ap = unit.apMax;
  unit.bp = unit.bpMax;
}

function appendLog(state, entries) {
  const list = Array.isArray(entries) ? entries : [entries];
  for (const entry of list) {
    if (!entry || !entry.text) continue;
    state.log.push({
      round: state.round,
      ...entry,
      type: String(entry.type || 'info'),
      text: String(entry.text).slice(0, MAX_NARRATION_LENGTH)
    });
  }
  if (state.log.length > MAX_LOG_ENTRIES) state.log.splice(0, state.log.length - MAX_LOG_ENTRIES);
}

function normalizeCondition(value) {
  return sanitizeText(value, MAX_CONDITION_LENGTH).toLowerCase();
}

function addCondition(unit, condition) {
  const normalized = normalizeCondition(condition);
  if (!normalized) return false;
  if (!Array.isArray(unit.conditions)) unit.conditions = [];
  if (unit.conditions.some(entry => String(entry).toLowerCase() === normalized)) return false;
  if (unit.conditions.length >= MAX_CONDITIONS_PER_UNIT) return false;
  unit.conditions.push(normalized);
  return true;
}

function removeCondition(unit, condition) {
  const normalized = normalizeCondition(condition);
  if (!normalized || !Array.isArray(unit.conditions)) return false;
  const before = unit.conditions.length;
  unit.conditions = unit.conditions.filter(entry => String(entry).toLowerCase() !== normalized);
  return unit.conditions.length !== before;
}

/** A unit dropped to 0 HP: PCs fall unconscious, enemies are simply dead. */
function applyDownState(state, unit) {
  const condition = unit.side === 'party' ? 'unconscious' : 'dead';
  if (addCondition(unit, condition)) {
    appendLog(state, {
      type: 'down',
      text: unit.side === 'party' ? `${unit.name} falls unconscious.` : `${unit.name} is defeated.`,
      unitId: unit.id
    });
  }
}

/* ------------------------------------------------------------------ *
 * Setup normalization
 * ------------------------------------------------------------------ */

/**
 * Port of the tactical normalizer. Grid fields (`movement`, `range`) are
 * accepted in the input for backwards compatibility but are not emitted.
 */
function normalizeAutoCombatSetup(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const rawEnemies = Array.isArray(value.enemies) ? value.enemies : [];
  const enemies = rawEnemies.slice(0, MAX_COMBATANTS_PER_SIDE).map((enemy, index) => ({
    id: `auto-${index + 1}`,
    name: sanitizeText(enemy?.name || `Enemy ${index + 1}`, 80) || `Enemy ${index + 1}`,
    hp: clamp(Number(enemy?.hp) || 12, 1, 500),
    ac: clamp(Number(enemy?.ac) || 12, 1, 30),
    attackBonus: clamp(Number(enemy?.attackBonus) || 3, -5, 25),
    damageBonus: clamp(Number(enemy?.damageBonus) || 1, -5, 30),
    damageDie: clamp(Number(enemy?.damageDie) || 6, 4, 20),
    initiativeBonus: clamp(Number(enemy?.initiativeBonus) || 0, -10, 20)
  }));
  if (!enemies.length) return null;
  const requestedEnvironment = String(value.environment || 'plains').toLowerCase().replace(/[^a-z]/g, '').slice(0, 50);
  const environment = ENVIRONMENTS.includes(requestedEnvironment) ? requestedEnvironment : 'plains';
  const name = sanitizeText(value.name || 'Combat Encounter', 120) || 'Combat Encounter';
  return { name, environment, enemies };
}

/**
 * A character who knows spells but resolves to zero slot levels is broken, not
 * exotic: `parseSpellSlots` degrades bad JSON, an array and a missing column all
 * to `{}` without a word, `buildPowers` then advertises every leveled spell at
 * the `lowestAvailableSlot` fallback of 1, and the adjudicator's `spendSlot
 * level 1` is rejected in front of the table. Say so at load time instead.
 * Logging only — no DB read, nothing added to the unit.
 */
function warnOnEmptySlotTable(character, spellSlots) {
  const spells = splitNames(character.spells);
  if (!spells.length || Object.keys(spellSlots).length) return;
  const leveled = spells.filter(name => !CANTRIPS.has(name.toLowerCase()));
  logger.warn(
    `${character.character_name || 'A party member'} enters combat with spells but no spell slots; ` +
    'leveled casting will be rejected until the sheet is repaired.',
    {
      characterId: character.id,
      class: character.class,
      level: character.level,
      storedSpellSlots: typeof character.spell_slots === 'string'
        ? character.spell_slots.slice(0, 120)
        : JSON.stringify(character.spell_slots || null),
      leveledSpells: leveled.slice(0, 10)
    }
  );
}

function partyUnit(character) {
  const profile = classProfile(character);
  const spellSlots = parseSpellSlots(character.spell_slots);
  const hp = Math.max(0, Number(character.hp) || 0);
  warnOnEmptySlotTable(character, spellSlots);
  const unit = {
    id: `pc:${character.id}`,
    sourceCharacterId: character.id,
    name: sanitizeText(character.character_name || 'Adventurer', 80) || 'Adventurer',
    side: 'party',
    imageUrl: String(character.image_url || '').slice(0, 500),
    hp,
    maxHp: Math.max(1, Number(character.max_hp) || hp || 1),
    ac: clamp(Number(character.ac) || 10, 1, 30),
    attackBonus: proficiencyBonus(character.level) + profile.attackStat,
    damageBonus: profile.attackStat,
    damageDie: profile.damageDie,
    initiativeBonus: abilityModifier(character.dexterity) + (Number(character.initiative_bonus) || 0),
    initiative: null,
    ap: 1,
    apMax: 1,
    bp: 1,
    bpMax: 1,
    conditions: [],
    spellSlots,
    powers: buildPowers(character, profile, spellSlots),
    powerUses: {},
    inventory: parseInventory(character.inventory),
    spellsText: contextString(character.spells),
    classFeatures: contextString(character.class_features),
    classResourcesRaw: contextString(character.class_resources)
  };
  if (!unit.hp) unit.conditions.push('unconscious');
  return unit;
}

function enemyUnit(enemy, index) {
  const hp = clamp(Number(enemy?.hp) || 12, 1, 500);
  return {
    id: `npc:${enemy?.id || index + 1}`,
    name: sanitizeText(enemy?.name || `Enemy ${index + 1}`, 80) || `Enemy ${index + 1}`,
    side: 'enemy',
    imageUrl: String(enemy?.imageUrl || '').slice(0, 500),
    hp,
    maxHp: hp,
    ac: clamp(Number(enemy?.ac) || 12, 1, 30),
    attackBonus: clamp(Number(enemy?.attackBonus) || 3, -5, 25),
    damageBonus: clamp(Number(enemy?.damageBonus) || 1, -5, 30),
    damageDie: clamp(Number(enemy?.damageDie) || 6, 4, 20),
    initiativeBonus: clamp(Number(enemy?.initiativeBonus) || 0, -10, 20),
    initiative: null,
    ap: 1,
    apMax: 1,
    bp: 1,
    bpMax: 1,
    conditions: []
  };
}

/** Names are the adjudicator's targeting handle, so duplicates get numbered. */
function disambiguateNames(units) {
  const counts = new Map();
  for (const unit of units) {
    const key = unit.name.toLowerCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const seen = new Map();
  for (const unit of units) {
    const key = unit.name.toLowerCase();
    if (counts.get(key) < 2) continue;
    const ordinal = (seen.get(key) || 0) + 1;
    seen.set(key, ordinal);
    unit.name = `${unit.name} ${ordinal}`.slice(0, 84);
  }
  return units;
}

function uniqueIds(units) {
  const seen = new Set();
  for (const unit of units) {
    let id = unit.id;
    let suffix = 2;
    while (seen.has(id)) id = `${unit.id}#${suffix++}`;
    unit.id = id;
    seen.add(id);
  }
  return units;
}

/* ------------------------------------------------------------------ *
 * Creation & initiative
 * ------------------------------------------------------------------ */

function createCombat({ name, environment, characters, enemies, seed } = {}) {
  if (!Array.isArray(characters) || !characters.length) throw new Error('Combat needs at least one party member.');
  if (!Array.isArray(enemies) || !enemies.length) throw new Error('Combat needs at least one enemy.');
  if (characters.length > MAX_COMBATANTS_PER_SIDE || enemies.length > MAX_COMBATANTS_PER_SIDE) {
    throw new Error(`Combat supports up to ${MAX_COMBATANTS_PER_SIDE} units per side.`);
  }

  const resolvedSeed = Number(seed) || Math.floor(Math.random() * 0x7fffffff) || 1;
  const state = {
    schema: COMBAT_SCHEMA_VERSION,
    name: sanitizeText(name || 'Combat Encounter', 120) || 'Combat Encounter',
    environment: sanitizeText(environment || 'plains', 50) || 'plains',
    phase: 'initiative',
    round: 1,
    turnIndex: -1,
    turnOrder: [],
    pendingInitiative: [],
    outcome: null,
    units: uniqueIds(disambiguateNames([
      ...characters.map(partyUnit),
      ...enemies.map(enemyUnit)
    ])),
    log: [],
    seed: resolvedSeed,
    rngState: resolvedSeed,
    version: 1
  };

  for (const unit of state.units) {
    if (unit.side !== 'enemy') continue;
    unit.initiative = roll(state, 20) + unit.initiativeBonus;
  }
  state.pendingInitiative = state.units.filter(unit => unit.side === 'party').map(unit => unit.id);

  appendLog(state, [
    { type: 'start', text: `Combat begins: ${state.name}.` },
    { type: 'initiative', text: 'Roll for initiative.' }
  ]);
  return state;
}

/** Sorts the turn order and opens round 1. Called once initiative is complete. */
function activateCombat(state) {
  const ordered = state.units
    .map(unit => ({ id: unit.id, initiative: Number(unit.initiative) || 0, tie: roll(state, 20) }))
    .sort((left, right) => right.initiative - left.initiative || right.tie - left.tie);
  state.turnOrder = ordered.map(entry => entry.id);
  state.pendingInitiative = [];
  state.phase = 'active';
  state.round = 1;
  state.turnIndex = -1;
  appendLog(state, {
    type: 'initiative',
    text: `Initiative order: ${ordered.map(entry => findUnit(state, entry.id)?.name || entry.id).join(', ')}.`
  });
  advanceToNextActor(state);
  return state;
}

function rollInitiative(state, unitId, d20Roll) {
  if (!state || typeof state !== 'object') return { ok: false, error: 'No combat is loaded.' };
  if (state.outcome) return { ok: false, error: 'This combat has already ended.' };
  if (state.phase !== 'initiative') return { ok: false, error: 'Initiative has already been settled.' };
  const unit = findUnit(state, unitId);
  if (!unit) return { ok: false, error: 'That combatant is not in this fight.' };
  if (!state.pendingInitiative.includes(unitId)) return { ok: false, error: `${unit.name} has already rolled initiative.` };
  const value = Number(d20Roll);
  if (!Number.isInteger(value) || value < 1 || value > 20) return { ok: false, error: 'Initiative needs a d20 roll between 1 and 20.' };

  unit.initiative = value + unit.initiativeBonus;
  state.pendingInitiative = state.pendingInitiative.filter(id => id !== unitId);
  appendLog(state, {
    type: 'initiative',
    text: `${unit.name} rolls initiative: ${value} (total ${unit.initiative}).`,
    unitId: unit.id
  });
  if (!state.pendingInitiative.length) activateCombat(state);
  state.version += 1;
  return { ok: true, state, activated: state.phase === 'active' };
}

/** GM catch-up: server-rolls every party unit that has not rolled yet. */
function rollRemainingInitiative(state) {
  if (!state || typeof state !== 'object') return { ok: false, error: 'No combat is loaded.' };
  if (state.outcome) return { ok: false, error: 'This combat has already ended.' };
  if (state.phase !== 'initiative') return { ok: false, error: 'Initiative has already been settled.' };
  const pending = [...state.pendingInitiative];
  for (const unitId of pending) {
    const unit = findUnit(state, unitId);
    state.pendingInitiative = state.pendingInitiative.filter(id => id !== unitId);
    if (!unit) continue;
    const value = roll(state, 20);
    unit.initiative = value + unit.initiativeBonus;
    appendLog(state, { type: 'initiative', text: `${unit.name} rolls initiative: ${value} (total ${unit.initiative}).`, unitId: unit.id });
  }
  if (!state.pendingInitiative.length && state.phase === 'initiative') activateCombat(state);
  state.version += 1;
  return { ok: true, state, rolled: pending.length, activated: state.phase === 'active' };
}

/**
 * Walks the turn order to the next living combatant of either side and opens
 * their turn (points refreshed). Enemy turns are NOT auto-resolved here — the
 * caller drives them through `getEnemyTurnContext` + `applyAdjudication`.
 */
function advanceToNextActor(state) {
  if (!state || state.phase !== 'active') return null;
  if (checkOutcome(state)) return null;
  if (!state.turnOrder.length) return null;

  const guardLimit = state.turnOrder.length * 3 + 3;
  for (let guard = 0; guard < guardLimit; guard++) {
    state.turnIndex += 1;
    if (state.turnIndex >= state.turnOrder.length) {
      state.turnIndex = 0;
      state.round += 1;
    }
    const unit = currentUnit(state);
    if (!isActionable(unit)) continue;
    beginTurn(unit);
    appendLog(state, { type: 'turn', text: `${unit.name}'s turn.`, unitId: unit.id });
    return unit;
  }
  checkOutcome(state);
  return null;
}

function checkOutcome(state) {
  if (!state || state.outcome) return state?.outcome || null;
  const partyAlive = state.units.some(unit => unit.side === 'party' && isAlive(unit));
  const enemiesAlive = state.units.some(unit => unit.side === 'enemy' && isAlive(unit));
  if (partyAlive && enemiesAlive) return null;
  state.outcome = enemiesAlive ? 'defeat' : 'victory';
  appendLog(state, {
    type: state.outcome,
    text: state.outcome === 'victory' ? 'Victory. The battlefield falls silent.' : 'Defeat. The party can fight no longer.'
  });
  return state.outcome;
}

/* ------------------------------------------------------------------ *
 * Enemy turn support
 * ------------------------------------------------------------------ */

function livingPartyUnits(state) {
  return state.units.filter(unit => unit.side === 'party' && isActionable(unit));
}

/**
 * Authoritative dice for an enemy turn. The AI narrates around these numbers
 * instead of inventing its own. Consumes seeded RNG (advances `rngState`).
 */
function buildEnemyPreRolls(state, enemyUnitId) {
  const unit = findUnit(state, enemyUnitId);
  if (!unit) return { error: 'That combatant is not in this fight.' };
  if (unit.side !== 'enemy') return { error: 'Pre-rolls are only generated for enemy units.' };

  const d20 = roll(state, 20);
  const attackRoll = { d20, bonus: unit.attackBonus, total: d20 + unit.attackBonus };
  const rolls = [roll(state, unit.damageDie)];
  if (d20 === 20) rolls.push(roll(state, unit.damageDie));
  const damageRoll = {
    die: unit.damageDie,
    rolls,
    bonus: unit.damageBonus,
    total: Math.max(1, rolls.reduce((sum, value) => sum + value, 0) + unit.damageBonus),
    critical: d20 === 20
  };

  const weakest = livingPartyUnits(state)
    .slice()
    .sort((left, right) => (left.hp / Math.max(1, left.maxHp)) - (right.hp / Math.max(1, right.maxHp)))[0] || null;

  return {
    attackRoll,
    damageRoll,
    targetSuggestion: weakest ? { id: weakest.id, name: weakest.name, hp: weakest.hp, maxHp: weakest.maxHp, ac: weakest.ac } : null
  };
}

function publicUnit(unit) {
  return {
    id: unit.id,
    name: unit.name,
    side: unit.side,
    hp: unit.hp,
    maxHp: unit.maxHp,
    ac: unit.ac,
    conditions: [...(unit.conditions || [])],
    down: !isActionable(unit)
  };
}

/** Compact, prompt-ready snapshot for the enemy-turn AI call (unit C2). */
function getEnemyTurnContext(state, enemyUnitId) {
  const unit = findUnit(state, enemyUnitId);
  if (!unit || unit.side !== 'enemy') return { error: 'That enemy is not in this fight.' };
  const preRolls = buildEnemyPreRolls(state, enemyUnitId);
  return {
    name: state.name,
    environment: state.environment,
    round: state.round,
    enemy: {
      ...publicUnit(unit),
      attackBonus: unit.attackBonus,
      damageDie: unit.damageDie,
      damageBonus: unit.damageBonus,
      ap: unit.ap,
      bp: unit.bp
    },
    allies: state.units.filter(other => other.side === 'enemy' && other.id !== unit.id).map(publicUnit),
    foes: state.units.filter(other => other.side === 'party').map(publicUnit),
    preRolls,
    recentLog: state.log.slice(-8).map(entry => ({ type: entry.type, text: entry.text, round: entry.round }))
  };
}

/* ------------------------------------------------------------------ *
 * Adjudication
 * ------------------------------------------------------------------ */

function parseAdjudication(raw) {
  let value = raw;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch (error) { return { error: 'The adjudication was not valid JSON.' }; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'The adjudication was not an object.' };

  const narration = typeof value.narration === 'string' ? value.narration.trim() : '';
  if (!narration) return { error: 'The adjudication had no narration.' };

  if (value.costs != null && (typeof value.costs !== 'object' || Array.isArray(value.costs))) {
    return { error: 'The adjudication had malformed costs.' };
  }
  if (value.effects != null && !Array.isArray(value.effects)) {
    return { error: 'The adjudication had malformed effects.' };
  }

  const costs = value.costs || { ap: 1, bp: 0 };
  return {
    narration: narration.slice(0, MAX_NARRATION_LENGTH),
    costs: {
      ap: clamp(Math.floor(Number(costs.ap) || 0), 0, MAX_POINTS),
      bp: clamp(Math.floor(Number(costs.bp) || 0), 0, MAX_POINTS)
    },
    effects: Array.isArray(value.effects) ? value.effects : [],
    turnEnds: Boolean(value.turnEnds)
  };
}

/**
 * Fuzzy target resolution: exact id → exact name → unique name substring.
 * Returns `{ unit }` or `{ warning }` — never throws.
 */
function resolveTarget(state, raw, fallbackUnit, effectType) {
  const wanted = sanitizeText(raw, 120);
  if (!wanted) {
    if (fallbackUnit) return { unit: fallbackUnit };
    return { warning: `Skipped a ${effectType} effect: no target was named.` };
  }

  const byId = state.units.find(unit => unit.id === wanted);
  if (byId) return { unit: byId };

  const needle = wanted.toLowerCase();
  const exactName = state.units.filter(unit => unit.name.toLowerCase() === needle);
  if (exactName.length === 1) return { unit: exactName[0] };
  if (exactName.length > 1) return { warning: `Skipped a ${effectType} effect: "${wanted}" matches more than one combatant.` };

  const partial = state.units.filter(unit => unit.name.toLowerCase().includes(needle) || needle.includes(unit.name.toLowerCase()));
  if (partial.length === 1) return { unit: partial[0] };
  if (partial.length > 1) return { warning: `Skipped a ${effectType} effect: "${wanted}" is ambiguous (${partial.map(unit => unit.name).join(', ')}).` };
  return { warning: `Skipped a ${effectType} effect: no combatant named "${wanted}".` };
}

/** Case-insensitive inventory lookup: exact name, then unique substring. */
function findInventoryEntry(inventory, wanted) {
  const needle = String(wanted).toLowerCase();
  const exact = inventory.filter(entry => entry.name.toLowerCase() === needle);
  if (exact.length === 1) return { entry: exact[0] };
  if (exact.length > 1) return { ambiguous: exact };
  const partial = inventory.filter(entry => entry.name.toLowerCase().includes(needle) || needle.includes(entry.name.toLowerCase()));
  if (partial.length === 1) return { entry: partial[0] };
  if (partial.length > 1) return { ambiguous: partial };
  return {};
}

function applyEffect(state, actor, effect, warnings) {
  if (!effect || typeof effect !== 'object' || Array.isArray(effect)) {
    warnings.push('Skipped a malformed effect entry.');
    return;
  }
  const type = String(effect.type || '').trim();

  if (type === 'endCombat') {
    const outcome = String(effect.outcome || 'resolved').toLowerCase();
    if (!OUTCOMES.includes(outcome)) {
      warnings.push(`Ignored an endCombat effect with unknown outcome "${effect.outcome}".`);
      return;
    }
    state.outcome = outcome;
    const reason = sanitizeText(effect.reason, 200);
    appendLog(state, { type: 'end', text: reason ? `Combat ends (${outcome}): ${reason}` : `Combat ends: ${outcome}.` });
    return;
  }

  const selfTargeted = type === 'spendSlot' || type === 'useAbility' || type === 'useItem' || type === 'spendResource';
  const resolved = resolveTarget(state, effect.target, selfTargeted ? actor : null, type || 'unknown');
  if (!resolved.unit) {
    warnings.push(resolved.warning);
    return;
  }
  const target = resolved.unit;

  if (type === 'damage') {
    const amount = clamp(Math.floor(Number(effect.amount) || 0), 0, MAX_EFFECT_AMOUNT);
    target.hp = Math.max(0, target.hp - amount);
    appendLog(state, {
      type: 'damage',
      text: `${target.name} takes ${amount} damage (${target.hp}/${target.maxHp}).`,
      unitId: target.id,
      amount
    });
    if (!target.hp) applyDownState(state, target);
    return;
  }

  if (type === 'heal') {
    const amount = clamp(Math.floor(Number(effect.amount) || 0), 0, MAX_EFFECT_AMOUNT);
    const healed = Math.max(0, Math.min(amount, target.maxHp - target.hp));
    target.hp += healed;
    appendLog(state, {
      type: 'heal',
      text: `${target.name} recovers ${healed} HP (${target.hp}/${target.maxHp}).`,
      unitId: target.id,
      amount: healed
    });
    if (target.hp > 0) DOWN_CONDITIONS.forEach(condition => removeCondition(target, condition));
    return;
  }

  if (type === 'condition') {
    if (effect.add != null) {
      const condition = normalizeCondition(effect.add);
      if (!condition) warnings.push('Ignored an empty condition.');
      else if (addCondition(target, condition)) {
        appendLog(state, { type: 'condition', text: `${target.name} is ${condition}.`, unitId: target.id });
        if (condition === 'dead') target.hp = 0;
      }
    }
    if (effect.remove != null) {
      const condition = normalizeCondition(effect.remove);
      if (condition && removeCondition(target, condition)) {
        appendLog(state, { type: 'condition', text: `${target.name} is no longer ${condition}.`, unitId: target.id });
      }
    }
    if (effect.add == null && effect.remove == null) warnings.push('Ignored a condition effect with nothing to add or remove.');
    return;
  }

  if (type === 'spendSlot') {
    const level = clamp(Math.floor(Number(effect.level) || 0), 0, 9);
    const slot = level > 0 ? target.spellSlots?.[String(level)] : null;
    if (!slot) {
      warnings.push(`Ignored a spendSlot effect: ${target.name} has no level ${level || '?'} spell slots.`);
      return;
    }
    if (Number(slot.current || 0) <= 0) {
      warnings.push(`Ignored a spendSlot effect: ${target.name} has no level ${level} spell slots left.`);
      return;
    }
    slot.current = Math.max(0, Number(slot.current || 0) - 1);
    appendLog(state, {
      type: 'resource',
      text: `${target.name} expends a level ${level} spell slot (${slot.current}/${slot.max} left).`,
      unitId: target.id
    });
    return;
  }

  if (type === 'useItem') {
    const itemName = sanitizeText(effect.item, 80);
    if (!itemName) {
      warnings.push('Ignored a useItem effect with no item name.');
      return;
    }
    if (!Array.isArray(target.inventory)) {
      warnings.push(`Ignored a useItem effect: ${target.name} has no tracked inventory.`);
      return;
    }
    const match = findInventoryEntry(target.inventory, itemName);
    if (match.ambiguous) {
      warnings.push(`Ignored a useItem effect: "${itemName}" matches several items (${match.ambiguous.map(entry => entry.name).join(', ')}).`);
      return;
    }
    if (!match.entry || match.entry.quantity <= 0) {
      warnings.push(`Ignored a useItem effect: ${target.name} has no "${itemName}".`);
      return;
    }
    match.entry.quantity -= 1;
    const remaining = match.entry.quantity;
    const label = match.entry.name;
    if (remaining <= 0) target.inventory = target.inventory.filter(entry => entry !== match.entry);
    appendLog(state, {
      type: 'item',
      text: `${target.name} uses ${label}${remaining > 0 ? ` (${remaining} left)` : ' (last one)'}.`,
      unitId: target.id
    });
    return;
  }

  if (type === 'useAbility' || type === 'spendResource') {
    const label = sanitizeText(type === 'useAbility' ? effect.ability : effect.resource, 80)
      || sanitizeText(type === 'useAbility' ? effect.resource : effect.ability, 80);
    if (!label) {
      warnings.push(`Ignored a ${type} effect with no name.`);
      return;
    }
    if (!target.powerUses || typeof target.powerUses !== 'object') target.powerUses = {};
    const power = Array.isArray(target.powers)
      ? target.powers.find(candidate => String(candidate.name).toLowerCase() === label.toLowerCase())
      : null;
    const key = power?.id || label;
    const amount = type === 'spendResource' ? clamp(Math.floor(Number(effect.amount) || 1), 1, 20) : 1;
    target.powerUses[key] = Number(target.powerUses[key] || 0) + amount;
    const remaining = power && power.maxUses != null ? Math.max(0, power.maxUses - target.powerUses[key]) : null;
    appendLog(state, {
      type: 'ability',
      text: `${target.name} uses ${power?.name || label}${remaining == null ? '' : ` (${remaining} use${remaining === 1 ? '' : 's'} left)`}.`,
      unitId: target.id
    });
    return;
  }

  warnings.push(`Ignored an unsupported effect type "${type || 'unknown'}".`);
}

/** Copies a validated draft back over the caller's state object. */
function commit(target, draft) {
  for (const key of Object.keys(target)) {
    if (!(key in draft)) delete target[key];
  }
  Object.assign(target, draft);
  return target;
}

/**
 * Applies an Adjudication JSON payload. Never throws: malformed input returns
 * `{ ok: false, error }` with the caller's state untouched.
 */
function applyAdjudication(state, actingUnitId, adjudication) {
  if (!state || typeof state !== 'object' || !Array.isArray(state.units)) return { ok: false, error: 'No combat is loaded.' };
  if (state.outcome) return { ok: false, error: 'This combat has already ended.' };
  if (state.phase !== 'active') return { ok: false, error: 'Combat has not started yet.' };

  const actorPreview = currentUnit(state);
  if (!actorPreview || actorPreview.id !== actingUnitId) return { ok: false, error: 'It is not that combatant\'s turn.' };
  if (!isActionable(actorPreview)) return { ok: false, error: `${actorPreview.name} cannot act right now.` };

  const parsed = parseAdjudication(adjudication);
  if (parsed.error) return { ok: false, error: parsed.error };

  const draft = clone(state);
  const warnings = [];
  let turnAdvanced = false;
  try {
    const actor = currentUnit(draft);
    appendLog(draft, { type: 'action', text: parsed.narration, unitId: actor.id });

    const effects = parsed.effects.slice(0, MAX_EFFECTS_PER_ADJUDICATION);
    if (parsed.effects.length > effects.length) {
      warnings.push(`Only the first ${MAX_EFFECTS_PER_ADJUDICATION} effects were applied.`);
    }
    for (const effect of effects) applyEffect(draft, actor, effect, warnings);

    const apCost = clamp(parsed.costs.ap, 0, Math.max(0, Number(actor.ap) || 0));
    const bpCost = clamp(parsed.costs.bp, 0, Math.max(0, Number(actor.bp) || 0));
    actor.ap = Math.max(0, (Number(actor.ap) || 0) - apCost);
    actor.bp = Math.max(0, (Number(actor.bp) || 0) - bpCost);

    draft.version = (Number(draft.version) || 0) + 1;
    checkOutcome(draft);

    // Spending the action point ENDS the turn, even with bonus points left over.
    // Requiring both pools to be empty deadlocked a live fight: the adjudicator
    // returned turnEnds:false for a player sitting on 0 AP and 1 BP, the turn
    // never advanced, and the enemy turns (which only run when a route advances
    // the turn) never came. A player who wants their bonus action declares it in
    // the same message and the adjudicator charges ap 1 + bp 1. A free (0-cost)
    // action still leaves the turn open, so talk and glances cost nothing.
    const done = parsed.turnEnds || actor.ap <= 0 || actor.side === 'enemy' || !isActionable(actor);
    if (!draft.outcome && done) {
      advanceToNextActor(draft);
      turnAdvanced = true;
    }
  } catch (error) {
    return { ok: false, error: `The adjudication could not be applied: ${error.message}` };
  }

  commit(state, draft);
  return { ok: true, state, warnings, turnAdvanced, outcome: state.outcome || null };
}

/* ------------------------------------------------------------------ *
 * Player dice rolls
 * ------------------------------------------------------------------ */

/**
 * Outcome band for a d20 result, in the exact words the combat adjudicator
 * prompt is written against. A natural 1 or 20 overrides the total.
 *
 * The engine owns this table because the roll log line needs it; the pure
 * integration layer re-exports it rather than keeping a second copy that could
 * drift away from the prompt.
 */
function describeRollBand(total, natural) {
  const face = Math.floor(Number(natural) || 0);
  if (face === 1) return 'critical failure';
  if (face === 20) return 'critical success';
  const value = Math.floor(Number(total) || 0);
  if (value <= 7) return 'failure';
  if (value <= 12) return 'partial success';
  if (value <= 17) return 'solid success';
  if (value <= 22) return 'better than hoped';
  return 'extraordinary';
}

/**
 * Logs the d20 a player physically rolled, e.g.
 * `Violeta rolls 14 +3 DEX = 17 (solid success).`
 *
 * Players reported their rolls being ignored: the number was buried in freeform
 * action text and nothing ever echoed it. Writing it into the shared log puts it
 * in front of the table AND inside the recent-log slice the adjudicator reads,
 * so the roll is on the record before anything is resolved. Call it BEFORE
 * adjudication. Does not bump `version` — the adjudication that follows does.
 *
 * @param {Object} state - NTC combat state
 * @param {string} unitId - the rolling unit
 * @param {Object|null} roll - `{natural, modifier, stat, total}` (a parsed tag)
 * @returns {Object|null} the appended log entry, or null when nothing was logged
 */
function logPlayerRoll(state, unitId, roll) {
  if (!state || !Array.isArray(state.log) || !roll || typeof roll !== 'object') return null;
  const unit = findUnit(state, unitId);
  if (!unit) return null;

  const natural = clamp(Math.floor(Number(roll.natural) || 0), 1, 20);
  const modifier = clamp(Math.floor(Number(roll.modifier) || 0), -99, 99);
  const total = Number.isFinite(Number(roll.total)) ? Math.floor(Number(roll.total)) : natural + modifier;
  const stat = roll.stat ? sanitizeText(roll.stat, 16).toUpperCase() : '';

  const modifierText = modifier === 0 && !stat
    ? ''
    : ` ${modifier < 0 ? '-' : '+'}${Math.abs(modifier)}${stat ? ` ${stat}` : ''} = ${total}`;
  const text = `${unit.name} rolls ${natural}${modifierText} (${describeRollBand(total, natural)}).`;

  appendLog(state, { type: 'roll', text, unitId: unit.id });
  return state.log[state.log.length - 1] || null;
}

/* ------------------------------------------------------------------ *
 * Character-sheet writeback
 * ------------------------------------------------------------------ */

/**
 * Sheet deltas the caller should persist after every applied adjudication.
 *
 * `null` is the "never tracked on this unit" sentinel — callers must NOT
 * overwrite the stored column in that case. `inventory: null` covers migrated
 * schema-1 units; `spellSlots: null` covers a unit with no spell-slot object at
 * all (coercing that to `{}` used to blank the sheet's stored slots).
 *
 * An EMPTY slot table reports `null` for the same reason. It is truthy, so it
 * used to pass the caller's "did this unit carry slots?" check and stamp
 * `spell_slots = '{}'` back over the sheet on every single turn action — which
 * re-broke a sheet the moment after a backfill repaired it. Combat only ever
 * spends slots, so it has nothing to say about a unit that has none.
 */
function collectCharacterWriteback(state) {
  if (!state || !Array.isArray(state.units)) return [];
  return state.units
    .filter(unit => unit.side === 'party' && unit.sourceCharacterId != null)
    .map(unit => ({
      characterId: unit.sourceCharacterId,
      hp: Math.max(0, Number(unit.hp) || 0),
      spellSlots: unit.spellSlots && typeof unit.spellSlots === 'object'
        && !Array.isArray(unit.spellSlots) && Object.keys(unit.spellSlots).length
        ? clone(unit.spellSlots)
        : null,
      inventory: Array.isArray(unit.inventory) ? clone(unit.inventory) : null
    }));
}

/* ------------------------------------------------------------------ *
 * Migration (schema 1 grid state → schema 2 narrative state)
 * ------------------------------------------------------------------ */

function migratedUnit(unit, index, orderIndex) {
  const hp = Math.max(0, Number(unit.hp) || 0);
  const migrated = {
    id: String(unit.id || `unit:${index}`),
    name: sanitizeText(unit.name || 'Combatant', 80) || 'Combatant',
    side: unit.side === 'enemy' ? 'enemy' : 'party',
    imageUrl: String(unit.imageUrl || '').slice(0, 500),
    hp,
    maxHp: Math.max(1, Number(unit.maxHp) || hp || 1),
    ac: clamp(Number(unit.ac) || 10, 1, 30),
    attackBonus: Number(unit.attackBonus) || 0,
    damageBonus: Number(unit.damageBonus) || 0,
    damageDie: clamp(Number(unit.damageDie) || 6, 4, 20),
    initiativeBonus: Number(unit.initiativeBonus) || 0,
    initiative: 30 - orderIndex,
    ap: 1,
    apMax: 1,
    bp: 1,
    bpMax: 1,
    conditions: []
  };
  if (unit.sourceCharacterId != null) migrated.sourceCharacterId = unit.sourceCharacterId;
  if (unit.spellSlots && typeof unit.spellSlots === 'object') migrated.spellSlots = parseSpellSlots(unit.spellSlots);
  if (Array.isArray(unit.powers)) {
    migrated.powers = unit.powers.slice(0, MAX_POWERS_PER_UNIT).map(power => {
      const { range, ...rest } = power || {};
      return rest;
    });
  }
  if (unit.powerUses && typeof unit.powerUses === 'object') migrated.powerUses = { ...unit.powerUses };
  if (migrated.side === 'party') {
    // Grid combat never tracked the sheet: null is the "re-read from DB" sentinel.
    migrated.inventory = null;
    migrated.spellsText = null;
    migrated.classFeatures = null;
    migrated.classResourcesRaw = null;
  }
  if (!migrated.hp) migrated.conditions.push(migrated.side === 'party' ? 'unconscious' : 'dead');
  return migrated;
}

/**
 * Transcodes a schema-1 tactical blob into schema-2 narrative state.
 * Idempotent: schema-2 input is returned untouched.
 */
function fromTacticalState(oldBlob) {
  if (!oldBlob || typeof oldBlob !== 'object' || Array.isArray(oldBlob)) return null;
  if (Number(oldBlob.schema) === COMBAT_SCHEMA_VERSION) return oldBlob;

  const source = clone(oldBlob);
  const rawUnits = Array.isArray(source.units) ? source.units : [];
  const rawOrder = Array.isArray(source.turnOrder) ? source.turnOrder.map(String) : [];
  const knownIds = new Set(rawUnits.map(unit => String(unit.id)));
  const turnOrder = rawOrder.filter(id => knownIds.has(id));
  for (const unit of rawUnits) {
    if (!turnOrder.includes(String(unit.id))) turnOrder.push(String(unit.id));
  }

  const seed = Number(source.seed) || 1;
  const state = {
    schema: COMBAT_SCHEMA_VERSION,
    name: sanitizeText(source.name || 'Combat Encounter', 120) || 'Combat Encounter',
    environment: sanitizeText(source.environment || 'plains', 50) || 'plains',
    phase: 'active',
    round: Math.max(1, Math.floor(Number(source.round) || 1)),
    turnIndex: 0,
    turnOrder,
    pendingInitiative: [],
    outcome: OUTCOMES.includes(source.outcome) ? source.outcome : null,
    units: rawUnits.map((unit, index) => migratedUnit(unit, index, turnOrder.indexOf(String(unit.id)))),
    log: (Array.isArray(source.log) ? source.log : []).slice(-MAX_LOG_ENTRIES).map(entry => ({
      type: String(entry?.type || 'info'),
      text: String(entry?.text || ''),
      round: Math.max(1, Math.floor(Number(entry?.round) || Number(source.round) || 1))
    })).filter(entry => entry.text),
    seed,
    rngState: Number(source.rngState) || seed,
    version: Math.max(1, Math.floor(Number(source.version) || 1))
  };

  const rawIndex = Math.floor(Number(source.turnIndex));
  state.turnIndex = Number.isFinite(rawIndex) ? clamp(rawIndex, 0, Math.max(0, turnOrder.length - 1)) : 0;
  if (source.deferredTurn && typeof source.deferredTurn === 'object') state.deferredTurn = source.deferredTurn;

  const active = currentUnit(state);
  if (active) beginTurn(active);
  if (active && !isActionable(active)) advanceToNextActor(state);
  return state;
}

/* ------------------------------------------------------------------ *
 * Read helpers
 * ------------------------------------------------------------------ */

function getCombatSummary(state, events = []) {
  if (!state || !Array.isArray(state.units)) return 'Combat state unavailable.';
  const eventLines = (Array.isArray(events) ? events : []).map(event => event?.text).filter(Boolean);
  const lines = eventLines.length
    ? eventLines
    : (Array.isArray(state.log) ? state.log : []).slice(-6).map(entry => entry?.text).filter(Boolean);
  const party = state.units
    .filter(unit => unit.side === 'party')
    .map(unit => `${unit.name} ${unit.hp}/${unit.maxHp} HP`)
    .join(', ');
  const headline = state.outcome ? `Combat ${state.outcome}.` : `Combat round ${state.round}.`;
  return `${headline} ${lines.join(' ')} Party status: ${party}.`.replace(/\s+/g, ' ').trim();
}

function isPlayerTurn(state, characterId) {
  if (!state || state.phase !== 'active' || state.outcome) return false;
  const unit = currentUnit(state);
  if (!unit || unit.side !== 'party') return false;
  return String(unit.sourceCharacterId) === String(characterId);
}

function serialize(state) {
  return JSON.stringify(state);
}

/** Parses a stored blob and lazily migrates schema-1 grid states. */
function deserialize(blob) {
  let parsed = blob;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed || 'null'); } catch (error) { return null; }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return Number(parsed.schema) === COMBAT_SCHEMA_VERSION ? parsed : fromTacticalState(parsed);
}

module.exports = {
  COMBAT_SCHEMA_VERSION,
  MAX_COMBATANTS_PER_SIDE,
  MAX_LOG_ENTRIES,
  MAX_EFFECT_AMOUNT,
  OUTCOMES,
  advanceToNextActor,
  applyAdjudication,
  buildEnemyPreRolls,
  checkOutcome,
  collectCharacterWriteback,
  createCombat,
  currentUnit,
  describeRollBand,
  deserialize,
  findUnit,
  fromTacticalState,
  getCombatSummary,
  getEnemyTurnContext,
  isActionable,
  isPlayerTurn,
  logPlayerRoll,
  normalizeAutoCombatSetup,
  rollInitiative,
  rollRemainingInitiative,
  serialize
};
