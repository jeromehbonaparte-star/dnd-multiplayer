'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  CLASS_RULES,
  STATIC_CLASSES,
  STATIC_SUBCLASSES,
  collectClassDataProblems,
  validateClassData
} = require('../server/services/classProgressionService.js');

const { getAllSubclasses, getSubclass, getSubclasses } = require('../server/services/dndDataService.js');

const EXPECTED_SUBCLASS_COUNTS = {
  barbarian: 2,
  bard: 2,
  cleric: 7,
  druid: 2,
  fighter: 3,
  monk: 3,
  paladin: 3,
  ranger: 2,
  rogue: 3,
  sorcerer: 2,
  warlock: 3,
  wizard: 8
};

describe('subclass data', () => {
  test('real SRD data passes the startup self-check', () => {
    assert.deepEqual(collectClassDataProblems(), []);
    assert.equal(validateClassData(), true);
  });

  test('every class ships its expected subclass count', () => {
    for (const cls of STATIC_CLASSES) {
      assert.equal(getSubclasses(cls.index).length, EXPECTED_SUBCLASS_COUNTS[cls.index], `subclass count for ${cls.name}`);
    }
    const total = Object.values(EXPECTED_SUBCLASS_COUNTS).reduce((sum, count) => sum + count, 0);
    assert.equal(STATIC_SUBCLASSES.length, total);
    assert.equal(getAllSubclasses().length, total);
  });

  test('resolves subclasses by name or index, case-insensitively', () => {
    const byName = getSubclass('sorcerer', 'Wild Magic');
    const byIndex = getSubclass('sorcerer', 'wild-magic');
    assert.equal(byName.index, 'wild-magic');
    assert.equal(byIndex.index, 'wild-magic');
    assert.deepEqual(byName, byIndex);
    assert.equal(getSubclass('Sorcerer', 'WILD MAGIC').index, 'wild-magic');
    assert.deepEqual(Object.keys(byName.features_by_level), ['1', '6', '14', '18']);
  });

  test('subclass feature levels match the parent class subclassLevels', () => {
    assert.deepEqual(
      Object.keys(getSubclass('fighter', 'champion').features_by_level).map(Number),
      CLASS_RULES.Fighter.subclassLevels
    );
    assert.deepEqual(Object.keys(getSubclass('fighter', 'Champion').features_by_level).map(Number), [3, 7, 10, 15, 18]);
    assert.deepEqual(Object.keys(getSubclass('cleric', 'life').features_by_level).map(Number), [1, 2, 6, 8, 17]);
    assert.deepEqual(Object.keys(getSubclass('cleric', 'Life Domain').features_by_level).map(Number), CLASS_RULES.Cleric.subclassLevels);
    assert.deepEqual(getSubclass('cleric', 'life').features_by_level['17'], ['Supreme Healing']);
    assert.deepEqual(getSubclass('paladin', 'devotion').features_by_level['20'], ['Holy Nimbus']);
    assert.equal(getSubclass('paladin', 'devotion').features_by_level['3'][0], 'Oath Spells');
  });

  test('unknown lookups stay empty instead of throwing', () => {
    assert.deepEqual(getSubclasses('artificer'), []);
    assert.deepEqual(getSubclasses(''), []);
    assert.deepEqual(getSubclasses(null), []);
    assert.deepEqual(getSubclasses(undefined), []);
    assert.equal(getSubclass('artificer', 'alchemist'), null);
    assert.equal(getSubclass('sorcerer', 'clockwork-soul'), null);
    assert.equal(getSubclass('sorcerer', ''), null);
  });

  test('every subclass carries an index, name and flavor name', () => {
    const seen = new Set();
    for (const subclass of STATIC_SUBCLASSES) {
      assert.ok(subclass.index, 'index present');
      assert.ok(subclass.name, `name present for ${subclass.index}`);
      assert.ok(subclass.flavor_name, `flavor_name present for ${subclass.index}`);
      assert.equal(seen.has(subclass.index), false, `duplicate subclass index ${subclass.index}`);
      seen.add(subclass.index);
    }
  });
});

describe('class data validation core', () => {
  const goodClasses = [{ index: 'sorcerer', name: 'Sorcerer' }, { index: 'wizard', name: 'Wizard' }];
  const goodRules = {
    Sorcerer: { subclassLevels: [1, 6, 14, 18] },
    Wizard: { subclassLevels: [2, 6, 10, 14] }
  };
  const goodFeatures = { Sorcerer: [], Wizard: [] };
  const goodSubclasses = [
    { index: 'wild-magic', name: 'Wild Magic', class_index: 'sorcerer', features_by_level: { 1: ['Wild Magic Surge'] } },
    { index: 'draconic', name: 'Draconic', class_index: 'sorcerer', features_by_level: { 6: ['Elemental Affinity'] } },
    { index: 'evocation', name: 'Evocation', class_index: 'wizard', features_by_level: { 2: ['Sculpt Spells'] } },
    { index: 'illusion', name: 'Illusion', class_index: 'wizard', features_by_level: { 2: ['Improved Minor Illusion'] } }
  ];

  function fixture(overrides = {}) {
    return {
      classes: goodClasses,
      classRules: goodRules,
      features: goodFeatures,
      subclasses: goodSubclasses,
      ...overrides
    };
  }

  test('accepts a well-formed fixture', () => {
    assert.deepEqual(collectClassDataProblems(fixture()), []);
    assert.equal(validateClassData(fixture()), true);
  });

  test('rejects a subclass whose parent class does not exist', () => {
    const broken = fixture({
      subclasses: [...goodSubclasses, { index: 'alchemist', name: 'Alchemist', class_index: 'artificer', features_by_level: { 3: ['Experimental Elixir'] } }]
    });
    const problems = collectClassDataProblems(broken);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /unknown class_index "artificer"/);
    assert.throws(() => validateClassData(broken), /Class data validation failed with 1 problem/);
  });

  test('rejects subclass features granted on a level the class never grants on', () => {
    const broken = fixture({
      subclasses: goodSubclasses.map(sub => sub.index === 'wild-magic'
        ? { ...sub, features_by_level: { 1: ['Wild Magic Surge'], 5: ['Nope'] } }
        : sub)
    });
    const problems = collectClassDataProblems(broken);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /grants features at level 5/);
    assert.throws(() => validateClassData(broken), /validation failed/);
  });

  test('rejects a class with fewer than two subclasses', () => {
    const broken = fixture({ subclasses: goodSubclasses.filter(sub => sub.index !== 'illusion') });
    const problems = collectClassDataProblems(broken);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /Class "Wizard" has 1 subclass\(es\)/);
    assert.throws(() => validateClassData(broken), /validation failed/);
  });

  test('rejects CLASS_RULES / FEATURES / classes.json disagreement', () => {
    const broken = fixture({ features: { Sorcerer: [] } });
    const problems = collectClassDataProblems(broken);
    assert.ok(problems.some(problem => /"Wizard" which is missing from FEATURES/.test(problem)));
    assert.throws(() => validateClassData(broken), /validation failed/);

    const extraClass = fixture({ classes: [...goodClasses, { index: 'artificer', name: 'Artificer' }] });
    assert.ok(collectClassDataProblems(extraClass).some(problem => /classes.json has "Artificer"/.test(problem)));
  });

  test('rejects malformed or duplicated subclass records', () => {
    const empty = fixture({
      subclasses: goodSubclasses.map(sub => sub.index === 'evocation' ? { ...sub, features_by_level: {} } : sub)
    });
    assert.ok(collectClassDataProblems(empty).some(problem => /no features_by_level entries/.test(problem)));

    const duplicate = fixture({ subclasses: [...goodSubclasses, goodSubclasses[0]] });
    assert.ok(collectClassDataProblems(duplicate).some(problem => /Duplicate subclass index "wild-magic"/.test(problem)));

    const nameless = fixture({ subclasses: [...goodSubclasses, { class_index: 'wizard', features_by_level: { 2: ['Something'] } }] });
    assert.ok(collectClassDataProblems(nameless).some(problem => /missing an index or name/.test(problem)));
  });
});
