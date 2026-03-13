// ============================================
// D&D Data Utility — Client-side API + Cache
// ============================================

import { api } from '../api.js';

const cache = new Map();

async function fetchCached(key, endpoint) {
  if (cache.has(key)) return cache.get(key);
  const data = await api(endpoint);
  cache.set(key, data);
  return data;
}

export async function getRaces() {
  return fetchCached('races', '/api/dnd/races');
}

export async function getClasses() {
  return fetchCached('classes', '/api/dnd/classes');
}

export async function getSpellsByClass(classIndex, level) {
  return fetchCached(`spells:${classIndex}:${level}`, `/api/dnd/classes/${classIndex}/spells?level=${level}`);
}

export async function getSpellDetail(spellIndex) {
  return fetchCached(`spell:${spellIndex}`, `/api/dnd/spells/${spellIndex}`);
}

export async function getEquipment(category) {
  return fetchCached(`equipment:${category}`, `/api/dnd/equipment/${category}`);
}

export async function getSkills() {
  return fetchCached('skills', '/api/dnd/skills');
}

export async function getBackgrounds() {
  return fetchCached('backgrounds', '/api/dnd/backgrounds');
}

// ============================================
// D&D 5e Constants
// ============================================

export const STANDARD_ARRAY = [15, 14, 13, 12, 10, 8];
export const POINT_BUY_COSTS = { 8:0, 9:1, 10:2, 11:3, 12:4, 13:5, 14:7, 15:9 };
export const POINT_BUY_TOTAL = 27;
export const ABILITY_NAMES = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'];
export const ABILITY_SHORT = { strength:'STR', dexterity:'DEX', constitution:'CON', intelligence:'INT', wisdom:'WIS', charisma:'CHA' };

export function calcModifier(score) {
  return Math.floor((score - 10) / 2);
}

export function modString(mod) {
  return mod >= 0 ? `+${mod}` : `${mod}`;
}

// ============================================
// Caster Data (5e API doesn't provide directly)
// ============================================

export const CASTER_DATA = {
  bard:     { cantrips: 2, spells_known: 4, slots: { '1': 2 } },
  cleric:   { cantrips: 3, spells_known: 'wis+1', slots: { '1': 2 } },
  druid:    { cantrips: 2, spells_known: 'wis+1', slots: { '1': 2 } },
  sorcerer: { cantrips: 4, spells_known: 2, slots: { '1': 2 } },
  warlock:  { cantrips: 2, spells_known: 2, slots: { '1': 1 } },
  wizard:   { cantrips: 3, spells_known: 'int+1', slots: { '1': 2 } },
  ranger:   { cantrips: 0, spells_known: 0, slots: {} },
  paladin:  { cantrips: 0, spells_known: 0, slots: {} },
};
