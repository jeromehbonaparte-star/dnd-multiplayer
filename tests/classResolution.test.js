'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  CLASS_RULES,
  FULL_CASTER_SLOTS,
  calculateMulticlassSpellcasterLevel,
  computeSlotState,
  getClassName,
  getSpellSlots,
  getExactClassName,
  normalizeClassesMap,
  parseClasses,
  planClassRepair,
  planSpellSlotBackfill,
  resolveClassAndSubclass,
  slotsToState,
  suggestClassNames
} = require('../server/services/classProgressionService.js');

// The service logs a WARN for every non-exact resolution. Swallow it so the
// suite output stays readable, and hand the captured lines back when a test
// wants to assert on them.
function captureWarnings(run) {
  const original = console.warn;
  const lines = [];
  console.warn = (...args) => lines.push(args.join(' '));
  try {
    return { result: run(), lines };
  } finally {
    console.warn = original;
  }
}

describe('resolveClassAndSubclass ladder', () => {
  const cases = [
    // input, className, subclass, matched
    ['Sorcerer', 'Sorcerer', null, 'exact'],
    ['sorcerer', 'Sorcerer', null, 'exact'],
    ['  Fighter  ', 'Fighter', null, 'exact'],
    ['Wild Magic Sorcerer', 'Sorcerer', 'Wild Magic', 'subclass-split'],
    ['Sorcerer (Wild Magic)', 'Sorcerer', 'Wild Magic', 'subclass-split'],
    ['Wild Magic', 'Sorcerer', 'Wild Magic', 'subclass-split'],
    ['Draconic Bloodline', 'Sorcerer', 'Draconic Bloodline', 'subclass-split'],
    ['Eldritch Knight', 'Fighter', 'Eldritch Knight', 'subclass-split'],
    ['Battle Master Fighter', 'Fighter', 'Battle Master', 'subclass-split'],
    ['Berserker Barbarian', 'Barbarian', 'Path of the Berserker', 'subclass-split'],
    ['Warlock of the Fiend', 'Warlock', 'The Fiend', 'subclass-split'],
    ['evocation wizard', 'Wizard', 'School of Evocation', 'subclass-split'],
    ['Life Domain', 'Cleric', 'Life Domain', 'subclass-split'],
    // Garbage with two class tokens: the trailing class token wins and the
    // leftover text is preserved as homebrew subclass wording.
    ['Shadow Fighter Monk', 'Monk', 'Shadow Fighter', 'suffix'],
    ['Frost Wizard', 'Wizard', 'Frost', 'suffix'],
    ['sorceror', 'Sorcerer', null, 'alias'],
    ['Wild Magic sorceror', 'Sorcerer', 'Wild Magic', 'alias']
  ];

  for (const [input, className, subclass, matched] of cases) {
    test(`resolves ${JSON.stringify(input)} to ${className}${subclass ? ` / ${subclass}` : ''} via ${matched}`, () => {
      assert.deepEqual(resolveClassAndSubclass(input), { className, subclass, matched });
    });
  }

  test('returns a null result for text with no class anywhere in it', () => {
    for (const input of ['Frost Mage', 'Blood Hunter', 'banana', '', null, undefined, 42]) {
      assert.deepEqual(resolveClassAndSubclass(input), { className: null, subclass: null, matched: null });
    }
  });

  test('class indexes resolve (SRD indexes equal the lowercased names, so the name rung answers first)', () => {
    const resolved = resolveClassAndSubclass('wizard');
    assert.equal(resolved.className, 'Wizard');
    assert.ok(['exact', 'index'].includes(resolved.matched));
  });
});

describe('getClassName / getExactClassName', () => {
  test('exact matches stay silent and keep the legacy string return', () => {
    const { result, lines } = captureWarnings(() => getClassName('fighter'));
    assert.equal(result, 'Fighter');
    assert.deepEqual(lines, []);
  });

  test('falls through to the ladder and warns once, still returning only the class name', () => {
    const { result, lines } = captureWarnings(() => getClassName('Wild Magic Sorcerer'));
    assert.equal(result, 'Sorcerer');
    assert.equal(lines.length, 1);
    assert.match(lines[0], /Resolved class 'Wild Magic Sorcerer' via subclass-split to Sorcerer/);
  });

  test('returns null for genuinely unknown classes', () => {
    assert.equal(getClassName('Frost Mage'), null);
  });

  test('getExactClassName refuses fuzzy input', () => {
    assert.equal(getExactClassName('Sorcerer'), 'Sorcerer');
    assert.equal(getExactClassName('sorcerer'), 'Sorcerer');
    assert.equal(getExactClassName('Wild Magic Sorcerer'), null);
  });
});

describe('suggestClassNames', () => {
  test('suggests the nearest class for a typo', () => {
    assert.equal(suggestClassNames('Wizrd')[0], 'Wizard');
    assert.equal(suggestClassNames('sorceror')[0], 'Sorcerer');
  });

  test('falls back to the full class list when nothing is close', () => {
    assert.equal(suggestClassNames('Frost Mage').length, 12);
  });
});

describe('spell slot floor guard', () => {
  test('keeps a level the computed progression zeroed out', () => {
    const { state, flooredLevels } = computeSlotState([4, 3, 0], { 3: { max: 3, current: 2 } });
    assert.deepEqual(state['3'], { max: 3, current: 2 });
    assert.deepEqual(flooredLevels, ['3']);
  });

  test('preserves every stored level when the computed array is empty', () => {
    const { state, flooredLevels } = computeSlotState([], { 1: { max: 4, current: 0 }, 2: { max: 3, current: 3 } });
    assert.deepEqual(state, { 1: { max: 4, current: 0 }, 2: { max: 3, current: 3 } });
    assert.deepEqual(flooredLevels, ['1', '2']);
  });

  test('never shrinks capacity but still grows it', () => {
    const { state, flooredLevels } = computeSlotState([2, 0], { 1: { max: 4, current: 4 } });
    assert.deepEqual(state, { 1: { max: 4, current: 4 } });
    assert.deepEqual(flooredLevels, ['1']);
    const grown = computeSlotState([4, 3], { 1: { max: 2, current: 1 } });
    assert.deepEqual(grown.state, { 1: { max: 4, current: 1 }, 2: { max: 3, current: 3 } });
    assert.deepEqual(grown.flooredLevels, []);
  });

  test('slotsToState keeps its legacy signature and drops empty levels', () => {
    assert.deepEqual(slotsToState([2, 0, 0], {}), { 1: { max: 2, current: 2 } });
    assert.deepEqual(slotsToState([0], { 4: { max: 3, current: 1 } }), { 4: { max: 3, current: 1 } });
  });
});

// ============================================
// Pact magic: the floor guard must NOT apply
// ============================================

/**
 * Replays the /levelup slot algorithm one class level at a time, feeding each
 * result back in as the stored state — exactly how a real character accumulates
 * `spell_slots`. `allowShrink` is decided the way the route decides it: any
 * warlock anywhere in the class MAP.
 */
function levelUpSlots(steps) {
  const classes = {};
  let state = {};
  let warnings = 0;
  for (const className of steps) {
    classes[className] = (classes[className] || 0) + 1;
    const casterLevel = calculateMulticlassSpellcasterLevel(classes);
    const slots = casterLevel > 0
      ? (FULL_CASTER_SLOTS[Math.min(20, casterLevel)] || [])
      : getSpellSlots(className, classes[className]);
    const hasPactMagic = Object.keys(classes).some(name => CLASS_RULES[name]?.caster === 'warlock');
    const result = computeSlotState(slots, state, { allowShrink: hasPactMagic });
    if (result.flooredLevels.length) warnings++;
    state = result.state;
  }
  return { state, warnings };
}

const repeat = (name, count) => Array.from({ length: count }, () => name);

describe('pact magic slot progression', () => {
  test('allowShrink lets a slot row move up a level instead of accumulating', () => {
    const { state, flooredLevels } = computeSlotState(
      [0, 0, 0, 0, 2, 0, 0, 0, 0],
      { 4: { max: 2, current: 2 } },
      { allowShrink: true }
    );
    assert.deepEqual(state, { 5: { max: 2, current: 2 } });
    assert.deepEqual(flooredLevels, []);
  });

  test('cumulative Warlock 1 -> 9 keeps only the level 5 pact slots', () => {
    const { state, warnings } = levelUpSlots(repeat('Warlock', 9));
    assert.deepEqual(state, { 5: { max: 2, current: 2 } });
    assert.equal(warnings, 0, 'a clean pact progression must never raise a slot warning');
  });

  test('Warlock 5 and Warlock 20 match the pre-floor progression', () => {
    assert.deepEqual(levelUpSlots(repeat('Warlock', 5)).state, { 3: { max: 2, current: 2 } });
    assert.deepEqual(levelUpSlots(repeat('Warlock', 20)).state, { 5: { max: 4, current: 2 } });
  });

  test('Warlock/Sorcerer multiclass does not accumulate stale pact rows', () => {
    const forward = levelUpSlots([...repeat('Warlock', 6), ...repeat('Sorcerer', 2)]);
    assert.deepEqual(forward.state, { 1: { max: 3, current: 2 } });
    assert.equal(forward.warnings, 0);

    const reversed = levelUpSlots([...repeat('Sorcerer', 2), ...repeat('Warlock', 6)]);
    assert.deepEqual(reversed.state, { 1: { max: 3, current: 2 } });
    assert.equal(reversed.warnings, 0);
  });

  test('a non-pact caster still gets the floor: a misresolved class keeps stored slots', () => {
    const { state, flooredLevels } = computeSlotState([], { 1: { max: 4, current: 2 }, 2: { max: 3, current: 3 } });
    assert.deepEqual(state, { 1: { max: 4, current: 2 }, 2: { max: 3, current: 3 } });
    assert.deepEqual(flooredLevels, ['1', '2']);

    // ...and a pure Wizard progression is untouched by the allowShrink option.
    const wizard = levelUpSlots(repeat('Wizard', 9));
    assert.equal(wizard.warnings, 0);
    assert.deepEqual(wizard.state[5], { max: 1, current: 1 });
  });
});

describe('parseClasses normalization', () => {
  test('normalizes a subclass-flavored key onto the canonical class', () => {
    const { result } = captureWarnings(() => parseClasses('{"Wild Magic Sorcerer":5}', null, 5));
    assert.deepEqual(result, { Sorcerer: 5 });
  });

  test('merges duplicate spellings into one entry at the highest level', () => {
    const { result } = captureWarnings(() => parseClasses('{"fighter":2,"Battle Master Fighter":4}', null, 4));
    assert.deepEqual(result, { Fighter: 4 });
  });

  test('keeps a truly unresolvable key verbatim and warns', () => {
    const { result, lines } = captureWarnings(() => parseClasses('{"Frost Mage":3}', null, 3));
    assert.deepEqual(result, { 'Frost Mage': 3 });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /unresolvable class key 'Frost Mage'/);
  });

  test('normalizes the primary-class fallback too', () => {
    const { result } = captureWarnings(() => parseClasses('{}', 'Wild Magic Sorcerer', 4));
    assert.deepEqual(result, { Sorcerer: 4 });
  });
});

describe('normalizeClassesMap write boundary', () => {
  test('canonicalizes keys and reports split subclasses', () => {
    const normalized = normalizeClassesMap({ 'Wild Magic Sorcerer': 3, rogue: 2 });
    assert.deepEqual(normalized.classes, { Sorcerer: 3, Rogue: 2 });
    assert.deepEqual(normalized.subclasses, { Sorcerer: 'Wild Magic' });
    assert.deepEqual(normalized.unresolved, []);
  });

  test('accepts a JSON string and reports unresolvable keys without keeping them', () => {
    const normalized = normalizeClassesMap('{"Frost Mage":3,"Wizard":2}');
    assert.deepEqual(normalized.classes, { Wizard: 2 });
    assert.deepEqual(normalized.unresolved, ['Frost Mage']);
  });

  test('tolerates junk input', () => {
    for (const input of [null, undefined, '', 'not json', '[1,2]', 7]) {
      assert.deepEqual(normalizeClassesMap(input), { classes: {}, subclasses: {}, unresolved: [] });
    }
  });
});

describe('planClassRepair', () => {
  test('repairs a "Wild Magic Sorcerer" row into class + subclass choice', () => {
    const plan = planClassRepair({
      id: 'c1',
      class: 'Wild Magic Sorcerer',
      classes: '{"Wild Magic Sorcerer":5}',
      class_choices: '{}'
    });
    assert.equal(plan.changed, true);
    assert.equal(plan.className, 'Sorcerer');
    assert.equal(plan.subclass, 'Wild Magic');
    assert.equal(plan.matched, 'subclass-split');
    assert.equal(plan.updates.class, 'Sorcerer');
    assert.deepEqual(JSON.parse(plan.updates.classes), { Sorcerer: 5 });
    assert.deepEqual(JSON.parse(plan.updates.class_choices), { Sorcerer: { subclass: 'Wild Magic' } });
    assert.deepEqual(plan.unresolved, []);
  });

  test('is idempotent — a repaired row produces no further updates', () => {
    const repaired = {
      id: 'c1',
      class: 'Sorcerer',
      classes: '{"Sorcerer":5}',
      class_choices: '{"Sorcerer":{"subclass":"Wild Magic"}}'
    };
    const plan = planClassRepair(repaired);
    assert.equal(plan.changed, false);
    assert.deepEqual(plan.updates, {});
  });

  test('merges levels when the canonical key already exists', () => {
    const plan = planClassRepair({
      id: 'c2',
      class: 'Fighter',
      classes: '{"Fighter":3,"fighter":5}',
      class_choices: '{}'
    });
    assert.deepEqual(JSON.parse(plan.updates.classes), { Fighter: 5 });
  });

  test('never overwrites a subclass the player already chose', () => {
    const plan = planClassRepair({
      id: 'c3',
      class: 'Wild Magic Sorcerer',
      classes: '{}',
      class_choices: '{"Sorcerer":{"subclass":"Draconic Bloodline"}}'
    });
    assert.equal(plan.updates.class, 'Sorcerer');
    assert.equal(plan.updates.class_choices, undefined);
  });

  test('leaves an unresolvable class untouched and reports it', () => {
    const plan = planClassRepair({ id: 'c4', class: 'Frost Mage', classes: '{"Frost Mage":3}', class_choices: '{}' });
    assert.equal(plan.changed, false);
    assert.deepEqual(plan.updates, {});
    assert.deepEqual(plan.unresolved, ['Frost Mage']);
    assert.equal(plan.className, null);
  });

  test('normalizes a legacy index-cased row', () => {
    const plan = planClassRepair({ id: 'c5', class: 'sorcerer', classes: '{"sorcerer":2}', class_choices: '{}' });
    assert.equal(plan.updates.class, 'Sorcerer');
    assert.deepEqual(JSON.parse(plan.updates.classes), { Sorcerer: 2 });
  });

  test('survives malformed JSON columns', () => {
    const plan = planClassRepair({ id: 'c6', class: 'Wizard', classes: 'not json', class_choices: 'nope' });
    assert.equal(plan.changed, false);
    assert.equal(plan.className, 'Wizard');
  });
});

// ============================================
// Spell-slot backfill plan
// ============================================
//
// The rule the startup migration and the ai-create enrichment both run. The
// migration loop itself needs SQLite (which cannot load here), so the DECISION
// is tested through this pure planner and the loop is a thin wrapper over it.

describe('planSpellSlotBackfill', () => {
  test('fills the level-appropriate table for a caster whose column is empty', () => {
    const plan = planSpellSlotBackfill({
      id: 'violeta', class: 'Sorcerer', classes: '{"Sorcerer":3}', level: 3, spell_slots: '{}'
    });
    assert.equal(plan.fill, true);
    assert.equal(plan.reason, 'fill');
    assert.deepEqual(plan.state, { 1: { max: 4, current: 4 }, 2: { max: 2, current: 2 } });
    assert.equal(plan.json, JSON.stringify(plan.state));
  });

  test('every filled level comes back at full capacity — a fresh long rest', () => {
    const plan = planSpellSlotBackfill({ class: 'Wizard', classes: '{"Wizard":9}', level: 9, spell_slots: null });
    assert.equal(plan.fill, true);
    for (const [level, slot] of Object.entries(plan.state)) {
      assert.equal(slot.current, slot.max, `level ${level} must be restored to full`);
    }
  });

  test('resolves a free-text multiclass key through the same ladder as level-up', () => {
    const plan = planSpellSlotBackfill({
      class: 'Wild Magic Sorcerer', classes: '{"Wild Magic Sorcerer":3}', level: 3, spell_slots: ''
    });
    assert.deepEqual(plan.classLevels, { Sorcerer: 3 });
    assert.deepEqual(plan.state, { 1: { max: 4, current: 4 }, 2: { max: 2, current: 2 } });
  });

  test('falls back to the class column when the classes map is unusable', () => {
    const plan = planSpellSlotBackfill({ class: 'Bard', classes: '{}', level: 2, spell_slots: '{}' });
    assert.deepEqual(plan.classLevels, { Bard: 2 });
    assert.deepEqual(plan.state, { 1: { max: 3, current: 3 } });
  });

  test('uses the multiclass caster level, and pact magic for a pure Warlock', () => {
    const mixed = planSpellSlotBackfill({
      class: 'Fighter', classes: '{"Fighter":3,"Wizard":2}', level: 5, spell_slots: '{}'
    });
    assert.equal(mixed.casterLevel, 2);
    assert.deepEqual(mixed.state, { 1: { max: 3, current: 3 } });

    const warlock = planSpellSlotBackfill({ class: 'Warlock', classes: '{"Warlock":5}', level: 5, spell_slots: '{}' });
    assert.equal(warlock.casterLevel, 0, 'pact magic is not part of the multiclass caster level');
    assert.deepEqual(warlock.state, { 3: { max: 2, current: 2 } });
  });

  test('NEVER overwrites a table that already has entries', () => {
    for (const stored of [
      '{"1":{"max":4,"current":1}}',
      '{"1":{"max":0,"current":0}}',
      { 2: { max: 3, current: 3 } }
    ]) {
      const plan = planSpellSlotBackfill({ class: 'Sorcerer', classes: '{"Sorcerer":3}', level: 3, spell_slots: stored });
      assert.equal(plan.fill, false);
      assert.equal(plan.reason, 'has-slots');
      assert.equal(plan.json, null);
    }
  });

  test('a second run over a repaired row is a no-op', () => {
    const row = { class: 'Sorcerer', classes: '{"Sorcerer":3}', level: 3, spell_slots: '{}' };
    const first = planSpellSlotBackfill(row);
    assert.equal(first.fill, true);
    const second = planSpellSlotBackfill({ ...row, spell_slots: first.json });
    assert.equal(second.fill, false);
    assert.equal(second.reason, 'has-slots');
  });

  test('treats every silently-degrading stored shape as empty', () => {
    for (const stored of [undefined, null, '', '{}', 'not json', '[]', '[{"max":2}]', '{"1st":{"max":2}}', 7]) {
      const plan = planSpellSlotBackfill({ class: 'Cleric', classes: '{"Cleric":1}', level: 1, spell_slots: stored });
      assert.equal(plan.fill, true, `stored ${JSON.stringify(stored)} should count as an empty table`);
      assert.deepEqual(plan.state, { 1: { max: 2, current: 2 } });
    }
  });

  test('skips non-casters and rows whose class cannot be resolved', () => {
    const fighter = planSpellSlotBackfill({ class: 'Fighter', classes: '{"Fighter":5}', level: 5, spell_slots: '{}' });
    assert.equal(fighter.fill, false);
    assert.equal(fighter.reason, 'non-caster');

    const paladin1 = planSpellSlotBackfill({ class: 'Paladin', classes: '{"Paladin":1}', level: 1, spell_slots: '{}' });
    assert.equal(paladin1.fill, false, 'a half caster has no slots at level 1');
    assert.equal(paladin1.reason, 'non-caster');

    const junk = planSpellSlotBackfill({ class: 'Frost Mage', classes: '{"Frost Mage":3}', level: 3, spell_slots: '{}' });
    assert.equal(junk.fill, false);
    assert.equal(junk.reason, 'unresolved-class');
    assert.deepEqual(junk.unresolved, ['Frost Mage']);

    const nameless = planSpellSlotBackfill({ class: '', classes: '{}', level: 3, spell_slots: '{}' });
    assert.equal(nameless.fill, false);
    assert.equal(nameless.reason, 'no-class');

    assert.equal(planSpellSlotBackfill().fill, false);
  });
});
