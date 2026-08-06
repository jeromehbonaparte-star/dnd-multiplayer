const test = require('node:test');
const assert = require('node:assert/strict');
const {
  advanceToNextActor,
  applyAdjudication,
  buildEnemyPreRolls,
  collectCharacterWriteback,
  createCombat,
  currentUnit,
  deserialize,
  findUnit,
  fromTacticalState,
  getCombatSummary,
  getEnemyTurnContext,
  isPlayerTurn,
  normalizeAutoCombatSetup,
  rollInitiative,
  rollRemainingInitiative
} = require('../server/services/combatService');

const party = [
  {
    id: 'fighter',
    character_name: 'Mara',
    class: 'Fighter',
    level: 3,
    hp: 28,
    max_hp: 28,
    ac: 16,
    strength: 16,
    dexterity: 12,
    inventory: JSON.stringify([{ name: 'Potion of Healing', quantity: 2 }, { name: 'Rope', quantity: 1 }]),
    class_features: 'Second Wind, Action Surge',
    class_resources: '{"secondWind":{"max":1}}'
  },
  {
    id: 'wizard',
    character_name: 'Orrin',
    class: 'Wizard',
    level: 3,
    hp: 18,
    max_hp: 18,
    ac: 12,
    dexterity: 14,
    intelligence: 16,
    spells: 'Fire Bolt, Magic Missile',
    spell_slots: JSON.stringify({ 1: { current: 2, max: 2 } }),
    inventory: '[]'
  }
];

const enemies = [{ id: 'goblin', name: 'Goblin', hp: 14, ac: 12, attackBonus: 4, damageDie: 6, damageBonus: 2 }];

function newCombat(overrides = {}) {
  return createCombat({ name: 'Ambush', environment: 'forest', characters: party, enemies, seed: 77, ...overrides });
}

/** Mara rolls a 21 total, so she always leads the order. */
function startCombat(overrides = {}) {
  const state = newCombat(overrides);
  rollInitiative(state, 'pc:fighter', 20);
  rollInitiative(state, 'pc:wizard', 3);
  return state;
}

/**
 * A hand-built schema-1 blob in the exact shape the retired tactical grid
 * service used to persist (grid + per-unit x/y/movement/range/hasMoved/
 * defending). The service itself is gone; this fixture keeps the migration
 * path under test. Mirrors `createTacticalCombat(party, enemies, ...)`.
 */
function tacticalFixture({ seed = 99, environment = 'forest', rngState = 1548709294 } = {}) {
  return {
    version: 1,
    seed,
    rngState,
    environment,
    grid: {
      width: 10,
      height: 8,
      tiles: Array.from({ length: 8 }, (unused, y) =>
        Array.from({ length: 10 }, (ignored, x) => (x === 4 && (y === 2 || y === 5) ? 'forest' : 'plains')))
    },
    units: [
      {
        id: 'pc:fighter',
        sourceCharacterId: 'fighter',
        name: 'Mara',
        side: 'party',
        imageUrl: '',
        hp: 28,
        maxHp: 28,
        ac: 16,
        initiativeBonus: 1,
        attackBonus: 5,
        damageBonus: 3,
        damageDie: 10,
        range: 1,
        movement: 5,
        spellSlots: {},
        powers: [
          { id: 'ability:class', source: 'ability', slotLevel: 0, attackBonus: 5, damageDie: 8, bonus: 3, name: 'Second Wind', kind: 'heal', range: 0, maxUses: 1 }
        ],
        powerUses: {},
        x: 0,
        y: 1,
        hasMoved: false,
        hasActed: false,
        defending: false
      },
      {
        id: 'pc:wizard',
        sourceCharacterId: 'wizard',
        name: 'Orrin',
        side: 'party',
        imageUrl: '',
        hp: 18,
        maxHp: 18,
        ac: 12,
        initiativeBonus: 2,
        attackBonus: 5,
        damageBonus: 3,
        damageDie: 8,
        range: 3,
        movement: 6,
        spellSlots: { 1: { current: 2, max: 2 } },
        powers: [
          { id: 'spell:0', name: 'Fire Bolt', source: 'spell', kind: 'attack', slotLevel: 0, range: 4, attackBonus: 5, damageDie: 6, bonus: 3 },
          { id: 'spell:1', name: 'Magic Missile', source: 'spell', kind: 'attack', slotLevel: 1, range: 4, attackBonus: 5, damageDie: 8, bonus: 3 }
        ],
        powerUses: {},
        x: 0,
        y: 2,
        hasMoved: false,
        hasActed: false,
        defending: false
      },
      {
        id: 'npc:goblin',
        name: 'Goblin',
        side: 'enemy',
        hp: 14,
        maxHp: 14,
        ac: 12,
        initiativeBonus: 0,
        attackBonus: 4,
        damageBonus: 2,
        damageDie: 6,
        range: 1,
        movement: 6,
        x: 4,
        y: 1,
        hasMoved: true,
        hasActed: true,
        defending: false
      }
    ],
    turnOrder: ['npc:goblin', 'pc:wizard', 'pc:fighter'],
    turnIndex: 1,
    round: 2,
    outcome: null,
    log: [
      { type: 'start', text: `Combat begins in the ${environment}.` },
      { type: 'move', text: 'Goblin advances.', unitId: 'npc:goblin', from: { x: 9, y: 1 }, to: { x: 4, y: 1 } },
      { type: 'wait', text: 'Goblin holds position.', unitId: 'npc:goblin' },
      { type: 'turn', text: "Orrin's turn.", unitId: 'pc:wizard' }
    ]
  };
}

/** Jump the turn pointer to a specific unit with a fresh point budget. */
function focus(state, unitId) {
  state.turnIndex = state.turnOrder.indexOf(unitId);
  const unit = findUnit(state, unitId);
  unit.ap = unit.apMax;
  unit.bp = unit.bpMax;
  return unit;
}

test('createCombat opens in the initiative phase with enemies pre-rolled', () => {
  const state = newCombat();
  assert.equal(state.schema, 2);
  assert.equal(state.phase, 'initiative');
  assert.equal(state.version, 1);
  assert.deepEqual(state.turnOrder, []);
  assert.deepEqual(state.pendingInitiative, ['pc:fighter', 'pc:wizard']);
  assert.equal(typeof findUnit(state, 'npc:goblin').initiative, 'number');
  assert.equal(findUnit(state, 'pc:fighter').initiative, null);
  assert.equal(state.outcome, null);
  assert.ok(!('grid' in state));
  for (const unit of state.units) {
    assert.equal(unit.ap, 1);
    assert.equal(unit.apMax, 1);
    assert.equal(unit.bp, 1);
    assert.equal(unit.bpMax, 1);
    assert.deepEqual(unit.conditions, []);
    assert.ok(!('x' in unit) && !('movement' in unit) && !('range' in unit) && !('defending' in unit));
  }
});

test('party units carry the whole character sheet into combat', () => {
  const state = newCombat();
  const mara = findUnit(state, 'pc:fighter');
  assert.deepEqual(mara.inventory, [{ name: 'Potion of Healing', quantity: 2 }, { name: 'Rope', quantity: 1 }]);
  assert.equal(mara.classFeatures, 'Second Wind, Action Surge');
  assert.equal(mara.classResourcesRaw, '{"secondWind":{"max":1}}');
  assert.ok(mara.powers.some(power => power.name === 'Second Wind'));

  const orrin = findUnit(state, 'pc:wizard');
  assert.deepEqual(orrin.spellSlots, { 1: { current: 2, max: 2 } });
  assert.equal(orrin.spellsText, 'Fire Bolt, Magic Missile');
  assert.deepEqual(orrin.inventory, []);

  const broken = createCombat({ characters: [{ ...party[0], inventory: '{not json' }], enemies, seed: 5 });
  assert.deepEqual(findUnit(broken, 'pc:fighter').inventory, []);
});

test('initiative rolls activate combat and sort the turn order descending', () => {
  const state = newCombat();
  const first = rollInitiative(state, 'pc:fighter', 20);
  assert.equal(first.ok, true);
  assert.equal(state.phase, 'initiative');
  assert.equal(findUnit(state, 'pc:fighter').initiative, 21);

  const second = rollInitiative(state, 'pc:wizard', 3);
  assert.equal(second.activated, true);
  assert.equal(state.phase, 'active');
  assert.equal(state.round, 1);
  assert.equal(state.turnOrder.length, 3);
  assert.deepEqual(state.pendingInitiative, []);

  const initiatives = state.turnOrder.map(id => findUnit(state, id).initiative);
  assert.deepEqual(initiatives, [...initiatives].sort((left, right) => right - left));
  assert.equal(currentUnit(state).id, 'pc:fighter');
  assert.ok(state.log.some(entry => entry.type === 'turn' && entry.text === "Mara's turn."));
});

test('initiative rejects bad rolls, unknown units and double rolls', () => {
  const state = newCombat();
  assert.equal(rollInitiative(state, 'pc:fighter', 0).ok, false);
  assert.equal(rollInitiative(state, 'pc:fighter', 21).ok, false);
  assert.equal(rollInitiative(state, 'pc:fighter', 'twelve').ok, false);
  assert.equal(rollInitiative(state, 'pc:ghost', 12).ok, false);
  assert.equal(rollInitiative(state, 'pc:fighter', 12).ok, true);
  assert.match(rollInitiative(state, 'pc:fighter', 12).error, /already rolled/i);
  assert.equal(state.phase, 'initiative');
});

test('the GM can server-roll every straggler at once', () => {
  const state = newCombat();
  rollInitiative(state, 'pc:fighter', 11);
  const result = rollRemainingInitiative(state);
  assert.equal(result.ok, true);
  assert.equal(result.rolled, 1);
  assert.equal(state.phase, 'active');
  assert.equal(state.units.filter(unit => typeof unit.initiative === 'number').length, 3);
  assert.equal(rollRemainingInitiative(state).ok, false);
});

test('adjudications from a combatant who is not up are rejected without touching state', () => {
  const state = startCombat();
  const version = state.version;
  const result = applyAdjudication(state, 'pc:wizard', { narration: 'Orrin casts out of turn.', costs: { ap: 1, bp: 0 } });
  assert.equal(result.ok, false);
  assert.match(result.error, /not that combatant/i);
  assert.equal(state.version, version);
  assert.equal(currentUnit(state).id, 'pc:fighter');
});

test('a turn can hold multiple actions until the point budget is spent', () => {
  const state = startCombat();
  const first = applyAdjudication(state, 'pc:fighter', {
    narration: 'Mara hacks at the goblin.',
    costs: { ap: 1, bp: 0 },
    effects: [{ type: 'damage', target: 'Goblin', amount: 4 }],
    turnEnds: false
  });
  assert.equal(first.ok, true);
  assert.equal(first.turnAdvanced, false);
  assert.equal(currentUnit(state).id, 'pc:fighter');
  assert.equal(findUnit(state, 'pc:fighter').ap, 0);
  assert.equal(findUnit(state, 'pc:fighter').bp, 1);
  assert.equal(findUnit(state, 'npc:goblin').hp, 10);
  assert.equal(state.version, 4);

  const second = applyAdjudication(state, 'pc:fighter', {
    narration: 'She shoves the goblin back with her shield.',
    costs: { ap: 0, bp: 1 }
  });
  assert.equal(second.turnAdvanced, true);
  assert.notEqual(currentUnit(state).id, 'pc:fighter');
  assert.ok(state.log.some(entry => entry.type === 'action' && /shoves/.test(entry.text)));
});

test('costs are clamped to the points the actor actually has', () => {
  const state = startCombat();
  const result = applyAdjudication(state, 'pc:fighter', {
    narration: 'Mara unleashes a flurry.',
    costs: { ap: 9, bp: 9 }
  });
  assert.equal(result.ok, true);
  assert.equal(result.turnAdvanced, true);
  assert.equal(findUnit(state, 'pc:fighter').ap, 0);
  assert.equal(findUnit(state, 'pc:fighter').bp, 0);
});

test('a downed PC falls unconscious while a downed enemy is dead', () => {
  const state = startCombat();
  focus(state, 'npc:goblin');
  const result = applyAdjudication(state, 'npc:goblin', {
    narration: 'The goblin drives its blade home.',
    costs: { ap: 1, bp: 0 },
    effects: [{ type: 'damage', target: 'Mara', amount: 999 }]
  });
  assert.equal(result.ok, true);
  const mara = findUnit(state, 'pc:fighter');
  assert.equal(mara.hp, 0);
  assert.ok(mara.conditions.includes('unconscious'));
  assert.equal(result.turnAdvanced, true, 'enemy turns always hand off');
  assert.equal(state.outcome, null);

  const twoEnemies = createCombat({
    characters: party,
    enemies: [{ id: 'a', name: 'Goblin', hp: 6 }, { id: 'b', name: 'Goblin', hp: 6 }],
    seed: 12
  });
  rollRemainingInitiative(twoEnemies);
  focus(twoEnemies, 'pc:fighter');
  applyAdjudication(twoEnemies, 'pc:fighter', {
    narration: 'Mara cleaves the first goblin down.',
    costs: { ap: 1, bp: 1 },
    effects: [{ type: 'damage', target: 'Goblin 1', amount: 30 }]
  });
  const slain = findUnit(twoEnemies, 'npc:a');
  assert.equal(slain.hp, 0);
  assert.ok(slain.conditions.includes('dead'));
  assert.equal(twoEnemies.outcome, null, 'the second goblin keeps the fight alive');
});

test('healing is capped at max HP and revives an unconscious ally', () => {
  const state = startCombat();
  const mara = findUnit(state, 'pc:fighter');
  mara.hp = 0;
  mara.conditions = ['unconscious'];
  focus(state, 'pc:wizard');
  const result = applyAdjudication(state, 'pc:wizard', {
    narration: 'Orrin pours healing light into Mara.',
    costs: { ap: 1, bp: 0 },
    effects: [{ type: 'heal', target: 'Mara', amount: 999 }]
  });
  assert.equal(result.ok, true);
  assert.equal(findUnit(state, 'pc:fighter').hp, 28);
  assert.deepEqual(findUnit(state, 'pc:fighter').conditions, []);
});

test('conditions are deduped, normalized and removable', () => {
  const state = startCombat();
  applyAdjudication(state, 'pc:fighter', {
    narration: 'Mara trips the goblin.',
    costs: { ap: 1, bp: 0 },
    effects: [
      { type: 'condition', target: 'Goblin', add: 'PRONE' },
      { type: 'condition', target: 'Goblin', add: 'prone' }
    ]
  });
  assert.deepEqual(findUnit(state, 'npc:goblin').conditions, ['prone']);
  applyAdjudication(state, 'pc:fighter', {
    narration: 'The goblin scrambles upright.',
    costs: { ap: 0, bp: 1 },
    effects: [{ type: 'condition', target: 'Goblin', remove: 'prone' }]
  });
  assert.deepEqual(findUnit(state, 'npc:goblin').conditions, []);
});

test('wiping a side ends the combat', () => {
  const state = startCombat();
  const result = applyAdjudication(state, 'pc:fighter', {
    narration: 'Mara ends the goblin in one stroke.',
    costs: { ap: 1, bp: 1 },
    effects: [{ type: 'damage', target: 'Goblin', amount: 50 }]
  });
  assert.equal(result.outcome, 'victory');
  assert.equal(state.outcome, 'victory');
  assert.equal(result.turnAdvanced, false);
  assert.equal(applyAdjudication(state, 'pc:fighter', { narration: 'again' }).ok, false);
});

test('the adjudicator can end combat without a wipe', () => {
  const state = startCombat();
  const result = applyAdjudication(state, 'pc:fighter', {
    narration: 'Mara talks the goblin into standing down.',
    costs: { ap: 1, bp: 0 },
    effects: [{ type: 'endCombat', outcome: 'resolved', reason: 'the goblin surrenders' }]
  });
  assert.equal(result.outcome, 'resolved');
  assert.equal(findUnit(state, 'npc:goblin').hp > 0, true);
  assert.match(getCombatSummary(state), /^Combat resolved\./);

  const bogus = startCombat();
  const rejected = applyAdjudication(bogus, 'pc:fighter', {
    narration: 'Mara declares total annihilation.',
    costs: { ap: 1, bp: 0 },
    effects: [{ type: 'endCombat', outcome: 'apocalypse' }]
  });
  assert.equal(rejected.ok, true);
  assert.equal(bogus.outcome, null);
  assert.equal(rejected.warnings.length, 1);
});

test('malformed adjudications are refused and leave the state untouched', () => {
  const state = startCombat();
  const snapshot = JSON.stringify(state);
  const cases = [null, 'not json at all', [], {}, { narration: '' }, { narration: 42 }, { narration: 'ok', effects: 'nope' }, { narration: 'ok', costs: [] }];
  for (const payload of cases) {
    const result = applyAdjudication(state, 'pc:fighter', payload);
    assert.equal(result.ok, false, `expected refusal for ${JSON.stringify(payload)}`);
    assert.ok(result.error);
    assert.equal(result.state, undefined);
  }
  assert.equal(JSON.stringify(state), snapshot);
  assert.equal(state.version, 3);
});

test('targets resolve by id, exact name and unique substring', () => {
  const state = startCombat();
  const result = applyAdjudication(state, 'pc:fighter', {
    narration: 'Mara strikes twice and blesses herself.',
    costs: { ap: 1, bp: 0 },
    effects: [
      { type: 'damage', target: 'npc:goblin', amount: 1 },
      { type: 'damage', target: 'goblin', amount: 1 },
      { type: 'damage', target: 'gob', amount: 1 },
      { type: 'condition', target: 'Mar', add: 'blessed' }
    ]
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.warnings, []);
  assert.equal(findUnit(state, 'npc:goblin').hp, 11);
  assert.deepEqual(findUnit(state, 'pc:fighter').conditions, ['blessed']);
});

test('ambiguous and unknown targets are skipped with warnings', () => {
  const state = createCombat({
    characters: party,
    enemies: [{ id: 'a', name: 'Goblin' }, { id: 'b', name: 'Goblin' }],
    seed: 31
  });
  rollRemainingInitiative(state);
  focus(state, 'pc:fighter');
  const before = state.units.map(unit => unit.hp);
  const result = applyAdjudication(state, 'pc:fighter', {
    narration: 'Mara swings wildly.',
    costs: { ap: 1, bp: 0 },
    effects: [
      { type: 'damage', target: 'Goblin', amount: 5 },
      { type: 'damage', target: 'Ancient Red Dragon', amount: 5 },
      { type: 'damage', amount: 5 }
    ]
  });
  assert.equal(result.ok, true);
  assert.equal(result.warnings.length, 3);
  assert.match(result.warnings[0], /ambiguous/i);
  assert.match(result.warnings[1], /no combatant named/i);
  assert.match(result.warnings[2], /no target was named/i);
  assert.deepEqual(state.units.map(unit => unit.hp), before);
});

test('unsupported and malformed effect entries are ignored, not fatal', () => {
  const state = startCombat();
  const result = applyAdjudication(state, 'pc:fighter', {
    narration: 'Mara does something the rules do not cover.',
    costs: { ap: 1, bp: 0 },
    effects: [{ type: 'teleport', target: 'Mara' }, 'nonsense', null]
  });
  assert.equal(result.ok, true);
  assert.equal(result.warnings.length, 3);
  assert.match(result.warnings[0], /unsupported effect type "teleport"/i);
});

test('spell slots are spent, floored and refused when exhausted', () => {
  const state = startCombat();
  focus(state, 'pc:wizard');
  const first = applyAdjudication(state, 'pc:wizard', {
    narration: 'Orrin looses magic missiles.',
    costs: { ap: 1, bp: 0 },
    effects: [{ type: 'spendSlot', target: 'Orrin', level: 1 }, { type: 'damage', target: 'Goblin', amount: 6 }]
  });
  assert.equal(first.ok, true);
  assert.deepEqual(first.warnings, []);
  assert.equal(findUnit(state, 'pc:wizard').spellSlots['1'].current, 1);

  const wizard = findUnit(state, 'pc:wizard');
  wizard.spellSlots['1'].current = 0;
  focus(state, 'pc:wizard');
  const exhausted = applyAdjudication(state, 'pc:wizard', {
    narration: 'Orrin reaches for a spell that is not there.',
    costs: { ap: 1, bp: 0 },
    effects: [{ type: 'spendSlot', target: 'Orrin', level: 1 }, { type: 'spendSlot', target: 'Orrin', level: 5 }]
  });
  assert.equal(exhausted.ok, true);
  assert.equal(findUnit(state, 'pc:wizard').spellSlots['1'].current, 0);
  assert.equal(exhausted.warnings.length, 2);
  assert.match(exhausted.warnings[0], /no level 1 spell slots left/i);
  assert.match(exhausted.warnings[1], /no level 5 spell slots/i);
});

test('items are consumed from the sheet inventory and removed at zero', () => {
  const state = startCombat();
  const drink = () => {
    focus(state, 'pc:fighter');
    return applyAdjudication(state, 'pc:fighter', {
      narration: 'Mara drinks a potion.',
      costs: { ap: 1, bp: 0 },
      effects: [{ type: 'useItem', target: 'Mara', item: 'potion of healing' }]
    });
  };

  assert.deepEqual(drink().warnings, []);
  assert.deepEqual(findUnit(state, 'pc:fighter').inventory.find(item => item.name === 'Potion of Healing'), { name: 'Potion of Healing', quantity: 1 });

  assert.deepEqual(drink().warnings, []);
  assert.equal(findUnit(state, 'pc:fighter').inventory.some(item => item.name === 'Potion of Healing'), false);
  assert.equal(findUnit(state, 'pc:fighter').inventory.length, 1);

  const missing = drink();
  assert.equal(missing.ok, true);
  assert.equal(missing.warnings.length, 1);
  assert.match(missing.warnings[0], /has no "potion of healing"/i);

  focus(state, 'pc:fighter');
  const nameless = applyAdjudication(state, 'pc:fighter', {
    narration: 'Mara rummages in her pack.',
    costs: { ap: 1, bp: 0 },
    effects: [{ type: 'useItem', target: 'Mara' }]
  });
  assert.match(nameless.warnings[0], /no item name/i);
});

test('abilities and freeform resources are tracked through powerUses', () => {
  const state = startCombat();
  const result = applyAdjudication(state, 'pc:fighter', {
    narration: 'Mara catches her second wind and burns some grit.',
    costs: { ap: 1, bp: 1 },
    effects: [
      { type: 'useAbility', target: 'Mara', ability: 'Second Wind' },
      { type: 'spendResource', target: 'Mara', resource: 'Grit', amount: 2 }
    ]
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.warnings, []);
  const mara = findUnit(state, 'pc:fighter');
  assert.equal(mara.powerUses['ability:class'], 1);
  assert.equal(mara.powerUses.Grit, 2);
});

test('collectCharacterWriteback exposes per-character sheet deltas', () => {
  const state = startCombat();
  focus(state, 'pc:wizard');
  applyAdjudication(state, 'pc:wizard', {
    narration: 'Orrin burns a slot and takes a hit.',
    costs: { ap: 1, bp: 1 },
    effects: [
      { type: 'spendSlot', target: 'Orrin', level: 1 },
      { type: 'damage', target: 'Orrin', amount: 5 }
    ]
  });

  const writeback = collectCharacterWriteback(state);
  assert.equal(writeback.length, 2);
  assert.deepEqual(writeback.map(entry => entry.characterId).sort(), ['fighter', 'wizard']);
  const wizard = writeback.find(entry => entry.characterId === 'wizard');
  assert.equal(wizard.hp, 13);
  assert.deepEqual(wizard.spellSlots, { 1: { current: 1, max: 2 } });
  assert.deepEqual(wizard.inventory, []);
  const fighter = writeback.find(entry => entry.characterId === 'fighter');
  assert.equal(fighter.inventory.length, 2);
  assert.ok(!writeback.some(entry => String(entry.characterId).startsWith('npc')));
  assert.notEqual(wizard.spellSlots, findUnit(state, 'pc:wizard').spellSlots);
});

test('the turn walker skips downed units and rolls the round over', () => {
  const state = startCombat();
  findUnit(state, 'pc:wizard').hp = 0;
  findUnit(state, 'pc:wizard').conditions = ['unconscious'];
  const seen = [];
  for (let step = 0; step < 4; step++) seen.push(advanceToNextActor(state)?.id);
  assert.equal(seen.includes('pc:wizard'), false);
  assert.ok(state.round > 1);
});

test('enemy pre-rolls are seeded, bounded and aim at the weakest PC', () => {
  const state = startCombat();
  findUnit(state, 'pc:wizard').hp = 4;
  const preRolls = buildEnemyPreRolls(state, 'npc:goblin');
  assert.ok(preRolls.attackRoll.d20 >= 1 && preRolls.attackRoll.d20 <= 20);
  assert.equal(preRolls.attackRoll.bonus, 4);
  assert.equal(preRolls.attackRoll.total, preRolls.attackRoll.d20 + 4);
  assert.equal(preRolls.damageRoll.die, 6);
  assert.ok(preRolls.damageRoll.rolls.length >= 1);
  assert.equal(preRolls.damageRoll.total, preRolls.damageRoll.rolls.reduce((sum, value) => sum + value, 0) + 2);
  assert.equal(preRolls.targetSuggestion.id, 'pc:wizard');
  assert.ok(buildEnemyPreRolls(state, 'pc:fighter').error);

  const context = getEnemyTurnContext(state, 'npc:goblin');
  assert.equal(context.enemy.id, 'npc:goblin');
  assert.equal(context.foes.length, 2);
  assert.ok(context.preRolls.attackRoll);
  assert.ok(Array.isArray(context.recentLog));
});

test('the combat log stays capped at 80 entries', () => {
  const state = startCombat();
  for (let step = 0; step < 100; step++) {
    focus(state, 'pc:fighter');
    applyAdjudication(state, 'pc:fighter', {
      narration: `Mara feints, round ${step}.`,
      costs: { ap: 0, bp: 0 }
    });
  }
  assert.equal(state.log.length, 80);
  assert.match(state.log[state.log.length - 1].text, /round 99/);
});

test('isPlayerTurn only fires for the active party member', () => {
  const state = startCombat();
  assert.equal(isPlayerTurn(state, 'fighter'), true);
  assert.equal(isPlayerTurn(state, 'wizard'), false);
  focus(state, 'npc:goblin');
  assert.equal(isPlayerTurn(state, 'fighter'), false);
});

test('normalizeAutoCombatSetup clamps hostile stats and drops grid fields', () => {
  const setup = normalizeAutoCombatSetup({
    name: 'Ambush at Delphi',
    environment: 'RUINS!!!',
    enemies: [{ name: 'Cultist', hp: 9999, ac: -4, attackBonus: 80, damageDie: 100, movement: 9, range: 5 }]
  });
  assert.equal(setup.name, 'Ambush at Delphi');
  assert.equal(setup.environment, 'ruins');
  assert.equal(setup.enemies[0].hp, 500);
  assert.equal(setup.enemies[0].ac, 1);
  assert.equal(setup.enemies[0].attackBonus, 25);
  assert.equal(setup.enemies[0].damageDie, 20);
  assert.ok(!('movement' in setup.enemies[0]));
  assert.ok(!('range' in setup.enemies[0]));
  assert.equal(normalizeAutoCombatSetup({ enemies: [] }), null);
  assert.equal(normalizeAutoCombatSetup(null), null);
});

test('fromTacticalState transcodes a live grid fight without losing progress', () => {
  const old = tacticalFixture({ seed: 99, environment: 'forest' });
  old.name = 'Ambush at the ford';
  old.round = 3;
  old.deferredTurn = { openingResolution: 'Goblins burst from the treeline.', startedAt: '2026-08-06T01:02:03.000Z' };
  const woundedId = old.units[0].id;
  old.units[0].hp = 5;
  const oldOrder = [...old.turnOrder];

  const state = fromTacticalState(old);
  assert.equal(state.schema, 2);
  assert.equal(state.phase, 'active');
  assert.deepEqual(state.pendingInitiative, []);
  assert.equal(state.name, 'Ambush at the ford');
  assert.equal(state.environment, 'forest');
  assert.equal(state.round, 3);
  assert.deepEqual(state.turnOrder, oldOrder);
  assert.equal(state.seed, old.seed);
  assert.equal(state.rngState, old.rngState);
  assert.equal(state.version, old.version);
  assert.deepEqual(state.deferredTurn, {
    openingResolution: 'Goblins burst from the treeline.',
    startedAt: '2026-08-06T01:02:03.000Z'
  });
  assert.ok(!('grid' in state));
  assert.equal(state.log.length, old.log.length);

  assert.equal(findUnit(state, woundedId).hp, 5);
  const wizard = state.units.find(unit => unit.sourceCharacterId === 'wizard');
  assert.deepEqual(wizard.spellSlots, { 1: { current: 2, max: 2 } });
  assert.ok(wizard.powers.some(power => power.name === 'Magic Missile'));
  assert.ok(wizard.powers.every(power => !('range' in power)));
  assert.equal(wizard.inventory, null, 'inventory is re-read from the DB after migration');
  assert.equal(wizard.spellsText, null);

  for (const unit of state.units) {
    assert.ok(!('x' in unit) && !('y' in unit) && !('movement' in unit) && !('range' in unit));
    assert.ok(!('hasMoved' in unit) && !('hasActed' in unit) && !('defending' in unit));
    assert.equal(unit.apMax, 1);
    assert.equal(unit.bpMax, 1);
    assert.equal(typeof unit.initiative, 'number');
  }

  const synthesized = state.turnOrder.map(id => findUnit(state, id).initiative);
  assert.deepEqual(synthesized, [...synthesized].sort((left, right) => right - left));
  assert.equal(synthesized[0], 30);

  const writeback = collectCharacterWriteback(state);
  assert.equal(writeback.every(entry => entry.inventory === null), true);
});

test('fromTacticalState and deserialize are idempotent on schema-2 state', () => {
  const state = startCombat();
  assert.equal(fromTacticalState(state), state);
  assert.equal(deserialize(state), state);
  assert.equal(deserialize(JSON.stringify(state)).schema, 2);
  assert.equal(fromTacticalState(null), null);
  assert.equal(deserialize('{not json'), null);

  const old = tacticalFixture({ seed: 5, environment: 'plains', rngState: 1306475959 });
  const migrated = deserialize(JSON.stringify(old));
  assert.equal(migrated.schema, 2);
  assert.equal(fromTacticalState(migrated), migrated);
});

test('getCombatSummary reports the outcome, recent beats and party health', () => {
  const state = startCombat();
  assert.match(getCombatSummary(state), /^Combat round 1\./);
  assert.match(getCombatSummary(state), /Mara 28\/28 HP, Orrin 18\/18 HP\.$/);
  applyAdjudication(state, 'pc:fighter', {
    narration: 'Mara finishes the goblin.',
    costs: { ap: 1, bp: 1 },
    effects: [{ type: 'damage', target: 'Goblin', amount: 40 }]
  });
  const summary = getCombatSummary(state);
  assert.match(summary, /^Combat victory\./);
  assert.match(summary, /Mara finishes the goblin\./);
  assert.match(getCombatSummary(state, [{ text: 'Explicit event line.' }]), /Explicit event line\./);
});
