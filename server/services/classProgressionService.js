const logger = require('../lib/logger');
const STATIC_CLASSES = require('../data/srd/classes.json');
const STATIC_SUBCLASSES = require('../data/srd/subclasses.json');

const FULL_CASTER_SLOTS = [
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [2, 0, 0, 0, 0, 0, 0, 0, 0],
  [3, 0, 0, 0, 0, 0, 0, 0, 0],
  [4, 2, 0, 0, 0, 0, 0, 0, 0],
  [4, 3, 0, 0, 0, 0, 0, 0, 0],
  [4, 3, 2, 0, 0, 0, 0, 0, 0],
  [4, 3, 3, 0, 0, 0, 0, 0, 0],
  [4, 3, 3, 1, 0, 0, 0, 0, 0],
  [4, 3, 3, 2, 0, 0, 0, 0, 0],
  [4, 3, 3, 3, 1, 0, 0, 0, 0],
  [4, 3, 3, 3, 2, 0, 0, 0, 0],
  [4, 3, 3, 3, 2, 1, 0, 0, 0],
  [4, 3, 3, 3, 2, 1, 0, 0, 0],
  [4, 3, 3, 3, 2, 1, 1, 0, 0],
  [4, 3, 3, 3, 2, 1, 1, 0, 0],
  [4, 3, 3, 3, 2, 1, 1, 1, 0],
  [4, 3, 3, 3, 2, 1, 1, 1, 0],
  [4, 3, 3, 3, 2, 1, 1, 1, 1],
  [4, 3, 3, 3, 3, 1, 1, 1, 1],
  [4, 3, 3, 3, 3, 2, 1, 1, 1],
  [4, 3, 3, 3, 3, 2, 2, 1, 1]
];

const HALF_CASTER_SLOTS = {
  1: [0, 0, 0, 0, 0, 0, 0, 0, 0],
  2: FULL_CASTER_SLOTS[1],
  3: FULL_CASTER_SLOTS[2],
  4: FULL_CASTER_SLOTS[2],
  5: FULL_CASTER_SLOTS[3],
  6: FULL_CASTER_SLOTS[3],
  7: FULL_CASTER_SLOTS[4],
  8: FULL_CASTER_SLOTS[4],
  9: FULL_CASTER_SLOTS[5],
  10: FULL_CASTER_SLOTS[5],
  11: FULL_CASTER_SLOTS[6],
  12: FULL_CASTER_SLOTS[6],
  13: FULL_CASTER_SLOTS[7],
  14: FULL_CASTER_SLOTS[7],
  15: FULL_CASTER_SLOTS[8],
  16: FULL_CASTER_SLOTS[8],
  17: FULL_CASTER_SLOTS[9],
  18: FULL_CASTER_SLOTS[9],
  19: FULL_CASTER_SLOTS[10],
  20: FULL_CASTER_SLOTS[10]
};

const FEATURES = {
  Barbarian: [
    ['Rage', 'Unarmored Defense'], ['Reckless Attack', 'Danger Sense'], ['Primal Path'], ['Ability Score Improvement'],
    ['Extra Attack', 'Fast Movement'], ['Path feature'], ['Feral Instinct'], ['Ability Score Improvement'],
    ['Brutal Critical (1 die)'], ['Path feature'], ['Relentless Rage'], ['Ability Score Improvement'],
    ['Brutal Critical (2 dice)'], ['Path feature'], ['Persistent Rage'], ['Ability Score Improvement'],
    ['Brutal Critical (3 dice)'], ['Indomitable Might'], ['Ability Score Improvement'], ['Primal Champion']
  ],
  Bard: [
    ['Spellcasting: Bard', 'Bardic Inspiration (d6)'], ['Jack of All Trades', 'Song of Rest (d6)'], ['Expertise', 'Bard College'],
    ['Ability Score Improvement'], ['Bardic Inspiration (d8)', 'Font of Inspiration'], ['Countercharm', 'Bard College feature'], [],
    ['Ability Score Improvement'], ['Song of Rest (d8)'], ['Expertise', 'Bardic Inspiration (d10)', 'Magical Secrets'], [],
    ['Ability Score Improvement'], ['Song of Rest (d10)'], ['Magical Secrets', 'Bard College feature'], ['Bardic Inspiration (d12)'],
    ['Ability Score Improvement'], ['Song of Rest (d12)'], ['Magical Secrets'], ['Ability Score Improvement'], ['Superior Inspiration']
  ],
  Cleric: [
    ['Spellcasting: Cleric', 'Divine Domain', 'Domain Spells'], ['Channel Divinity (1/rest)', 'Channel Divinity: Turn Undead', 'Divine Domain feature'],
    ['Domain Spells'], ['Ability Score Improvement'], ['Domain Spells', 'Destroy Undead (CR 1/2 or below)'],
    ['Channel Divinity (2/rest)', 'Divine Domain feature'], ['Domain Spells'], ['Ability Score Improvement', 'Destroy Undead (CR 1 or below)', 'Divine Domain feature'],
    ['Domain Spells'], ['Divine Intervention'], ['Destroy Undead (CR 2 or below)'], ['Ability Score Improvement'], [],
    ['Destroy Undead (CR 3 or below)'], [], ['Ability Score Improvement'], ['Destroy Undead (CR 4 or below)', 'Divine Domain feature'],
    ['Channel Divinity (3/rest)'], ['Ability Score Improvement'], ['Divine Intervention Improvement']
  ],
  Druid: [
    ['Spellcasting: Druid', 'Druidic'], ['Wild Shape (CR 1/4 or below, no flying or swim speed)', 'Druid Circle'], [],
    ['Wild Shape (CR 1/2 or below, no flying speed)', 'Ability Score Improvement'], [], ['Druid Circle feature'], [],
    ['Wild Shape (CR 1 or below)', 'Ability Score Improvement'], [], ['Druid Circle feature'], [], ['Ability Score Improvement'], [],
    ['Druid Circle feature'], [], ['Ability Score Improvement'], [], ['Timeless Body', 'Beast Spells'], [], ['Ability Score Improvement'], ['Archdruid']
  ],
  Fighter: [
    ['Fighting Style', 'Second Wind'], ['Action Surge (1 use)'], ['Martial Archetype'], ['Ability Score Improvement'], ['Extra Attack'],
    ['Ability Score Improvement'], ['Martial Archetype feature'], ['Ability Score Improvement'], ['Indomitable (1 use)'], ['Martial Archetype feature'],
    ['Extra Attack (2)'], ['Ability Score Improvement'], ['Indomitable (2 uses)'], ['Ability Score Improvement'], ['Martial Archetype feature'],
    ['Ability Score Improvement'], ['Action Surge (2 uses)', 'Indomitable (3 uses)'], ['Martial Archetype feature'], ['Ability Score Improvement'], ['Extra Attack (3)']
  ],
  Monk: [
    ['Unarmored Defense', 'Martial Arts'], ['Ki', 'Flurry of Blows', 'Patient Defense', 'Step of the Wind', 'Unarmored Movement'],
    ['Monastic Tradition', 'Deflect Missiles'], ['Ability Score Improvement', 'Slow Fall'], ['Extra Attack', 'Stunning Strike'],
    ['Ki Empowered Strikes', 'Monastic Tradition feature'], ['Evasion', 'Stillness of Mind'], ['Ability Score Improvement'], ['Unarmored Movement'],
    ['Purity of Body'], ['Monastic Tradition feature'], ['Ability Score Improvement'], ['Tongue of the Sun and Moon'], ['Diamond Soul'],
    ['Timeless Body'], ['Ability Score Improvement'], ['Monastic Tradition feature'], ['Empty Body'], ['Ability Score Improvement'], ['Perfect Self']
  ],
  Paladin: [
    ['Divine Sense', 'Lay on Hands'], ['Fighting Style', 'Spellcasting: Paladin', 'Divine Smite'], ['Divine Health', 'Sacred Oath', 'Oath Spells', 'Channel Divinity'],
    ['Ability Score Improvement'], ['Extra Attack'], ['Aura of Protection'], ['Sacred Oath feature'], ['Ability Score Improvement'], [],
    ['Aura of Courage'], ['Improved Divine Smite'], ['Ability Score Improvement'], [], ['Cleansing Touch'], ['Sacred Oath feature'],
    ['Ability Score Improvement'], [], ['Aura improvements'], ['Ability Score Improvement'], ['Sacred Oath feature']
  ],
  Ranger: [
    ['Favored Enemy (1 type)', 'Natural Explorer (1 terrain type)'], ['Fighting Style', 'Spellcasting: Ranger'], ['Ranger Archetype', 'Primeval Awareness'],
    ['Ability Score Improvement'], ['Extra Attack'], ['Favored Enemy (2 types)', 'Natural Explorer (2 terrain types)'], ['Ranger Archetype feature'],
    ['Ability Score Improvement', "Land's Stride"], [], ['Natural Explorer (3 terrain types)', 'Hide in Plain Sight'], ['Ranger Archetype feature'],
    ['Ability Score Improvement'], [], ['Favored Enemy (3 enemies)', 'Vanish'], ['Ranger Archetype feature'], ['Ability Score Improvement'], [],
    ['Feral Senses'], ['Ability Score Improvement'], ['Foe Slayer']
  ],
  Rogue: [
    ['Expertise', 'Sneak Attack', "Thieves' Cant"], ['Cunning Action'], ['Roguish Archetype'], ['Ability Score Improvement'], ['Uncanny Dodge'],
    ['Expertise'], ['Evasion'], ['Ability Score Improvement'], ['Roguish Archetype feature'], ['Ability Score Improvement'], ['Reliable Talent'],
    ['Ability Score Improvement'], ['Roguish Archetype feature'], ['Blindsense'], ['Slippery Mind'], ['Ability Score Improvement'],
    ['Roguish Archetype feature'], ['Elusive'], ['Ability Score Improvement'], ['Stroke of Luck']
  ],
  Sorcerer: [
    ['Spellcasting: Sorcerer', 'Sorcerous Origin'], ['Font of Magic', 'Flexible Casting: Creating Spell Slots', 'Flexible Casting: Converting Spell Slot'], ['Metamagic'],
    ['Ability Score Improvement'], [], ['Sorcerous Origin feature'], [], ['Ability Score Improvement'], [], ['Metamagic'], [], ['Ability Score Improvement'], [],
    ['Sorcerous Origin feature'], [], ['Ability Score Improvement'], ['Metamagic'], ['Sorcerous Origin feature'], ['Ability Score Improvement'], ['Sorcerous Restoration']
  ],
  Warlock: [
    ['Otherworldly Patron', 'Pact Magic'], ['Eldritch Invocations'], ['Pact Boon'], ['Ability Score Improvement'], [], ['Otherworldly Patron feature'], [],
    ['Ability Score Improvement'], [], ['Otherworldly Patron feature'], ['Mystic Arcanum (6th level)'], ['Ability Score Improvement'], ['Mystic Arcanum (7th level)'],
    ['Otherworldly Patron feature'], ['Mystic Arcanum (8th level)'], ['Ability Score Improvement'], ['Mystic Arcanum (9th level)'], [], ['Ability Score Improvement'], ['Eldritch Master']
  ],
  Wizard: [
    ['Spellcasting: Wizard', 'Arcane Recovery'], ['Arcane Tradition'], [], ['Ability Score Improvement'], [], ['Arcane Tradition feature'], [],
    ['Ability Score Improvement'], [], ['Arcane Tradition feature'], [], ['Ability Score Improvement'], [], ['Arcane Tradition feature'], [],
    ['Ability Score Improvement'], [], ['Spell Mastery'], [], ['Ability Score Improvement'], ['Signature Spell']
  ]
};

const CLASS_RULES = {
  Barbarian: { hitDie: 12, caster: 'none', asiLevels: [4, 8, 12, 16, 19], subclassLevels: [3, 6, 10, 14] },
  Bard: { hitDie: 8, caster: 'full', asiLevels: [4, 8, 12, 16, 19], subclassLevels: [3, 6, 14] },
  Cleric: { hitDie: 8, caster: 'full', asiLevels: [4, 8, 12, 16, 19], subclassLevels: [1, 2, 6, 8, 17] },
  Druid: { hitDie: 8, caster: 'full', asiLevels: [4, 8, 12, 16, 19], subclassLevels: [2, 6, 10, 14] },
  Fighter: { hitDie: 10, caster: 'none', asiLevels: [4, 6, 8, 12, 14, 16, 19], subclassLevels: [3, 7, 10, 15, 18] },
  Monk: { hitDie: 8, caster: 'none', asiLevels: [4, 8, 12, 16, 19], subclassLevels: [3, 6, 11, 17] },
  Paladin: { hitDie: 10, caster: 'half', asiLevels: [4, 8, 12, 16, 19], subclassLevels: [3, 7, 15, 20] },
  Ranger: { hitDie: 10, caster: 'half', asiLevels: [4, 8, 12, 16, 19], subclassLevels: [3, 7, 11, 15] },
  Rogue: { hitDie: 8, caster: 'none', asiLevels: [4, 8, 10, 12, 16, 19], subclassLevels: [3, 9, 13, 17] },
  Sorcerer: { hitDie: 6, caster: 'full', asiLevels: [4, 8, 12, 16, 19], subclassLevels: [1, 6, 14, 18] },
  Warlock: { hitDie: 8, caster: 'warlock', asiLevels: [4, 8, 12, 16, 19], subclassLevels: [1, 6, 10, 14] },
  Wizard: { hitDie: 6, caster: 'full', asiLevels: [4, 8, 12, 16, 19], subclassLevels: [2, 6, 10, 14] }
};

const ABILITY_NAMES = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'];
const MULTICLASS_REQUIREMENTS = {
  Barbarian: { strength: 13 }, Bard: { charisma: 13 }, Cleric: { wisdom: 13 }, Druid: { wisdom: 13 },
  Fighter: { any: [{ strength: 13 }, { dexterity: 13 }] }, Monk: { dexterity: 13, wisdom: 13 }, Paladin: { strength: 13, charisma: 13 },
  Ranger: { dexterity: 13, wisdom: 13 }, Rogue: { dexterity: 13 }, Sorcerer: { charisma: 13 }, Warlock: { charisma: 13 }, Wizard: { intelligence: 13 }
};

function getClassName(name) {
  const match = STATIC_CLASSES.find(c => c.name.toLowerCase() === String(name || '').toLowerCase() || c.index === String(name || '').toLowerCase());
  return match ? match.name : null;
}

function getProgression(className, level) {
  const name = getClassName(className);
  if (!name || level < 1 || level > 20) return null;
  const rules = CLASS_RULES[name];
  const spellSlots = getSpellSlots(name, level);
  return {
    className: name,
    level,
    features: FEATURES[name][level - 1] || [],
    asi: rules.asiLevels.includes(level),
    subclass: rules.subclassLevels.includes(level),
    spellSlots,
    resources: getClassResourceState(name, level),
    hitDie: rules.hitDie,
    proficiencyBonus: 2 + Math.floor((level - 1) / 4)
  };
}

function getClassResourceState(className, level) {
  const inspirationDie = level >= 15 ? 12 : level >= 10 ? 10 : level >= 5 ? 8 : 6;
  const spellSlots = getSpellSlots(className, level);
  switch (className) {
    case 'Barbarian':
      return {
        rage_uses: level >= 20 ? 'unlimited' : [2, 2, 3, 3, 3, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 6, 6, 6][level - 1],
        rage_damage_bonus: level >= 16 ? 4 : level >= 9 ? 3 : 2,
        brutal_critical_dice: level >= 17 ? 3 : level >= 13 ? 2 : level >= 9 ? 1 : 0
      };
    case 'Bard':
      return { bardic_inspiration_die: inspirationDie, inspiration_uses: 'charisma modifier', song_of_rest_die: level >= 17 ? 12 : level >= 9 ? 8 : 6 };
    case 'Cleric':
      return { channel_divinity_uses: level >= 18 ? 3 : level >= 6 ? 2 : level >= 2 ? 1 : 0, destroy_undead_cr: level >= 17 ? 4 : level >= 14 ? 3 : level >= 11 ? 2 : level >= 8 ? 1 : level >= 5 ? 0.5 : 0 };
    case 'Druid':
      return { wild_shape_max_cr: level >= 8 ? 1 : level >= 4 ? 0.5 : level >= 2 ? 0.25 : 0, wild_shape_uses: 2, wild_shape_swim: level >= 4, wild_shape_fly: level >= 8 };
    case 'Fighter':
      return { action_surge_uses: level >= 17 ? 2 : level >= 2 ? 1 : 0, indomitable_uses: level >= 17 ? 3 : level >= 13 ? 2 : level >= 9 ? 1 : 0, extra_attacks: level >= 20 ? 3 : level >= 11 ? 2 : level >= 5 ? 1 : 0 };
    case 'Monk':
      return { ki_points: level, martial_arts_die: level >= 17 ? 10 : level >= 11 ? 8 : level >= 5 ? 6 : 4 };
    case 'Paladin':
      return { lay_on_hands_pool: level * 5, aura_range: level >= 18 ? 30 : 10 };
    case 'Ranger':
      return { favored_enemies: level >= 14 ? 3 : level >= 6 ? 2 : 1, favored_terrain: level >= 10 ? 3 : level >= 6 ? 2 : 1 };
    case 'Rogue':
      return { sneak_attack_dice: Math.ceil(level / 2), expertise_count: level >= 6 ? 4 : level >= 1 ? 2 : 0 };
    case 'Sorcerer':
      return { sorcery_points: level >= 2 ? level : 0, metamagic_known: level >= 17 ? 4 : level >= 10 ? 3 : level >= 3 ? 2 : 0 };
    case 'Warlock':
      return { pact_magic: { slot_level: Math.min(5, Math.ceil(level / 2)), slot_count: level >= 11 ? (level >= 17 ? 4 : 3) : level >= 2 ? 2 : 1 }, eldritch_invocations: [0, 2, 2, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 7, 7, 8, 8, 8, 8, 8][level - 1], mystic_arcanum: level >= 17 ? [6, 7, 8, 9] : level >= 15 ? [6, 7, 8] : level >= 13 ? [6, 7] : level >= 11 ? [6] : [] };
    case 'Wizard':
      return { arcane_recovery_max_spell_level: Math.ceil(level / 2), spell_mastery: level >= 18, signature_spell: level >= 20 };
    default:
      return { spell_slots: spellSlots };
  }
}

function getSpellSlots(className, level) {
  const rules = CLASS_RULES[getClassName(className)];
  if (!rules || rules.caster === 'none') return [];
  if (rules.caster === 'warlock') {
    const slotLevel = Math.min(5, Math.ceil(level / 2));
    const count = level >= 11 ? (level >= 17 ? 4 : 3) : level >= 2 ? 2 : 1;
    return Array.from({ length: 9 }, (_, index) => index + 1 === slotLevel ? count : 0);
  }
  if (rules.caster === 'full') return FULL_CASTER_SLOTS[level] || FULL_CASTER_SLOTS[20];
  return HALF_CASTER_SLOTS[level] || HALF_CASTER_SLOTS[20];
}

function calculateMulticlassSpellcasterLevel(classLevels) {
  return Object.entries(classLevels).reduce((total, [name, level]) => {
    const rules = CLASS_RULES[getClassName(name)];
    if (!rules) return total;
    if (rules.caster === 'full') return total + level;
    if (rules.caster === 'half') return total + Math.floor(level / 2);
    return total;
  }, 0);
}

function slotsToState(slots, existing = {}) {
  const current = existing && typeof existing === 'object' ? existing : {};
  return Object.fromEntries(slots.map((max, index) => {
    const level = String(index + 1);
    const old = current[level] || {};
    return [level, { max, current: max === 0 ? 0 : Math.min(max, Number.isFinite(old.current) ? old.current : max) }];
  }).filter(([, value]) => value.max > 0));
}

function getClassOptions(character) {
  const levels = parseClasses(character.classes, character.class, character.level);
  return STATIC_CLASSES.map(cls => {
    const requirement = MULTICLASS_REQUIREMENTS[cls.name] || {};
    const meetsRequirement = requirement.any
      ? requirement.any.some(option => Object.entries(option).every(([ability, score]) => Number(character[ability] || 0) >= score))
      : Object.entries(requirement).every(([ability, score]) => Number(character[ability] || 0) >= score);
    const alreadyTrained = Object.prototype.hasOwnProperty.call(levels, cls.name);
    return { name: cls.name, level: levels[cls.name] || 0, available: alreadyTrained || meetsRequirement, requirement: requirement.any ? requirement.any : requirement };
  });
}

function parseClasses(raw, primaryClass, totalLevel) {
  let parsed = {};
  try { parsed = JSON.parse(raw || '{}'); } catch (e) { parsed = {}; }
  const classes = {};
  for (const [name, level] of Object.entries(parsed || {})) {
    const canonical = getClassName(name) || name;
    classes[canonical] = Math.max(classes[canonical] || 0, Number(level) || 0);
  }
  if (!Object.keys(classes).length && primaryClass) {
    classes[getClassName(primaryClass) || primaryClass] = totalLevel || 1;
  }
  return classes;
}

// ============================================
// Startup self-check
// ============================================
// Verifies that CLASS_RULES, FEATURES, classes.json and subclasses.json agree.
// `collectClassDataProblems` is pure and takes injectable data so tests can feed
// deliberately broken fixtures; `validateClassData` logs and throws on failure.

function collectClassDataProblems(data = {}) {
  const classes = data.classes || STATIC_CLASSES;
  const subclasses = data.subclasses || STATIC_SUBCLASSES;
  const classRules = data.classRules || CLASS_RULES;
  const features = data.features || FEATURES;
  const problems = [];

  const classNames = (classes || []).map(cls => cls.name);
  const classIndexes = new Set((classes || []).map(cls => cls.index));
  const ruleNames = Object.keys(classRules || {});
  const featureNames = Object.keys(features || {});

  // (a) CLASS_RULES keys == FEATURES keys == classes.json names
  for (const name of ruleNames) {
    if (!classNames.includes(name)) problems.push(`CLASS_RULES has "${name}" which is missing from classes.json`);
    if (!featureNames.includes(name)) problems.push(`CLASS_RULES has "${name}" which is missing from FEATURES`);
  }
  for (const name of featureNames) {
    if (!ruleNames.includes(name)) problems.push(`FEATURES has "${name}" which is missing from CLASS_RULES`);
  }
  for (const name of classNames) {
    if (!ruleNames.includes(name)) problems.push(`classes.json has "${name}" which is missing from CLASS_RULES`);
  }

  const subclassCounts = new Map(classNames.map(name => [name, 0]));
  const seenIndexes = new Set();

  for (const subclass of subclasses || []) {
    const label = subclass && (subclass.index || subclass.name) || '(unnamed)';
    if (!subclass || !subclass.index || !subclass.name) {
      problems.push(`Subclass "${label}" is missing an index or name`);
      continue;
    }
    const key = `${subclass.class_index}:${subclass.index}`;
    if (seenIndexes.has(key)) problems.push(`Duplicate subclass index "${subclass.index}" for class "${subclass.class_index}"`);
    seenIndexes.add(key);

    // (b) parent class must exist
    if (!classIndexes.has(subclass.class_index)) {
      problems.push(`Subclass "${subclass.index}" references unknown class_index "${subclass.class_index}"`);
      continue;
    }
    const parent = (classes || []).find(cls => cls.index === subclass.class_index);
    const rules = (classRules || {})[parent.name];
    if (!rules) {
      problems.push(`Subclass "${subclass.index}" parent class "${parent.name}" has no CLASS_RULES entry`);
      continue;
    }
    subclassCounts.set(parent.name, (subclassCounts.get(parent.name) || 0) + 1);

    // (c) feature levels must be a subset of the parent's subclassLevels
    const allowed = rules.subclassLevels || [];
    const levels = Object.keys(subclass.features_by_level || {});
    if (!levels.length) {
      problems.push(`Subclass "${subclass.index}" has no features_by_level entries`);
      continue;
    }
    for (const level of levels) {
      if (!allowed.includes(Number(level))) {
        problems.push(`Subclass "${subclass.index}" grants features at level ${level}, which is not in ${parent.name} subclassLevels [${allowed.join(', ')}]`);
      }
      const list = subclass.features_by_level[level];
      if (!Array.isArray(list) || !list.length) {
        problems.push(`Subclass "${subclass.index}" has an empty feature list at level ${level}`);
      }
    }
  }

  // (d) every class needs at least two subclasses
  for (const [name, count] of subclassCounts) {
    if (count < 2) problems.push(`Class "${name}" has ${count} subclass(es); at least 2 are required`);
  }

  return problems;
}

function validateClassData(data) {
  const problems = collectClassDataProblems(data);
  if (problems.length) {
    for (const problem of problems) logger.error('Class data validation failure', { problem });
    throw new Error(`Class data validation failed with ${problems.length} problem(s); see logs above`);
  }
  return true;
}

module.exports = {
  ABILITY_NAMES,
  CLASS_RULES,
  FEATURES,
  FULL_CASTER_SLOTS,
  MULTICLASS_REQUIREMENTS,
  STATIC_CLASSES,
  STATIC_SUBCLASSES,
  calculateMulticlassSpellcasterLevel,
  collectClassDataProblems,
  getClassName,
  getClassOptions,
  getClassResourceState,
  getProgression,
  getSpellSlots,
  parseClasses,
  slotsToState,
  validateClassData
};
