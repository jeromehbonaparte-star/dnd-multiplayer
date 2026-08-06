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

// ============================================
// Class resolution ladder
// ============================================
// Free-text class strings ("Wild Magic Sorcerer", "Sorcerer (Wild Magic)",
// "sorceror") used to resolve to null, which made /levelinfo dead-end and let
// level-up treat the character as a fresh multiclass. `resolveClassAndSubclass`
// walks a fixed ladder and reports which rung matched so callers can log/repair:
//   exact  -> case-insensitive class name
//   index  -> class index ("fighter")
//   subclass-split -> class token + subclass tokens, or a bare subclass name
//   suffix -> string starts/ends with a class token; leftover text is kept as a
//             (possibly homebrew) subclass
//   alias  -> tiny typo/shorthand map, re-run through the ladder
// A miss returns { className: null, subclass: null, matched: null }.

const CLASS_ALIASES = {
  sorceror: 'Sorcerer',
  sorcerer: 'Sorcerer',
  wiz: 'Wizard',
  barb: 'Barbarian',
  rouge: 'Rogue',
  pally: 'Paladin'
};

const SUBCLASS_PREFIX_RE = /^(?:path|college|circle|way|oath|school) of (?:the )?/;

function tokenizeClassText(value) {
  return String(value == null ? '' : value).split(/[^A-Za-z0-9]+/).filter(Boolean);
}

function normalizeClassText(value) {
  return tokenizeClassText(value).join(' ').toLowerCase();
}

function shortSubclassForm(normalized) {
  return normalized
    .replace(SUBCLASS_PREFIX_RE, '')
    .replace(/^the /, '')
    .replace(/ domain$/, '')
    .trim();
}

const CLASS_BY_NAME = new Map(STATIC_CLASSES.map(cls => [normalizeClassText(cls.name), cls.name]));
const CLASS_BY_INDEX = new Map(STATIC_CLASSES.map(cls => [normalizeClassText(cls.index), cls.name]));
const CLASS_NAME_BY_INDEX = new Map(STATIC_CLASSES.map(cls => [cls.index, cls.name]));

const SUBCLASS_ENTRIES = STATIC_SUBCLASSES
  .filter(sub => sub && sub.name && CLASS_NAME_BY_INDEX.has(sub.class_index))
  .map(sub => ({
    name: sub.name,
    className: CLASS_NAME_BY_INDEX.get(sub.class_index),
    normalized: normalizeClassText(sub.name),
    short: shortSubclassForm(normalizeClassText(sub.name))
  }));

const SUBCLASSES_BY_CLASS = new Map();
for (const entry of SUBCLASS_ENTRIES) {
  if (!SUBCLASSES_BY_CLASS.has(entry.className)) SUBCLASSES_BY_CLASS.set(entry.className, []);
  SUBCLASSES_BY_CLASS.get(entry.className).push(entry);
}

const CONNECTOR_TOKENS = new Set(['of', 'the', 'a', 'an', 'and']);

// "Warlock of the Fiend" -> leftover "of the Fiend" -> "Fiend"
function trimConnectorTokens(tokens) {
  let start = 0;
  let end = tokens.length;
  while (start < end && CONNECTOR_TOKENS.has(tokens[start].toLowerCase())) start += 1;
  while (end > start && CONNECTOR_TOKENS.has(tokens[end - 1].toLowerCase())) end -= 1;
  return tokens.slice(start, end);
}

function classForToken(token) {
  return CLASS_BY_NAME.get(token) || CLASS_BY_INDEX.get(token) || null;
}

function findSubclassEntry(normalized, className) {
  if (!normalized) return null;
  const list = className ? (SUBCLASSES_BY_CLASS.get(className) || []) : SUBCLASS_ENTRIES;
  return list.find(entry => entry.normalized === normalized || entry.short === normalized) || null;
}

const NO_CLASS_MATCH = { className: null, subclass: null, matched: null };

function resolveClassAndSubclass(raw, options = {}) {
  const rawTokens = tokenizeClassText(raw);
  if (!rawTokens.length) return { ...NO_CLASS_MATCH };
  const tokens = rawTokens.map(token => token.toLowerCase());
  const normalized = tokens.join(' ');

  // (1) exact class name, case-insensitive
  const byName = CLASS_BY_NAME.get(normalized);
  if (byName) return { className: byName, subclass: null, matched: 'exact' };

  // (2) exact class index
  const byIndex = CLASS_BY_INDEX.get(normalized);
  if (byIndex) return { className: byIndex, subclass: null, matched: 'index' };

  // (3a) a class token plus tokens that name one of that class's subclasses
  for (let i = 0; i < tokens.length; i += 1) {
    const className = classForToken(tokens[i]);
    if (!className) continue;
    const restTokens = tokens.slice(0, i).concat(tokens.slice(i + 1));
    const subclass = findSubclassEntry(restTokens.join(' '), className)
      || findSubclassEntry(trimConnectorTokens(restTokens).join(' '), className);
    if (subclass) return { className, subclass: subclass.name, matched: 'subclass-split' };
  }

  // (3b) a bare subclass name -> its parent class
  const bare = findSubclassEntry(normalized, null);
  if (bare) return { className: bare.className, subclass: bare.name, matched: 'subclass-split' };

  // (4) suffix/prefix: leftover text becomes homebrew subclass wording.
  // Suffix wins over prefix so "Shadow Fighter Monk" resolves to Monk.
  if (tokens.length > 1) {
    const suffixClass = classForToken(tokens[tokens.length - 1]);
    if (suffixClass) {
      return { className: suffixClass, subclass: trimConnectorTokens(rawTokens.slice(0, -1)).join(' ') || null, matched: 'suffix' };
    }
    const prefixClass = classForToken(tokens[0]);
    if (prefixClass) {
      return { className: prefixClass, subclass: trimConnectorTokens(rawTokens.slice(1)).join(' ') || null, matched: 'suffix' };
    }
  }

  // (5) alias map, then one retry through the ladder with aliases substituted
  if (!options.viaAlias) {
    const whole = CLASS_ALIASES[normalized];
    if (whole) return { className: whole, subclass: null, matched: 'alias' };
    let substituted = false;
    const swapped = rawTokens.map((token, index) => {
      const alias = CLASS_ALIASES[tokens[index]];
      if (!alias) return token;
      substituted = true;
      return alias;
    });
    if (substituted) {
      const retry = resolveClassAndSubclass(swapped.join(' '), { viaAlias: true });
      if (retry.className) return { className: retry.className, subclass: retry.subclass, matched: 'alias' };
    }
  }

  return { ...NO_CLASS_MATCH };
}

function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = row;
  }
  return previous[b.length];
}

/**
 * Best-effort "did you mean" list for an unresolvable class string.
 * Falls back to the full class list when nothing is close.
 */
function suggestClassNames(raw, limit = 4) {
  const allNames = STATIC_CLASSES.map(cls => cls.name);
  const normalized = normalizeClassText(raw);
  if (!normalized) return allNames;
  const threshold = Math.max(3, Math.ceil(normalized.length / 3));
  const near = allNames
    .map(name => {
      const candidate = normalizeClassText(name);
      const contained = candidate.includes(normalized) || normalized.includes(candidate);
      return { name, score: contained ? 0 : editDistance(candidate, normalized) };
    })
    .filter(entry => entry.score <= threshold)
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map(entry => entry.name);
  return near.length ? near : allNames;
}

/**
 * Exact-only resolution (name or index). Returns null for anything the ladder
 * would have to guess at — callers that must not silently accept fuzzy input.
 */
function getExactClassName(name) {
  const normalized = normalizeClassText(name);
  return CLASS_BY_NAME.get(normalized) || CLASS_BY_INDEX.get(normalized) || null;
}

/**
 * Canonical class name or null. Exact matches are returned silently; anything
 * resolved further down the ladder is logged at WARN so bad stored strings are
 * visible in production logs.
 */
function getClassName(name) {
  const exact = getExactClassName(name);
  if (exact) return exact;
  const resolved = resolveClassAndSubclass(name);
  if (resolved.className) {
    logger.warn(`Resolved class '${String(name)}' via ${resolved.matched} to ${resolved.className}`, resolved.subclass ? { subclass: resolved.subclass } : undefined);
    return resolved.className;
  }
  return null;
}

function safeParseObject(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { ...raw };
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (e) {
    return {};
  }
}

/**
 * Normalize a `classes` map ({ "Wild Magic Sorcerer": 3 }) for a write.
 * Returns canonical keys, any subclasses the split produced, and the keys that
 * could not be resolved at all (callers decide: reject or drop).
 */
function normalizeClassesMap(raw) {
  const parsed = safeParseObject(raw);
  const classes = {};
  const subclasses = {};
  const unresolved = [];
  for (const [key, value] of Object.entries(parsed)) {
    const level = Math.max(0, Number(value) || 0);
    const resolved = resolveClassAndSubclass(key);
    if (!resolved.className) {
      unresolved.push(key);
      continue;
    }
    classes[resolved.className] = Math.max(classes[resolved.className] || 0, level);
    if (resolved.subclass && !subclasses[resolved.className]) subclasses[resolved.className] = resolved.subclass;
  }
  return { classes, subclasses, unresolved };
}

/**
 * Pure repair plan for a stored character row. Used by both the startup repair
 * migration and the on-the-fly /levelinfo repair so they can never diverge.
 * `row` needs { class, classes, class_choices }; nothing here touches the DB.
 * Returns { changed, updates, unresolved, className, subclass, matched }.
 */
function planClassRepair(row = {}) {
  const result = { changed: false, updates: {}, unresolved: [], className: null, subclass: null, matched: null };
  const classChoices = safeParseObject(row.class_choices);
  let choicesChanged = false;

  const seedSubclass = (className, subclass) => {
    if (!className || !subclass) return;
    const existing = classChoices[className] || {};
    if (existing.subclass) return;
    classChoices[className] = { ...existing, subclass };
    choicesChanged = true;
  };

  const rawClass = typeof row.class === 'string' ? row.class.trim() : '';
  if (rawClass) {
    const resolved = resolveClassAndSubclass(rawClass);
    if (resolved.className) {
      result.className = resolved.className;
      result.subclass = resolved.subclass;
      result.matched = resolved.matched;
      if (resolved.className !== row.class) {
        result.updates.class = resolved.className;
        result.changed = true;
      }
      seedSubclass(resolved.className, resolved.subclass);
    } else {
      result.unresolved.push(rawClass);
    }
  }

  const parsedClasses = safeParseObject(row.classes);
  const classEntries = Object.entries(parsedClasses);
  if (classEntries.length) {
    const rebuilt = {};
    let keysChanged = false;
    for (const [key, value] of classEntries) {
      const level = Math.max(0, Number(value) || 0);
      const resolved = resolveClassAndSubclass(key);
      if (!resolved.className) {
        if (!result.unresolved.includes(key)) result.unresolved.push(key);
        rebuilt[key] = Math.max(rebuilt[key] || 0, level);
        continue;
      }
      if (resolved.className !== key) keysChanged = true;
      rebuilt[resolved.className] = Math.max(rebuilt[resolved.className] || 0, level);
      seedSubclass(resolved.className, resolved.subclass);
    }
    if (keysChanged) {
      result.updates.classes = JSON.stringify(rebuilt);
      result.changed = true;
    }
  }

  if (choicesChanged) {
    result.updates.class_choices = JSON.stringify(classChoices);
    result.changed = true;
  }
  return result;
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

/**
 * Merge a computed slot array with the character's stored slot state.
 *
 * Floor guard: the result may never REDUCE a slot level the character already
 * has. Where the computed array says 0 (or fewer) for a level whose stored max
 * is greater, the stored max is kept and `current` is clamped to it. Levels that
 * exist only in the stored state (e.g. the computed array is empty because the
 * class was misresolved as a non-caster) survive untouched. `flooredLevels`
 * lists every level where the floor kicked in so the CALLER can log a warning
 * and surface it to the player.
 *
 * @returns {{ state: Object, flooredLevels: string[] }}
 */
function computeSlotState(slots, existing = {}) {
  const computed = Array.isArray(slots) ? slots : [];
  const current = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
  const levels = new Set(computed.map((_, index) => index + 1));
  for (const key of Object.keys(current)) {
    if (/^\d+$/.test(key)) levels.add(Number(key));
  }

  const state = {};
  const flooredLevels = [];
  for (const level of [...levels].sort((a, b) => a - b)) {
    const key = String(level);
    const computedMax = Math.max(0, Number(computed[level - 1]) || 0);
    const old = current[key] && typeof current[key] === 'object' ? current[key] : {};
    const storedMax = Math.max(0, Number(old.max) || 0);
    const max = Math.max(computedMax, storedMax);
    if (storedMax > computedMax) flooredLevels.push(key);
    if (max <= 0) continue;
    const storedCurrent = Number.isFinite(old.current) ? Number(old.current) : max;
    state[key] = { max, current: Math.max(0, Math.min(max, storedCurrent)) };
  }
  return { state, flooredLevels };
}

function slotsToState(slots, existing = {}) {
  return computeSlotState(slots, existing).state;
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
    // getClassName runs the full ladder (and logs non-exact hits). Only truly
    // unresolvable keys are kept verbatim, and those are warned about here.
    const canonical = getClassName(name);
    if (!canonical) logger.warn(`parseClasses: unresolvable class key '${String(name)}' kept as-is`);
    const key = canonical || name;
    classes[key] = Math.max(classes[key] || 0, Number(level) || 0);
  }
  if (!Object.keys(classes).length && primaryClass) {
    const canonical = getClassName(primaryClass);
    if (!canonical) logger.warn(`parseClasses: unresolvable primary class '${String(primaryClass)}' kept as-is`);
    classes[canonical || primaryClass] = totalLevel || 1;
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
  computeSlotState,
  getClassName,
  getClassOptions,
  getClassResourceState,
  getExactClassName,
  getProgression,
  getSpellSlots,
  normalizeClassesMap,
  parseClasses,
  planClassRepair,
  resolveClassAndSubclass,
  slotsToState,
  suggestClassNames,
  validateClassData
};
