const GRID_WIDTH = 10;
const GRID_HEIGHT = 8;
const MAX_COMBATANTS_PER_SIDE = 12;
const MAX_LOG_ENTRIES = 80;
const MAX_POWERS_PER_UNIT = 20;

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

const TERRAIN = {
  plains: { moveCost: 1, label: 'Plains' },
  forest: { moveCost: 2, label: 'Forest' },
  ruins: { moveCost: 1, label: 'Ruins' },
  water: { moveCost: 99, label: 'Water', impassable: true },
  wall: { moveCost: 99, label: 'Wall', impassable: true }
};

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
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

function lowestAvailableSlot(spellSlots) {
  return Object.keys(spellSlots).map(Number).filter(level => level > 0 && spellSlots[level]?.max > 0).sort((a, b) => a - b)[0] || 1;
}

function classifyPower(name) {
  const normalized = name.toLowerCase();
  if (/heal|cure|restoration|lay on hands|second wind|prayer/.test(normalized)) return 'heal';
  if (/shield|ward|blur|mirror image|sanctuary|rage|wild shape|defen[cs]e|inspiration/.test(normalized)) return 'support';
  return 'attack';
}

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
      range: kind === 'heal' ? 3 : kind === 'support' ? 2 : 4,
      attackBonus: castingBonus,
      damageDie: clamp(6 + slotLevel * 2, 6, 12),
      bonus: Math.max(0, profile.castingStat)
    };
  });

  const className = normalizedClass(character.class);
  const classPower = className.includes('fighter') ? { name: 'Second Wind', kind: 'heal', range: 0, maxUses: 1 }
    : className.includes('barbarian') ? { name: 'Rage', kind: 'support', range: 0, maxUses: 2 }
    : className.includes('rogue') ? { name: 'Sneak Attack', kind: 'attack', range: profile.range, maxUses: null }
    : className.includes('paladin') && Number(character.level) >= 2 ? { name: 'Divine Smite', kind: 'attack', range: 1, maxUses: null, usesSlot: true }
    : className.includes('monk') && Number(character.level) >= 2 ? { name: 'Flurry of Blows', kind: 'attack', range: 1, maxUses: 2 }
    : className.includes('cleric') && Number(character.level) >= 2 ? { name: 'Channel Divinity', kind: 'heal', range: 3, maxUses: 1 }
    : className.includes('druid') && Number(character.level) >= 2 ? { name: 'Wild Shape', kind: 'support', range: 0, maxUses: 2 }
    : className.includes('bard') ? { name: 'Bardic Inspiration', kind: 'support', range: 3, maxUses: proficiencyBonus(character.level) }
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

function normalizeAutoCombatSetup(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const rawEnemies = Array.isArray(value.enemies) ? value.enemies : [];
  const enemies = rawEnemies.slice(0, MAX_COMBATANTS_PER_SIDE).map((enemy, index) => ({
    id: `auto-${index + 1}`,
    name: String(enemy?.name || `Enemy ${index + 1}`).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) || `Enemy ${index + 1}`,
    hp: clamp(Number(enemy?.hp) || 12, 1, 500),
    ac: clamp(Number(enemy?.ac) || 12, 1, 30),
    attackBonus: clamp(Number(enemy?.attackBonus) || 3, -5, 25),
    damageBonus: clamp(Number(enemy?.damageBonus) || 1, -5, 30),
    damageDie: clamp(Number(enemy?.damageDie) || 6, 4, 20),
    initiativeBonus: clamp(Number(enemy?.initiativeBonus) || 0, -10, 20),
    movement: clamp(Number(enemy?.movement) || 6, 2, 9),
    range: clamp(Number(enemy?.range) || 1, 1, 5)
  }));
  if (!enemies.length) return null;
  const requestedEnvironment = String(value.environment || 'plains').toLowerCase().replace(/[^a-z]/g, '').slice(0, 50);
  const environment = ['plains', 'forest', 'dungeon', 'ruins', 'water', 'city'].includes(requestedEnvironment)
    ? requestedEnvironment
    : 'plains';
  const name = String(value.name || 'Tactical Encounter').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120) || 'Tactical Encounter';
  return { name, environment, enemies };
}

function classProfile(character) {
  const className = normalizedClass(character.class);
  const ranged = /artificer|bard|cleric|druid|ranger|sorcerer|warlock|wizard/.test(className);
  const heavy = /barbarian|fighter|paladin/.test(className);
  const agile = /monk|rogue|ranger/.test(className);
  const castingStat = Math.max(abilityModifier(character.intelligence), abilityModifier(character.wisdom), abilityModifier(character.charisma));
  return {
    range: ranged ? 3 : 1,
    movement: agile ? 7 : heavy ? 5 : 6,
    damageDie: heavy ? 10 : agile ? 6 : 8,
    attackStat: ranged ? Math.max(castingStat, abilityModifier(character.dexterity)) : Math.max(abilityModifier(character.strength), abilityModifier(character.dexterity)),
    castingStat
  };
}

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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function tileKey(x, y) {
  return `${x},${y}`;
}

function manhattan(first, second) {
  return Math.abs(first.x - second.x) + Math.abs(first.y - second.y);
}

function inBounds(state, x, y) {
  return x >= 0 && y >= 0 && x < state.grid.width && y < state.grid.height;
}

function terrainAt(state, x, y) {
  return TERRAIN[state.grid.tiles[y]?.[x]] || TERRAIN.plains;
}

function isAlive(unit) {
  return unit && unit.hp > 0;
}

function activeUnit(state) {
  return state.units.find(unit => unit.id === state.turnOrder[state.turnIndex]) || null;
}

function appendEvents(state, events) {
  if (!events.length) return;
  state.log.push(...events);
  if (state.log.length > MAX_LOG_ENTRIES) state.log.splice(0, state.log.length - MAX_LOG_ENTRIES);
}

function createGrid(environment) {
  const tiles = Array.from({ length: GRID_HEIGHT }, () => Array.from({ length: GRID_WIDTH }, () => 'plains'));
  const theme = String(environment || '').toLowerCase();
  const paint = (cells, terrain) => cells.forEach(([x, y]) => { if (x > 1 && x < GRID_WIDTH - 2) tiles[y][x] = terrain; });

  if (/forest|swamp/.test(theme)) {
    paint([[3, 1], [3, 2], [4, 2], [6, 5], [7, 5], [6, 6]], 'forest');
  } else if (/dungeon|cave|ruin|castle/.test(theme)) {
    paint([[3, 1], [4, 1], [6, 6], [7, 6]], 'wall');
    paint([[4, 4], [5, 4], [6, 3]], 'ruins');
  } else if (/water|coast|ship/.test(theme)) {
    paint([[4, 1], [4, 2], [5, 1], [5, 2], [6, 1]], 'water');
    paint([[4, 5], [5, 5], [5, 6]], 'water');
  } else if (/city|street/.test(theme)) {
    paint([[3, 2], [4, 2], [6, 5], [7, 5]], 'ruins');
  } else {
    paint([[4, 2], [5, 2], [4, 5], [5, 5]], 'forest');
  }

  return { width: GRID_WIDTH, height: GRID_HEIGHT, tiles };
}

function partyUnit(character, index) {
  const profile = classProfile(character);
  const dexterity = abilityModifier(character.dexterity);
  const spellSlots = parseSpellSlots(character.spell_slots);
  return {
    id: `pc:${character.id}`,
    sourceCharacterId: character.id,
    name: character.character_name || 'Adventurer',
    side: 'party',
    imageUrl: String(character.image_url || '').slice(0, 500),
    hp: Math.max(0, Number(character.hp) || 0),
    maxHp: Math.max(1, Number(character.max_hp) || Number(character.hp) || 1),
    ac: clamp(Number(character.ac) || 10, 1, 30),
    initiativeBonus: dexterity + (Number(character.initiative_bonus) || 0),
    attackBonus: proficiencyBonus(character.level) + profile.attackStat,
    damageBonus: profile.attackStat,
    damageDie: profile.damageDie,
    range: profile.range,
    movement: profile.movement,
    spellSlots,
    powers: buildPowers(character, profile, spellSlots),
    powerUses: {},
    x: 0,
    y: clamp(Math.round(((index + 1) * GRID_HEIGHT) / 5) - 1, 0, GRID_HEIGHT - 1),
    hasMoved: false,
    hasActed: false,
    defending: false
  };
}

function enemyUnit(enemy, index) {
  const hp = clamp(Number(enemy.hp) || 12, 1, 500);
  return {
    id: `npc:${enemy.id}`,
    name: String(enemy.name || 'Enemy').slice(0, 80),
    side: 'enemy',
    hp,
    maxHp: hp,
    ac: clamp(Number(enemy.ac) || 12, 1, 30),
    initiativeBonus: clamp(Number(enemy.initiativeBonus) || 0, -10, 20),
    attackBonus: clamp(Number(enemy.attackBonus) || 3, -5, 25),
    damageBonus: clamp(Number(enemy.damageBonus) || 1, -5, 30),
    damageDie: clamp(Number(enemy.damageDie) || 6, 4, 20),
    range: clamp(Number(enemy.range) || 1, 1, 5),
    movement: clamp(Number(enemy.movement) || 6, 2, 9),
    x: GRID_WIDTH - 1,
    y: clamp(Math.round(((index + 1) * GRID_HEIGHT) / 5) - 1, 0, GRID_HEIGHT - 1),
    hasMoved: false,
    hasActed: false,
    defending: false
  };
}

function placeUnits(state) {
  const occupied = new Set();
  for (const unit of state.units) {
    const startX = unit.side === 'party' ? 0 : state.grid.width - 1;
    let x = startX;
    let y = unit.y;
    while (occupied.has(tileKey(x, y)) || terrainAt(state, x, y).impassable) {
      y = (y + 1) % state.grid.height;
      if (y === unit.y) x += unit.side === 'party' ? 1 : -1;
    }
    unit.x = x;
    unit.y = y;
    occupied.add(tileKey(x, y));
  }
}

function getReachableTiles(state, unit, movement = unit.movement) {
  const queue = [{ x: unit.x, y: unit.y, cost: 0 }];
  const costs = new Map([[tileKey(unit.x, unit.y), 0]]);
  const occupied = new Set(state.units.filter(other => isAlive(other) && other.id !== unit.id).map(other => tileKey(other.x, other.y)));

  while (queue.length) {
    const current = queue.shift();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = current.x + dx;
      const y = current.y + dy;
      if (!inBounds(state, x, y) || occupied.has(tileKey(x, y))) continue;
      const terrain = terrainAt(state, x, y);
      const cost = current.cost + terrain.moveCost;
      const key = tileKey(x, y);
      if (terrain.impassable || cost > movement || (costs.has(key) && costs.get(key) <= cost)) continue;
      costs.set(key, cost);
      queue.push({ x, y, cost });
    }
  }
  return [...costs.entries()].map(([key, cost]) => {
    const [x, y] = key.split(',').map(Number);
    return { x, y, cost };
  });
}

function attack(state, attacker, target) {
  const events = [];
  const d20 = roll(state, 20);
  const total = d20 + attacker.attackBonus;
  const hit = d20 === 20 || (d20 !== 1 && total >= target.ac);
  if (!hit) {
    events.push({ type: 'miss', text: `${attacker.name} misses ${target.name}.`, attackerId: attacker.id, targetId: target.id, roll: d20 });
    return events;
  }
  let damage = roll(state, attacker.damageDie) + attacker.damageBonus;
  if (d20 === 20) damage += roll(state, attacker.damageDie);
  damage = Math.max(1, damage);
  if (target.defending) damage = Math.max(1, Math.floor(damage / 2));
  target.hp = Math.max(0, target.hp - damage);
  events.push({ type: d20 === 20 ? 'critical' : 'attack', text: `${attacker.name} ${d20 === 20 ? 'critically hits' : 'hits'} ${target.name} for ${damage}.`, attackerId: attacker.id, targetId: target.id, amount: damage, roll: d20 });
  if (!target.hp) events.push({ type: 'defeat', text: `${target.name} is defeated.`, targetId: target.id });
  return events;
}

function availablePower(unit, power) {
  if (!power) return false;
  if (power.slotLevel > 0 && Number(unit.spellSlots?.[power.slotLevel]?.current || 0) <= 0) return false;
  if (power.maxUses != null && Number(unit.powerUses?.[power.id] || 0) >= power.maxUses) return false;
  return true;
}

function usePowerResource(unit, power) {
  if (power.slotLevel > 0) {
    unit.spellSlots[power.slotLevel].current = Math.max(0, unit.spellSlots[power.slotLevel].current - 1);
  }
  if (power.maxUses != null) unit.powerUses[power.id] = Number(unit.powerUses[power.id] || 0) + 1;
}

function resolvePower(state, unit, power, target) {
  const events = [];
  usePowerResource(unit, power);
  if (power.kind === 'heal') {
    const amount = Math.max(1, roll(state, power.damageDie) + power.bonus + Math.max(0, Number(power.slotLevel) - 1) * 2);
    const healed = Math.min(amount, target.maxHp - target.hp);
    target.hp += healed;
    events.push({
      type: power.source,
      effect: 'heal',
      text: `${unit.name} uses ${power.name}, restoring ${healed} HP to ${target.name}.`,
      attackerId: unit.id,
      targetId: target.id,
      amount: healed,
      powerName: power.name
    });
    return events;
  }
  if (power.kind === 'support') {
    target.defending = true;
    events.push({
      type: power.source,
      effect: 'support',
      text: `${unit.name} uses ${power.name} on ${target.name}.`,
      attackerId: unit.id,
      targetId: target.id,
      powerName: power.name
    });
    return events;
  }

  const d20 = roll(state, 20);
  const total = d20 + power.attackBonus;
  const hit = d20 === 20 || (d20 !== 1 && total >= target.ac);
  if (!hit) {
    events.push({ type: power.source, effect: 'miss', text: `${unit.name}'s ${power.name} misses ${target.name}.`, attackerId: unit.id, targetId: target.id, powerName: power.name, roll: d20 });
    return events;
  }
  let damage = roll(state, power.damageDie) + power.bonus + Math.max(0, Number(power.slotLevel) - 1) * 2;
  if (d20 === 20) damage += roll(state, power.damageDie);
  damage = Math.max(1, damage);
  if (target.defending) damage = Math.max(1, Math.floor(damage / 2));
  target.hp = Math.max(0, target.hp - damage);
  events.push({
    type: power.source,
    effect: d20 === 20 ? 'critical' : 'attack',
    text: `${unit.name} uses ${power.name} and ${d20 === 20 ? 'critically hits' : 'hits'} ${target.name} for ${damage}.`,
    attackerId: unit.id,
    targetId: target.id,
    amount: damage,
    powerName: power.name,
    roll: d20
  });
  if (!target.hp) events.push({ type: 'defeat', text: `${target.name} is defeated.`, targetId: target.id });
  return events;
}

function checkOutcome(state, events) {
  const partyAlive = state.units.some(unit => unit.side === 'party' && isAlive(unit));
  const enemiesAlive = state.units.some(unit => unit.side === 'enemy' && isAlive(unit));
  if (partyAlive && enemiesAlive) return false;
  state.outcome = enemiesAlive ? 'defeat' : 'victory';
  events.push({ type: state.outcome, text: state.outcome === 'victory' ? 'Victory. The battlefield falls silent.' : 'Defeat. The party can fight no longer.' });
  return true;
}

function beginTurn(unit) {
  unit.hasMoved = false;
  unit.hasActed = false;
  unit.defending = false;
}

function resolveEnemyTurn(state, unit) {
  const events = [];
  beginTurn(unit);
  const targets = state.units.filter(other => other.side === 'party' && isAlive(other));
  if (!targets.length) return events;
  const target = targets.sort((left, right) => manhattan(unit, left) - manhattan(unit, right))[0];
  let distance = manhattan(unit, target);
  if (distance > unit.range) {
    const choices = getReachableTiles(state, unit).sort((left, right) => {
      const leftDistance = Math.abs(left.x - target.x) + Math.abs(left.y - target.y);
      const rightDistance = Math.abs(right.x - target.x) + Math.abs(right.y - target.y);
      return leftDistance - rightDistance || right.cost - left.cost;
    });
    const destination = choices[0];
    if (destination && (destination.x !== unit.x || destination.y !== unit.y)) {
      const from = { x: unit.x, y: unit.y };
      unit.x = destination.x;
      unit.y = destination.y;
      unit.hasMoved = true;
      events.push({ type: 'move', text: `${unit.name} advances.`, unitId: unit.id, from, to: { x: unit.x, y: unit.y } });
      distance = manhattan(unit, target);
    }
  }
  if (distance <= unit.range && isAlive(target)) events.push(...attack(state, unit, target));
  else events.push({ type: 'wait', text: `${unit.name} holds position.`, unitId: unit.id });
  unit.hasActed = true;
  return events;
}

function advanceToPlayer(state) {
  const events = [];
  const guardLimit = state.units.length * 3;
  for (let guard = 0; guard < guardLimit; guard++) {
    state.turnIndex = (state.turnIndex + 1) % state.turnOrder.length;
    if (state.turnIndex === 0) state.round += 1;
    const unit = activeUnit(state);
    if (!isAlive(unit)) continue;
    if (unit.side === 'party') {
      beginTurn(unit);
      events.push({ type: 'turn', text: `${unit.name}'s turn.`, unitId: unit.id });
      return events;
    }
    events.push(...resolveEnemyTurn(state, unit));
    if (checkOutcome(state, events)) return events;
  }
  return events;
}

function createTacticalCombat(characters, enemies, options = {}) {
  if (!Array.isArray(characters) || !characters.length) throw new Error('Combat needs at least one party member.');
  if (!Array.isArray(enemies) || !enemies.length) throw new Error('Combat needs at least one enemy.');
  if (characters.length > MAX_COMBATANTS_PER_SIDE || enemies.length > MAX_COMBATANTS_PER_SIDE) throw new Error(`Combat supports up to ${MAX_COMBATANTS_PER_SIDE} units per side.`);
  const seed = Number(options.seed) || Math.floor(Math.random() * 0x7fffffff) || 1;
  const state = {
    version: 1,
    seed,
    rngState: seed,
    environment: String(options.environment || 'plains').slice(0, 50),
    grid: createGrid(options.environment),
    units: [...characters.map(partyUnit), ...enemies.map(enemyUnit)],
    turnOrder: [],
    turnIndex: -1,
    round: 1,
    outcome: null,
    log: []
  };
  placeUnits(state);
  state.turnOrder = state.units
    .map(unit => ({ id: unit.id, initiative: roll(state, 20) + unit.initiativeBonus, tie: roll(state, 20) }))
    .sort((left, right) => right.initiative - left.initiative || right.tie - left.tie)
    .map(entry => entry.id);
  const events = advanceToPlayer(state);
  appendEvents(state, [{ type: 'start', text: `Combat begins in the ${state.environment}.` }, ...events]);
  return state;
}

function applyTacticalAction(currentState, action) {
  const state = clone(currentState);
  if (state.outcome) return { ok: false, error: 'This combat has already ended.' };
  const unit = activeUnit(state);
  if (!unit || unit.side !== 'party' || !isAlive(unit)) return { ok: false, error: 'It is not a player character turn.' };
  if (!action || typeof action.type !== 'string') return { ok: false, error: 'A combat action is required.' };
  const events = [];

  if (action.type === 'move') {
    if (unit.hasMoved) return { ok: false, error: 'This character has already moved.' };
    const x = Number(action.x);
    const y = Number(action.y);
    const destination = getReachableTiles(state, unit).find(tile => tile.x === x && tile.y === y);
    if (!destination) return { ok: false, error: 'That tile is out of range or blocked.' };
    if (destination.x !== unit.x || destination.y !== unit.y) {
      const from = { x: unit.x, y: unit.y };
      unit.x = destination.x;
      unit.y = destination.y;
      events.push({ type: 'move', text: `${unit.name} moves.`, unitId: unit.id, from, to: { x, y } });
    }
    unit.hasMoved = true;
  } else if (action.type === 'attack') {
    if (unit.hasActed) return { ok: false, error: 'This character has already acted.' };
    const target = state.units.find(other => other.id === action.targetId && other.side === 'enemy' && isAlive(other));
    if (!target) return { ok: false, error: 'Choose a living enemy.' };
    if (manhattan(unit, target) > unit.range) return { ok: false, error: 'That target is out of range.' };
    events.push(...attack(state, unit, target));
    unit.hasActed = true;
  } else if (action.type === 'defend') {
    if (unit.hasActed) return { ok: false, error: 'This character has already acted.' };
    unit.defending = true;
    unit.hasActed = true;
    events.push({ type: 'defend', text: `${unit.name} takes a defensive stance.`, unitId: unit.id });
  } else if (action.type === 'power') {
    if (unit.hasActed) return { ok: false, error: 'This character has already acted.' };
    const power = unit.powers?.find(candidate => candidate.id === action.powerId);
    if (!power) return { ok: false, error: 'That spell or ability is not available.' };
    if (!availablePower(unit, power)) return { ok: false, error: `${power.name} has no uses remaining.` };
    const desiredSide = power.kind === 'attack' ? 'enemy' : 'party';
    const target = state.units.find(other => other.id === action.targetId && other.side === desiredSide && isAlive(other));
    if (!target) return { ok: false, error: `Choose a living ${desiredSide === 'enemy' ? 'enemy' : 'ally'}.` };
    if (manhattan(unit, target) > power.range) return { ok: false, error: 'That target is out of range.' };
    events.push(...resolvePower(state, unit, power, target));
    unit.hasActed = true;
  } else if (action.type === 'endTurn') {
    unit.hasActed = true;
    events.push({ type: 'wait', text: `${unit.name} ends their turn.`, unitId: unit.id });
  } else {
    return { ok: false, error: 'Unsupported combat action.' };
  }

  if (checkOutcome(state, events)) {
    state.version += 1;
    appendEvents(state, events);
    return { ok: true, state, events };
  }
  if (unit.hasActed) events.push(...advanceToPlayer(state));
  state.version += 1;
  appendEvents(state, events);
  return { ok: true, state, events };
}

function getCombatSummary(state, events = []) {
  const lines = events.map(event => event.text).filter(Boolean);
  const party = state.units.filter(unit => unit.side === 'party').map(unit => `${unit.name} ${unit.hp}/${unit.maxHp} HP`).join(', ');
  return `${state.outcome ? `Combat ${state.outcome}.` : `Combat round ${state.round}.`} ${lines.join(' ')} Party status: ${party}.`.trim();
}

module.exports = {
  MAX_COMBATANTS_PER_SIDE,
  TERRAIN,
  activeUnit,
  applyTacticalAction,
  createTacticalCombat,
  getCombatSummary,
  getReachableTiles,
  normalizeAutoCombatSetup
};
