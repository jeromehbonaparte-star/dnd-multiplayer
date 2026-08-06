/**
 * D&D 5e Data Service
 * Serves static SRD data for races/classes/skills/backgrounds.
 * Fetches spells & equipment from the D&D 5e API and caches in SQLite.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../lib/logger');
const { getStartingEquipment } = require('./startingEquipmentService');

const SRD_DIR = path.join(__dirname, '../data/srd');
const STATIC_RACES = JSON.parse(fs.readFileSync(path.join(SRD_DIR, 'races.json'), 'utf-8'));
const STATIC_CLASSES = JSON.parse(fs.readFileSync(path.join(SRD_DIR, 'classes.json'), 'utf-8'));
const STATIC_SKILLS = JSON.parse(fs.readFileSync(path.join(SRD_DIR, 'skills.json'), 'utf-8'));
const STATIC_BACKGROUNDS = JSON.parse(fs.readFileSync(path.join(SRD_DIR, 'backgrounds.json'), 'utf-8'));
const STATIC_SUBCLASSES = JSON.parse(fs.readFileSync(path.join(SRD_DIR, 'subclasses.json'), 'utf-8'));

// class index -> subclasses, built once at startup
const SUBCLASSES_BY_CLASS = STATIC_SUBCLASSES.reduce((map, subclass) => {
  const key = String(subclass.class_index || '').toLowerCase();
  if (!map[key]) map[key] = [];
  map[key].push(subclass);
  return map;
}, {});

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
  return STATIC_RACES;
}

// ============================================
// Classes
// ============================================

async function getClasses(db) {
  return STATIC_CLASSES.map(cls => ({ ...cls, starting_equipment: getStartingEquipment(cls.name) }));
}

// ============================================
// Subclasses
// ============================================

// Accepts a class index ("sorcerer") or class name ("Sorcerer"), case-insensitive.
function resolveClassIndex(classIndex) {
  const raw = String(classIndex || '').trim().toLowerCase();
  if (!raw) return null;
  const match = STATIC_CLASSES.find(cls => cls.index.toLowerCase() === raw || cls.name.toLowerCase() === raw);
  return match ? match.index : null;
}

// Never throws — an unknown class simply has no subclasses.
function getSubclasses(classIndex) {
  const resolved = resolveClassIndex(classIndex);
  if (!resolved) return [];
  return SUBCLASSES_BY_CLASS[resolved] || [];
}

// Case-insensitive match on subclass index or name; null when nothing matches.
function getSubclass(classIndex, subclassIndexOrName) {
  const needle = String(subclassIndexOrName || '').trim().toLowerCase();
  if (!needle) return null;
  const found = getSubclasses(classIndex).find(sub =>
    String(sub.index || '').toLowerCase() === needle || String(sub.name || '').toLowerCase() === needle);
  return found || null;
}

function getAllSubclasses() {
  return STATIC_SUBCLASSES;
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
  return STATIC_SKILLS;
}

// ============================================
// Backgrounds
// ============================================

async function getBackgrounds(db) {
  return STATIC_BACKGROUNDS;
}

module.exports = {
  getRaces,
  getClasses,
  getAllSubclasses,
  getSubclass,
  getSubclasses,
  getSpellsByClass,
  getSpellDetail,
  getEquipmentByCategory,
  getSkills,
  getBackgrounds,
};
