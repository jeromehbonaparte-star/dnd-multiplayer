/**
 * D&D 5e Data Service
 * Fetches data from the D&D 5e API and caches in SQLite
 * Uses native fetch (Node 24+)
 */

const logger = require('../lib/logger');

const BASE_URL = 'https://www.dnd5eapi.co/api';

// ============================================
// Cache helpers
// ============================================

function getCached(db, key) {
  const row = db.prepare('SELECT data FROM dnd_data_cache WHERE key = ?').get(key);
  return row ? JSON.parse(row.data) : null;
}

function setCache(db, key, data) {
  db.prepare('INSERT OR REPLACE INTO dnd_data_cache (key, data, fetched_at) VALUES (?, ?, CURRENT_TIMESTAMP)')
    .run(key, JSON.stringify(data));
}

async function apiFetch(urlPath) {
  const url = urlPath.startsWith('http') ? urlPath : `${BASE_URL}${urlPath}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`D&D API error: ${res.status} for ${url}`);
  }
  return res.json();
}

// ============================================
// Races
// ============================================

async function getRaces(db) {
  const cached = getCached(db, 'races:all');
  if (cached) return cached;

  const list = await apiFetch('/races');
  const races = [];

  for (const race of list.results) {
    const detail = await apiFetch(race.url);
    races.push({
      index: detail.index,
      name: detail.name,
      speed: detail.speed,
      size: detail.size,
      ability_bonuses: (detail.ability_bonuses || []).map(b => ({
        ability: b.ability_score.name,
        bonus: b.bonus
      })),
      traits: (detail.traits || []).map(t => t.name),
      languages: (detail.languages || []).map(l => l.name),
      subraces: (detail.subraces || []).map(s => s.name),
    });
  }

  setCache(db, 'races:all', races);
  return races;
}

// ============================================
// Classes
// ============================================

async function getClasses(db) {
  const cached = getCached(db, 'classes:all');
  if (cached) return cached;

  const list = await apiFetch('/classes');
  const classes = [];

  for (const cls of list.results) {
    const detail = await apiFetch(cls.url);
    const isCaster = !!detail.spellcasting;

    classes.push({
      index: detail.index,
      name: detail.name,
      hit_die: detail.hit_die,
      saving_throws: (detail.saving_throws || []).map(s => s.name),
      proficiencies: (detail.proficiencies || []).map(p => p.name),
      proficiency_choices: detail.proficiency_choices || [],
      is_caster: isCaster,
      spellcasting_ability: isCaster ? detail.spellcasting.spellcasting_ability.name : null,
    });
  }

  setCache(db, 'classes:all', classes);
  return classes;
}

// ============================================
// Spells by Class
// ============================================

async function getSpellsByClass(db, classIndex, level) {
  const cacheKey = `spells:${classIndex}:${level}`;
  const cached = getCached(db, cacheKey);
  if (cached) return cached;

  const data = await apiFetch(`/classes/${classIndex}/spells`);
  const filtered = (data.results || []).filter(s => s.level === level);

  // Batch fetch details for each spell
  const spells = [];
  for (const spell of filtered) {
    const detail = await apiFetch(spell.url);
    spells.push({
      index: detail.index,
      name: detail.name,
      level: detail.level,
      school: detail.school ? detail.school.name : null,
      casting_time: detail.casting_time,
      range: detail.range,
      components: detail.components,
      duration: detail.duration,
      desc: detail.desc,
    });
  }

  setCache(db, cacheKey, spells);
  return spells;
}

// ============================================
// Spell Detail
// ============================================

async function getSpellDetail(db, spellIndex) {
  const cacheKey = `spell:${spellIndex}`;
  const cached = getCached(db, cacheKey);
  if (cached) return cached;

  const detail = await apiFetch(`/spells/${spellIndex}`);
  const result = {
    index: detail.index,
    name: detail.name,
    level: detail.level,
    school: detail.school ? detail.school.name : null,
    casting_time: detail.casting_time,
    range: detail.range,
    components: detail.components,
    material: detail.material,
    duration: detail.duration,
    concentration: detail.concentration,
    ritual: detail.ritual,
    desc: detail.desc,
    higher_level: detail.higher_level,
    classes: (detail.classes || []).map(c => c.name),
  };

  setCache(db, cacheKey, result);
  return result;
}

// ============================================
// Equipment by Category
// ============================================

async function getEquipmentByCategory(db, category) {
  const cacheKey = `equipment:${category}`;
  const cached = getCached(db, cacheKey);
  if (cached) return cached;

  const data = await apiFetch(`/equipment-categories/${category}`);
  const equipment = (data.equipment || []).map(e => ({
    index: e.index,
    name: e.name,
    cost: e.cost || null,
    weight: e.weight || null,
  }));

  setCache(db, cacheKey, equipment);
  return equipment;
}

// ============================================
// Skills
// ============================================

async function getSkills(db) {
  const cached = getCached(db, 'skills:all');
  if (cached) return cached;

  const data = await apiFetch('/skills');
  const skills = (data.results || []).map(s => ({
    index: s.index,
    name: s.name,
    ability_score: s.ability_score ? s.ability_score.name : null,
  }));

  setCache(db, 'skills:all', skills);
  return skills;
}

// ============================================
// Backgrounds
// ============================================

async function getBackgrounds(db) {
  const cached = getCached(db, 'backgrounds:all');
  if (cached) return cached;

  const data = await apiFetch('/backgrounds');
  const backgrounds = [];

  for (const bg of (data.results || [])) {
    const detail = await apiFetch(bg.url);
    backgrounds.push({
      index: detail.index,
      name: detail.name,
      feature: detail.feature || null,
      starting_proficiencies: (detail.starting_proficiencies || []).map(p => p.name),
      starting_equipment: detail.starting_equipment || [],
    });
  }

  setCache(db, 'backgrounds:all', backgrounds);
  return backgrounds;
}

module.exports = {
  getRaces,
  getClasses,
  getSpellsByClass,
  getSpellDetail,
  getEquipmentByCategory,
  getSkills,
  getBackgrounds,
};
