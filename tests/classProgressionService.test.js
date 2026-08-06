'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  CLASS_RULES,
  STATIC_CLASSES,
  getClassOptions,
  getProgression,
  getSpellSlots,
  parseClasses,
  slotsToState
} = require('../server/services/classProgressionService.js');

describe('class progression data', () => {
  test('contains all supported SRD classes through level 20', () => {
    assert.equal(STATIC_CLASSES.length, 12);
    for (const className of Object.keys(CLASS_RULES)) {
      for (let level = 1; level <= 20; level += 1) {
        const progression = getProgression(className, level);
        assert.equal(progression.className, className);
        assert.equal(progression.level, level);
      }
    }
  });

  test('tracks fighter extra ASIs and full caster slots', () => {
    assert.equal(getProgression('Fighter', 6).asi, true);
    assert.deepEqual(getSpellSlots('Wizard', 5).slice(0, 3), [4, 3, 2]);
  });

  test('normalizes legacy class indexes without duplicating classes', () => {
    assert.deepEqual(parseClasses('{"fighter":2}', 'Fighter', 2), { Fighter: 2 });
  });

  test('preserves used slots while adding new slot capacity', () => {
    assert.deepEqual(slotsToState([4, 3], { '1': { max: 2, current: 1 } }), {
      '1': { max: 4, current: 1 },
      '2': { max: 3, current: 3 }
    });
  });

  test('drives progression from a subclass-flavored class string', () => {
    const original = console.warn;
    console.warn = () => {};
    try {
      const progression = getProgression('Wild Magic Sorcerer', 5);
      assert.equal(progression.className, 'Sorcerer');
      assert.deepEqual(getSpellSlots('Wild Magic Sorcerer', 5).slice(0, 3), [4, 3, 2]);
      assert.deepEqual(getClassOptions({ charisma: 13, classes: '{"Wild Magic Sorcerer":5}', class: 'Wild Magic Sorcerer', level: 5 })
        .find(option => option.name === 'Sorcerer'), { name: 'Sorcerer', level: 5, available: true, requirement: { charisma: 13 } });
    } finally {
      console.warn = original;
    }
  });

  test('uses either strength or dexterity for fighter multiclassing', () => {
    const options = getClassOptions({ strength: 13, dexterity: 10, classes: '{}', class: 'Wizard', level: 1 });
    assert.equal(options.find(option => option.name === 'Fighter').available, true);
  });
});
