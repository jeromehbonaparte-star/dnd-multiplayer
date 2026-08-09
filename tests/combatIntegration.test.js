/**
 * Unit C3 — narrative-combat server integration helpers.
 *
 * DB-free by design: better-sqlite3 cannot load under local Node, so the route
 * layer is covered through the pure decision helpers it delegates to (broadcast
 * shaping, writeback SQL arguments, migration hydration, the enemy fallback
 * adjudication, the stall cap and input normalization).
 */

const test = require('node:test');
const assert = require('node:assert');

const combatIntegration = require('../server/services/combatIntegration');
const combatService = require('../server/services/combatService');
const { buildConversationMessages, planCompaction } = require('../server/services/turnProcessor');

function makeCharacter(overrides = {}) {
  return {
    id: 'char-1',
    character_name: 'Ayla',
    class: 'Fighter',
    level: 3,
    strength: 16,
    dexterity: 14,
    constitution: 14,
    intelligence: 10,
    wisdom: 12,
    charisma: 8,
    hp: 24,
    max_hp: 24,
    ac: 16,
    spell_slots: '{"1":{"current":2,"max":2}}',
    inventory: '[{"name":"Potion of Healing","quantity":2}]',
    spells: 'Fire Bolt, Cure Wounds',
    class_features: 'Second Wind, Action Surge',
    class_resources: '{"secondWind":1}',
    image_url: '',
    ...overrides
  };
}

function makeEnemy(overrides = {}) {
  return { id: 'g1', name: 'Goblin', hp: 10, ac: 12, attackBonus: 4, damageDie: 6, damageBonus: 2, ...overrides };
}

function makeState({ characters, enemies, seed = 12345 } = {}) {
  return combatService.createCombat({
    name: 'Ambush on the road',
    environment: 'forest',
    characters: characters || [makeCharacter()],
    enemies: enemies || [makeEnemy()],
    seed
  });
}

function makeActiveState(options) {
  const state = makeState(options);
  combatService.rollRemainingInitiative(state);
  return state;
}

/* ------------------------------------------------------------------ *
 * Input normalization
 * ------------------------------------------------------------------ */

test('normalizeCombatAction rejects anything that is not usable action text', () => {
  assert.ok(combatIntegration.normalizeCombatAction(undefined).error);
  assert.ok(combatIntegration.normalizeCombatAction(42).error);
  assert.ok(combatIntegration.normalizeCombatAction('   ').error);
});

test('normalizeCombatAction keeps newlines (the dice tag rides on its own line) but drops control characters', () => {
  const result = combatIntegration.normalizeCombatAction('  I swing at the goblin.\n[DICE ROLL: 17]  ');
  assert.equal(result.error, undefined);
  assert.equal(result.action, 'I swing at the goblin.\n[DICE ROLL: 17]');
});

test('normalizeCombatAction caps the action at the prompt limit', () => {
  const result = combatIntegration.normalizeCombatAction('a'.repeat(5000));
  assert.equal(result.action.length, combatIntegration.COMBAT_ACTION_MAX_CHARS);
});

test('normalizeInitiativeRoll accepts only an integer d20 face', () => {
  assert.deepEqual(combatIntegration.normalizeInitiativeRoll(1), { roll: 1 });
  assert.deepEqual(combatIntegration.normalizeInitiativeRoll('20'), { roll: 20 });
  assert.ok(combatIntegration.normalizeInitiativeRoll(0).error);
  assert.ok(combatIntegration.normalizeInitiativeRoll(21).error);
  assert.ok(combatIntegration.normalizeInitiativeRoll(4.5).error);
  assert.ok(combatIntegration.normalizeInitiativeRoll('nine').error);
});

/* ------------------------------------------------------------------ *
 * Player dice rolls
 * ------------------------------------------------------------------ */

test('parseDiceRollTag reads the full client tag', () => {
  assert.deepEqual(
    combatIntegration.parseDiceRollTag('I charge the goblin. [DICE ROLL: d20 = 14 +3 DEX (score 16) = 17]'),
    { natural: 14, modifier: 3, stat: 'DEX', score: 16, total: 17, raw: '[DICE ROLL: d20 = 14 +3 DEX (score 16) = 17]' }
  );
});

test('parseDiceRollTag reads the bare natural-only tag', () => {
  const roll = combatIntegration.parseDiceRollTag('[DICE ROLL: d20 = 14]');
  assert.equal(roll.natural, 14);
  assert.equal(roll.modifier, 0);
  assert.equal(roll.stat, null);
  assert.equal(roll.score, null);
  assert.equal(roll.total, 14, 'with no modifier the total is the face value');
});

test('parseDiceRollTag is case-insensitive, whitespace-tolerant and handles negative modifiers', () => {
  const roll = combatIntegration.parseDiceRollTag('  [dice roll:   d20  =  9  - 1  STR  ( score  8 )  =  8 ]  ');
  assert.equal(roll.natural, 9);
  assert.equal(roll.modifier, -1);
  assert.equal(roll.stat, 'STR');
  assert.equal(roll.score, 8);
  assert.equal(roll.total, 8);
});

test('parseDiceRollTag uses the LAST tag when several are present', () => {
  const roll = combatIntegration.parseDiceRollTag('[DICE ROLL: d20 = 3] I hesitate, then commit. [DICE ROLL: d20 = 20 +5 STR (score 20) = 25]');
  assert.equal(roll.natural, 20);
  assert.equal(roll.total, 25);
});

test('parseDiceRollTag clamps an impossible d20 face and rejects malformed tags', () => {
  assert.equal(combatIntegration.parseDiceRollTag('[DICE ROLL: d20 = 25 +3 DEX (score 16) = 28]').natural, 20);
  assert.equal(combatIntegration.parseDiceRollTag('[DICE ROLL: banana]'), null);
  assert.equal(combatIntegration.parseDiceRollTag('[DICE ROLL: 17]'), null);
  assert.equal(combatIntegration.parseDiceRollTag('I swing with no roll at all.'), null);
  assert.equal(combatIntegration.parseDiceRollTag(''), null);
  assert.equal(combatIntegration.parseDiceRollTag(null), null);
  assert.equal(combatIntegration.parseDiceRollTag(42), null);
});

test('stripDiceRollTag removes every tag and tidies the leftover whitespace', () => {
  assert.equal(
    combatIntegration.stripDiceRollTag('I swing at the goblin.\n[DICE ROLL: d20 = 14 +3 DEX (score 16) = 17]'),
    'I swing at the goblin.'
  );
  assert.equal(combatIntegration.stripDiceRollTag('  [DICE ROLL: d20 = 4]  I   duck away.  '), 'I duck away.');
  assert.equal(
    combatIntegration.stripDiceRollTag('[DICE ROLL: d20 = 4] I feint [DICE ROLL: d20 = 11] and lunge.'),
    'I feint and lunge.'
  );
  assert.equal(combatIntegration.stripDiceRollTag('[DICE ROLL: d20 = 4]'), '');
  assert.equal(combatIntegration.stripDiceRollTag(null), '');
});

test('describeRollBand matches the bands written into the adjudicator prompt', () => {
  assert.equal(combatIntegration.describeRollBand(30, 1), 'critical failure');
  assert.equal(combatIntegration.describeRollBand(2, 20), 'critical success');
  assert.equal(combatIntegration.describeRollBand(7, 5), 'failure');
  assert.equal(combatIntegration.describeRollBand(8, 5), 'partial success');
  assert.equal(combatIntegration.describeRollBand(13, 10), 'solid success');
  assert.equal(combatIntegration.describeRollBand(18, 15), 'better than hoped');
  assert.equal(combatIntegration.describeRollBand(23, 18), 'extraordinary');
});

test('normalizePlayerRoll clamps into a safe echo-able shape', () => {
  assert.deepEqual(
    combatIntegration.normalizePlayerRoll({ natural: '14', modifier: '3', stat: 'dex!', score: 16, total: '17', raw: '[...]' }),
    { natural: 14, modifier: 3, stat: 'DEX', score: 16, total: 17, band: 'solid success' }
  );
  assert.deepEqual(
    combatIntegration.normalizePlayerRoll({ natural: 99, modifier: 9999, total: 1e9 }),
    { natural: 20, modifier: 99, stat: null, score: null, total: 999, band: 'critical success' }
  );
  assert.deepEqual(
    combatIntegration.normalizePlayerRoll({ natural: 12 }),
    { natural: 12, modifier: 0, stat: null, score: null, total: 12, band: 'partial success' }
  );
  assert.equal(combatIntegration.normalizePlayerRoll(null), null);
  assert.equal(combatIntegration.normalizePlayerRoll({}), null);
  assert.equal(combatIntegration.normalizePlayerRoll([{ natural: 5 }]), null);
  assert.equal(combatIntegration.normalizePlayerRoll('14'), null);
});

test('a parsed tag round-trips through the log line the players see', () => {
  const state = makeActiveState();
  const unit = combatService.currentUnit(state);
  const roll = combatIntegration.parseDiceRollTag('I lunge. [DICE ROLL: d20 = 14 +3 DEX (score 16) = 17]');
  const entry = combatService.logPlayerRoll(state, unit.id, roll);
  assert.equal(entry.type, 'roll');
  assert.equal(entry.text, `${unit.name} rolls 14 +3 DEX = 17 (solid success).`);
});

/* ------------------------------------------------------------------ *
 * Schema-1 migration hydration
 * ------------------------------------------------------------------ */

test('parseStoredInventory reads the stored JSON shape and degrades safely', () => {
  assert.deepEqual(
    combatIntegration.parseStoredInventory('[{"name":"Rope","quantity":1}]'),
    [{ name: 'Rope', quantity: 1 }]
  );
  assert.deepEqual(combatIntegration.parseStoredInventory('not json'), []);
  assert.deepEqual(combatIntegration.parseStoredInventory(null), []);
  assert.deepEqual(combatIntegration.parseStoredInventory(['Torch']), [{ name: 'Torch', quantity: 1 }]);
});

test('unitsNeedingHydration finds exactly the migrated party units carrying the null sentinel', () => {
  const legacy = {
    schema: 1,
    round: 2,
    turnIndex: 0,
    turnOrder: ['pc:char-1', 'npc:g1'],
    units: [
      { id: 'pc:char-1', sourceCharacterId: 'char-1', name: 'Ayla', side: 'party', hp: 12, maxHp: 24, ac: 16 },
      { id: 'npc:g1', name: 'Goblin', side: 'enemy', hp: 7, maxHp: 10, ac: 12 }
    ],
    log: [],
    seed: 3,
    rngState: 3,
    version: 4
  };
  const migrated = combatService.deserialize(legacy);
  assert.equal(migrated.schema, combatService.COMBAT_SCHEMA_VERSION);
  const pending = combatIntegration.unitsNeedingHydration(migrated);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, 'pc:char-1');

  // A freshly created (schema-2) combat needs nothing re-read.
  assert.equal(combatIntegration.unitsNeedingHydration(makeState()).length, 0);
});

test('hydrateMigratedUnit fills the sheet from the character row', () => {
  const unit = { id: 'pc:char-1', side: 'party', sourceCharacterId: 'char-1', inventory: null, spellsText: null };
  const hydrated = combatIntegration.hydrateMigratedUnit(unit, makeCharacter());
  assert.equal(hydrated, true);
  assert.deepEqual(unit.inventory, [{ name: 'Potion of Healing', quantity: 2 }]);
  assert.equal(unit.spellsText, 'Fire Bolt, Cure Wounds');
  assert.equal(unit.classFeatures, 'Second Wind, Action Surge');
  assert.equal(unit.classResourcesRaw, '{"secondWind":1}');
});

test('hydrateMigratedUnit leaves the sentinel alone when the character row is gone', () => {
  const unit = { id: 'pc:ghost', side: 'party', sourceCharacterId: 'ghost', inventory: null };
  assert.equal(combatIntegration.hydrateMigratedUnit(unit, null), false);
  assert.equal(unit.inventory, null);
});

test('hydrateMigratedUnit never touches enemies or already-hydrated units', () => {
  const enemy = { id: 'npc:g1', side: 'enemy', inventory: null };
  assert.equal(combatIntegration.hydrateMigratedUnit(enemy, makeCharacter()), false);
  const fresh = { id: 'pc:char-1', side: 'party', sourceCharacterId: 'char-1', inventory: [{ name: 'Rope', quantity: 1 }] };
  assert.equal(combatIntegration.hydrateMigratedUnit(fresh, makeCharacter()), false);
  assert.deepEqual(fresh.inventory, [{ name: 'Rope', quantity: 1 }]);
});

/* ------------------------------------------------------------------ *
 * Character writeback
 * ------------------------------------------------------------------ */

test('buildCharacterWritebackStatements writes inventory only when the unit tracks it', () => {
  const statements = combatIntegration.buildCharacterWritebackStatements([
    { characterId: 'a', hp: 11, spellSlots: { 1: { current: 1, max: 2 } }, inventory: [{ name: 'Rope', quantity: 1 }] },
    { characterId: 'b', hp: 0, spellSlots: {}, inventory: null }
  ]);
  assert.equal(statements.length, 2);
  assert.match(statements[0].sql, /SET hp = \?, spell_slots = \?, inventory = \? WHERE id = \?$/);
  assert.deepEqual(statements[0].args, [11, '{"1":{"current":1,"max":2}}', '[{"name":"Rope","quantity":1}]', 'a']);
  // An empty slot table is a sentinel, not an edit: it must not reach the column.
  assert.match(statements[1].sql, /SET hp = \? WHERE id = \?$/);
  assert.deepEqual(statements[1].args, [0, 'b']);
});

test('buildCharacterWritebackStatements never stamps an empty slot table over the sheet', () => {
  const [statement] = combatIntegration.buildCharacterWritebackStatements([
    { characterId: 'a', hp: 9, spellSlots: {}, inventory: [{ name: 'Rope', quantity: 1 }] }
  ]);
  assert.ok(
    !statement.sql.includes('spell_slots'),
    "an empty slot table is truthy, but writing '{}' every turn re-blanked a repaired sheet"
  );
  assert.match(statement.sql, /SET hp = \?, inventory = \? WHERE id = \?$/);
  assert.deepEqual(statement.args, [9, '[{"name":"Rope","quantity":1}]', 'a']);
});

test('buildCharacterWritebackStatements floors HP and skips rows without a character id', () => {
  const statements = combatIntegration.buildCharacterWritebackStatements([
    { characterId: null, hp: 5 },
    { characterId: 'c', hp: -4, spellSlots: null, inventory: null }
  ]);
  assert.equal(statements.length, 1);
  // Both sentinels are null, so hp is the only column touched.
  assert.match(statements[0].sql, /SET hp = \? WHERE id = \?$/);
  assert.deepEqual(statements[0].args, [0, 'c']);
});

test('buildCharacterWritebackStatements never blanks spell_slots for a unit that has none', () => {
  const [statement] = combatIntegration.buildCharacterWritebackStatements([
    { characterId: 'a', hp: 7, spellSlots: null, inventory: [{ name: 'Rope', quantity: 1 }] }
  ]);
  assert.match(statement.sql, /SET hp = \?, inventory = \? WHERE id = \?$/);
  assert.ok(!statement.sql.includes('spell_slots'), 'a null spellSlots sentinel must leave the stored column alone');
  assert.deepEqual(statement.args, [7, '[{"name":"Rope","quantity":1}]', 'a']);
});

test('collectCharacterWriteback reports null spellSlots for a unit lacking the key', () => {
  const state = makeActiveState();
  const unit = state.units.find(candidate => candidate.side === 'party');
  delete unit.spellSlots;
  const [writeback] = combatService.collectCharacterWriteback(state);
  assert.equal(writeback.spellSlots, null);

  unit.spellSlots = { 1: { current: 0, max: 2 } };
  const [withSlots] = combatService.collectCharacterWriteback(state);
  assert.deepEqual(withSlots.spellSlots, { 1: { current: 0, max: 2 } });
});

test('collectCharacterWriteback reports null for an EMPTY slot table, not {}', () => {
  const state = makeActiveState({ characters: [makeCharacter({ spell_slots: '{}' })] });
  const unit = state.units.find(candidate => candidate.side === 'party');
  assert.deepEqual(unit.spellSlots, {}, 'the unit still carries the empty table for the adjudicator');

  const [writeback] = combatService.collectCharacterWriteback(state);
  assert.equal(writeback.spellSlots, null, 'an empty table must not be persisted back over the sheet');

  const [statement] = combatIntegration.buildCharacterWritebackStatements([writeback]);
  assert.ok(!statement.sql.includes('spell_slots'));
});

test('collectCharacterWriteback + buildCharacterWritebackStatements round-trip a live combat', () => {
  const state = makeActiveState();
  const statements = combatIntegration.buildCharacterWritebackStatements(combatService.collectCharacterWriteback(state));
  assert.equal(statements.length, 1);
  assert.equal(statements[0].characterId, 'char-1');
  assert.equal(statements[0].args.length, 4, 'a freshly created unit tracks inventory, so all three columns are written');
});

/* ------------------------------------------------------------------ *
 * Broadcast shaping
 * ------------------------------------------------------------------ */

test('publicCombatState strips private sheet context, powers and RNG state', () => {
  const state = makeActiveState();
  state.deferredTurn = { openingResolution: 'The ambush springs.', startedAt: 'now' };
  const view = combatIntegration.publicCombatState(state);

  assert.equal(view.deferredTurn, undefined);
  assert.equal(view.seed, undefined);
  assert.equal(view.rngState, undefined);
  const party = view.units.find(unit => unit.side === 'party');
  assert.equal(party.spellsText, undefined);
  assert.equal(party.classFeatures, undefined);
  assert.equal(party.classResourcesRaw, undefined);
  assert.equal(party.powers, undefined);
  assert.equal(party.powerUses, undefined);
  assert.equal(party.inventory, undefined);
  assert.equal(party.spellSlots, undefined);
  // ...and keeps everything the tracker renders.
  assert.equal(party.sourceCharacterId, 'char-1');
  assert.equal(typeof party.ap, 'number');
  assert.equal(typeof party.bp, 'number');
  assert.equal(typeof party.initiative, 'number');
  assert.ok(Array.isArray(party.conditions));
  assert.equal(party.down, false);
  assert.equal(view.phase, 'active');
  assert.ok(Array.isArray(view.turnOrder) && view.turnOrder.length === 2);
  assert.deepEqual(view.pendingInitiative, []);
  assert.equal(view.currentUnitId, combatService.currentUnit(state).id);
  assert.equal(view.version, state.version);
});

test('publicCombatState reports the initiative phase before the order locks in', () => {
  const view = combatIntegration.publicCombatState(makeState());
  assert.equal(view.phase, 'initiative');
  assert.equal(view.currentUnitId, null);
  assert.deepEqual(view.pendingInitiative, ['pc:char-1']);
  const enemy = view.units.find(unit => unit.side === 'enemy');
  assert.equal(typeof enemy.initiative, 'number', 'enemies are server-rolled at creation');
});

test('publicCombatState marks a downed unit', () => {
  const state = makeActiveState();
  const party = state.units.find(unit => unit.side === 'party');
  party.hp = 0;
  party.conditions.push('unconscious');
  const view = combatIntegration.publicCombatState(state);
  assert.equal(view.units.find(unit => unit.side === 'party').down, true);
});

test('buildCombatUpdatedPayload carries the tracker fields and caps the event tail', () => {
  const state = makeActiveState();
  const events = Array.from({ length: 30 }, (_, index) => ({ type: 'info', text: `beat ${index}`, round: 1 }));
  const payload = combatIntegration.buildCombatUpdatedPayload({
    sessionId: 'sess-1', combatId: 'combat-1', state, events
  });
  assert.equal(payload.sessionId, 'sess-1');
  assert.equal(payload.combatId, 'combat-1');
  assert.equal(payload.events.length, combatIntegration.BROADCAST_LOG_ENTRIES);
  assert.equal(payload.events[payload.events.length - 1].text, 'beat 29');
  assert.equal(payload.version, state.version);
  assert.equal(payload.phase, 'active');
  assert.equal(payload.currentUnitId, combatService.currentUnit(state).id);
  assert.equal(payload.outcome, null);
  assert.equal(payload.automatic, undefined);
  assert.ok(payload.combat && Array.isArray(payload.combat.units));
});

test('buildCombatUpdatedPayload tears the tracker down once the fight has an outcome', () => {
  const state = makeActiveState();
  state.outcome = 'victory';
  const payload = combatIntegration.buildCombatUpdatedPayload({ sessionId: 's', combatId: 'c', state });
  assert.equal(payload.combat, null);
  assert.equal(payload.combatId, null);
  assert.equal(payload.phase, 'ended');
  assert.equal(payload.outcome, 'victory');
});

test('buildCombatUpdatedPayload flags an auto-started encounter', () => {
  const payload = combatIntegration.buildCombatUpdatedPayload({
    sessionId: 's', combatId: 'c', state: makeState(), automatic: true
  });
  assert.equal(payload.automatic, true);
  assert.equal(payload.phase, 'initiative');
});

test('buildNarrationPayload normalizes the live story-stream append', () => {
  const payload = combatIntegration.buildNarrationPayload({
    sessionId: 's', unitName: 'Goblin', narration: 'It lunges.', round: 3, warnings: ['skipped', null]
  });
  assert.deepEqual(payload, {
    sessionId: 's', unitName: 'Goblin', narration: 'It lunges.', round: 3, warnings: ['skipped']
  });
  assert.deepEqual(combatIntegration.buildNarrationPayload({}).warnings, []);
  assert.equal(combatIntegration.buildNarrationPayload({}).round, 1);
});

test('buildNarrationPayload echoes the player roll and omits it entirely when there is none', () => {
  const payload = combatIntegration.buildNarrationPayload({
    sessionId: 's',
    unitName: 'Ayla',
    narration: 'The axe comes down.',
    round: 2,
    roll: combatIntegration.parseDiceRollTag('[DICE ROLL: d20 = 14 +3 DEX (score 16) = 17]')
  });
  assert.deepEqual(payload.roll, { natural: 14, modifier: 3, stat: 'DEX', score: 16, total: 17, band: 'solid success' });
  assert.equal(payload.roll.raw, undefined, 'the raw tag is not echoed back to clients');
  assert.equal(Object.hasOwn(combatIntegration.buildNarrationPayload({ sessionId: 's' }), 'roll'), false);
  assert.equal(Object.hasOwn(combatIntegration.buildNarrationPayload({ sessionId: 's', roll: {} }), 'roll'), false);
});

/* ------------------------------------------------------------------ *
 * History entries
 * ------------------------------------------------------------------ */

test('buildCombatHistoryEntry is a visible, role-less combat_turn entry', () => {
  const entry = combatIntegration.buildCombatHistoryEntry({ content: 'Steel meets bone.', unitName: 'Ayla', round: 2 });
  assert.equal(entry.type, 'combat_turn');
  assert.equal(entry.content, 'Steel meets bone.');
  assert.equal(entry.unitName, 'Ayla');
  assert.equal(entry.round, 2);
  assert.equal(entry.hidden, undefined, 'combat beats are visible history');
  assert.equal(entry.role, undefined, 'no role keeps it out of the narrator prompt');
  assert.equal(typeof entry.ts, 'string');
  assert.equal(Object.hasOwn(entry, 'roll'), false, 'no roll, no key');
});

test('buildCombatHistoryEntry carries the player roll when the beat came from one', () => {
  const entry = combatIntegration.buildCombatHistoryEntry({
    content: 'Steel meets bone.',
    unitName: 'Ayla',
    round: 2,
    roll: { natural: 20, modifier: 3, stat: 'STR', score: 16, total: 23 }
  });
  assert.deepEqual(entry.roll, { natural: 20, modifier: 3, stat: 'STR', score: 16, total: 23, band: 'critical success' });
});

test('combat_turn entries never reach the narrator prompt or the compaction trigger', () => {
  const base = [
    { role: 'user', type: 'action', character_name: 'Ayla', content: 'I charge.' },
    { role: 'assistant', content: 'The road erupts.' }
  ];
  const withCombat = [
    ...base,
    combatIntegration.buildCombatHistoryEntry({ content: 'x'.repeat(3000), unitName: 'Goblin', round: 1 })
  ];
  assert.deepEqual(buildConversationMessages(withCombat), buildConversationMessages(base));
  assert.equal(
    planCompaction(withCombat, 0, '', 100000).tokens,
    planCompaction(base, 0, '', 100000).tokens,
    'combat beats must not inflate the compaction signal'
  );
});

/* ------------------------------------------------------------------ *
 * Enemy-turn fallback
 * ------------------------------------------------------------------ */

test('buildEnemyFallbackAdjudication deals the pre-rolled damage on a hit', () => {
  const state = makeActiveState();
  const enemy = state.units.find(unit => unit.side === 'enemy');
  const party = state.units.find(unit => unit.side === 'party');
  const adjudication = combatIntegration.buildEnemyFallbackAdjudication(state, enemy.id, {
    attackRoll: { d20: 18, bonus: 4, total: 22 },
    damageRoll: { die: 6, rolls: [5], bonus: 2, total: 7, critical: false },
    targetSuggestion: { id: party.id, name: party.name, hp: party.hp, maxHp: party.maxHp, ac: party.ac }
  });
  assert.deepEqual(adjudication.effects, [{ type: 'damage', target: party.id, amount: 7 }]);
  assert.equal(adjudication.turnEnds, true);
  assert.deepEqual(adjudication.costs, { ap: 1, bp: 0 });
  assert.match(adjudication.narration, /Goblin strikes Ayla for 7 damage\./);
});

test('buildEnemyFallbackAdjudication produces a clean miss below the target AC', () => {
  const state = makeActiveState();
  const enemy = state.units.find(unit => unit.side === 'enemy');
  const party = state.units.find(unit => unit.side === 'party');
  const adjudication = combatIntegration.buildEnemyFallbackAdjudication(state, enemy.id, {
    attackRoll: { d20: 2, bonus: 4, total: 6 },
    damageRoll: { die: 6, rolls: [3], bonus: 2, total: 5, critical: false },
    targetSuggestion: { id: party.id, name: party.name, hp: party.hp, maxHp: party.maxHp, ac: party.ac }
  });
  assert.deepEqual(adjudication.effects, []);
  assert.match(adjudication.narration, /misses/);
});

test('buildEnemyFallbackAdjudication holds position when there is nobody to hit', () => {
  const state = makeActiveState();
  const enemy = state.units.find(unit => unit.side === 'enemy');
  const adjudication = combatIntegration.buildEnemyFallbackAdjudication(state, enemy.id, {
    attackRoll: { d20: 20, bonus: 4, total: 24 },
    damageRoll: { die: 6, rolls: [6], bonus: 2, total: 8, critical: true },
    targetSuggestion: null
  });
  assert.deepEqual(adjudication.effects, []);
  assert.equal(adjudication.turnEnds, true);
});

test('buildEnemyFallbackAdjudication refuses non-enemy units', () => {
  const state = makeActiveState();
  assert.equal(combatIntegration.buildEnemyFallbackAdjudication(state, 'pc:char-1'), null);
  assert.equal(combatIntegration.buildEnemyFallbackAdjudication(state, 'nope'), null);
});

test('the fallback adjudication is applicable by the engine on an enemy turn', () => {
  // Force the enemy to be the active unit, then drive one fallback turn.
  const state = makeActiveState();
  const enemyIndex = state.turnOrder.findIndex(id => id.startsWith('npc:'));
  state.turnIndex = enemyIndex;
  const enemyId = state.turnOrder[enemyIndex];
  const partyBefore = state.units.find(unit => unit.side === 'party').hp;

  const adjudication = combatIntegration.buildEnemyFallbackAdjudication(state, enemyId);
  const result = combatService.applyAdjudication(state, enemyId, adjudication);
  assert.equal(result.ok, true);
  assert.equal(result.turnAdvanced, true, 'enemy turns always auto-advance');
  const partyAfter = state.units.find(unit => unit.side === 'party').hp;
  assert.ok(partyAfter <= partyBefore);
});

/* ------------------------------------------------------------------ *
 * Stall cap
 * ------------------------------------------------------------------ */

test('nextTurnActionCount counts adjudications and resets when the turn moves on', () => {
  const state = { turnActionCount: 3 };
  assert.equal(combatIntegration.nextTurnActionCount(state, false), 4);
  assert.equal(combatIntegration.nextTurnActionCount(state, true), 0);
  assert.equal(combatIntegration.nextTurnActionCount({}, false), 1);
  assert.equal(combatIntegration.turnActionCount({ turnActionCount: -2 }), 0);
});

test('shouldForceTurnEnd trips at the cap, not before', () => {
  assert.equal(combatIntegration.shouldForceTurnEnd(combatIntegration.MAX_TURN_ACTIONS - 1), false);
  assert.equal(combatIntegration.shouldForceTurnEnd(combatIntegration.MAX_TURN_ACTIONS), true);
  assert.equal(combatIntegration.shouldForceTurnEnd(undefined), false);
});

test('forceTurnEnd logs the stall, advances the walker and resets the counter', () => {
  const state = makeActiveState();
  const before = combatService.currentUnit(state);
  state.turnActionCount = combatIntegration.MAX_TURN_ACTIONS;
  const versionBefore = state.version;

  combatIntegration.forceTurnEnd(state);

  assert.equal(state.turnActionCount, 0);
  assert.ok(state.version > versionBefore);
  assert.notEqual(combatService.currentUnit(state).id, before.id);
  assert.ok(state.log.some(entry => entry.text.includes('actions this turn; the turn passes')));
});

test('forceTurnEnd is inert outside an active fight', () => {
  const pending = makeState();
  const snapshot = JSON.stringify(pending);
  combatIntegration.forceTurnEnd(pending);
  assert.equal(JSON.stringify(pending), snapshot);
});

test('passTurn walks the turn on with a neutral, non-stall log line', () => {
  const state = makeActiveState();
  const before = combatService.currentUnit(state);
  const versionBefore = state.version;

  combatIntegration.passTurn(state);

  assert.notEqual(combatService.currentUnit(state).id, before.id);
  assert.ok(state.version > versionBefore);
  assert.equal(state.turnActionCount, 0);
  assert.ok(
    state.log.some(entry => entry.text === `${before.name} ends their turn.`),
    'the pass is logged in the acting unit\'s name'
  );
  assert.ok(
    !state.log.some(entry => entry.text.includes('actions this turn')),
    'a voluntary pass must not read as a stall'
  );
});

test('passTurn is inert outside an active fight', () => {
  const pending = makeState();
  const snapshot = JSON.stringify(pending);
  combatIntegration.passTurn(pending);
  assert.equal(JSON.stringify(pending), snapshot);
});
