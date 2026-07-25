const test = require('node:test');
const assert = require('node:assert/strict');
const {
  activeUnit,
  applyTacticalAction,
  createTacticalCombat,
  getReachableTiles,
  normalizeAutoCombatSetup
} = require('../server/services/tacticalCombatService');

const party = [
  { id: 'fighter', character_name: 'Mara', class: 'Fighter', level: 3, hp: 28, max_hp: 28, ac: 16, strength: 16, dexterity: 12 },
  { id: 'wizard', character_name: 'Orrin', class: 'Wizard', level: 3, hp: 18, max_hp: 18, ac: 12, strength: 8, dexterity: 14, intelligence: 16 }
];

const enemies = [{ id: 'goblin', name: 'Goblin', hp: 14, ac: 12, attackBonus: 4, damageDie: 6, damageBonus: 2 }];

test('tactical combat starts on a living party member and owns source characters', () => {
  const state = createTacticalCombat(party, enemies, { seed: 77, environment: 'forest' });
  const unit = activeUnit(state);
  assert.equal(unit.side, 'party');
  assert.ok(unit.sourceCharacterId);
  assert.equal(state.grid.width, 10);
  assert.equal(state.grid.height, 8);
});

test('movement is server-validated and does not hand off the turn', () => {
  const state = createTacticalCombat(party, enemies, { seed: 77 });
  const unit = activeUnit(state);
  const destination = getReachableTiles(state, unit).find(tile => tile.x !== unit.x || tile.y !== unit.y);
  assert.ok(destination);
  const result = applyTacticalAction(state, { type: 'move', x: destination.x, y: destination.y });
  assert.equal(result.ok, true);
  assert.equal(activeUnit(result.state).id, unit.id);
  assert.equal(activeUnit(result.state).hasMoved, true);
});

test('ending a party turn resolves intervening enemies before another player turn', () => {
  const state = createTacticalCombat(party, enemies, { seed: 77 });
  const result = applyTacticalAction(state, { type: 'endTurn' });
  assert.equal(result.ok, true);
  if (!result.state.outcome) assert.equal(activeUnit(result.state).side, 'party');
  assert.ok(result.events.some(event => event.type === 'turn') || result.state.outcome);
});

test('rejects actions outside the active character turn', () => {
  const state = createTacticalCombat(party, enemies, { seed: 77 });
  const result = applyTacticalAction(state, { type: 'attack', targetId: 'npc:missing' });
  assert.equal(result.ok, false);
});

test('normalizes an AI combat handoff into bounded tactical enemies', () => {
  const setup = normalizeAutoCombatSetup({
    name: 'Ambush\u0000 at Delphi',
    environment: 'RUINS!!!',
    enemies: [{ name: 'Cultist', hp: 9999, ac: -4, attackBonus: 80, damageDie: 100 }]
  });
  assert.equal(setup.name, 'Ambush at Delphi');
  assert.equal(setup.environment, 'ruins');
  assert.equal(setup.enemies[0].hp, 500);
  assert.equal(setup.enemies[0].ac, 1);
  assert.equal(setup.enemies[0].attackBonus, 25);
  assert.equal(setup.enemies[0].damageDie, 20);
});

test('rejects automatic combat without enemies', () => {
  assert.equal(normalizeAutoCombatSetup({ name: 'False alarm', enemies: [] }), null);
  assert.equal(normalizeAutoCombatSetup(null), null);
});

test('party spell actions use stored slots and resolve on the server', () => {
  const spellParty = [{
    ...party[1],
    spells: 'Fire Bolt, Magic Missile, Cure Wounds',
    spell_slots: JSON.stringify({ 1: { current: 2, max: 2 } })
  }];
  const state = createTacticalCombat(spellParty, [{ ...enemies[0], range: 8 }], { seed: 77 });
  const unit = activeUnit(state);
  const magicMissile = unit.powers.find(power => power.name === 'Magic Missile');
  const target = state.units.find(candidate => candidate.side === 'enemy');
  target.x = Math.min(state.grid.width - 1, unit.x + magicMissile.range);
  target.y = unit.y;
  const result = applyTacticalAction(state, { type: 'power', powerId: magicMissile.id, targetId: target.id });
  assert.equal(result.ok, true);
  assert.equal(result.state.units.find(candidate => candidate.id === unit.id).spellSlots['1'].current, 1);
  assert.ok(result.events.some(event => event.powerName === 'Magic Missile'));
});

test('combat powers cannot be used without their required resource', () => {
  const spellParty = [{
    ...party[1],
    spells: 'Magic Missile',
    spell_slots: JSON.stringify({ 1: { current: 0, max: 2 } })
  }];
  const state = createTacticalCombat(spellParty, enemies, { seed: 77 });
  const unit = activeUnit(state);
  const power = unit.powers.find(candidate => candidate.name === 'Magic Missile');
  const target = state.units.find(candidate => candidate.side === 'enemy');
  const result = applyTacticalAction(state, { type: 'power', powerId: power.id, targetId: target.id });
  assert.equal(result.ok, false);
  assert.match(result.error, /no uses remaining/i);
});

test('core class abilities are available and tracked by the combat state', () => {
  const state = createTacticalCombat([party[0]], enemies, { seed: 77 });
  const unit = activeUnit(state);
  unit.hp = 10;
  const secondWind = unit.powers.find(power => power.name === 'Second Wind');
  const result = applyTacticalAction(state, { type: 'power', powerId: secondWind.id, targetId: unit.id });
  assert.equal(result.ok, true);
  const updated = result.state.units.find(candidate => candidate.id === unit.id);
  assert.ok(updated.hp > 10);
  assert.equal(updated.powerUses[secondWind.id], 1);
});
