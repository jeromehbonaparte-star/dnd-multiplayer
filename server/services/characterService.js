/**
 * Character Service
 * AC calculations, character queries, and character-related utilities
 */

const logger = require('../lib/logger');

/**
 * Parse AC effects from JSON string
 * @param {string} acEffectsJson - JSON string of AC effects
 * @returns {Object} Parsed AC effects {base_source, base_value, effects[]}
 */
function parseAcEffects(acEffectsJson) {
  try {
    const parsed = JSON.parse(acEffectsJson || '{}');
    return {
      base_source: parsed.base_source || 'Unarmored',
      base_value: parsed.base_value || 10,
      effects: parsed.effects || []
    };
  } catch (e) {
    return { base_source: 'Unarmored', base_value: 10, effects: [] };
  }
}

/**
 * Calculate total AC from effects object
 * @param {Object|string} acEffects - AC effects object or JSON string
 * @returns {number} Total AC value
 */
function calculateTotalAC(acEffects) {
  const data = typeof acEffects === 'string' ? parseAcEffects(acEffects) : acEffects;
  const effectsBonus = data.effects.reduce((sum, e) => sum + (e.value || 0), 0);
  return data.base_value + effectsBonus;
}

/**
 * Update a character's AC in the database
 * @param {Object} db - Database instance
 * @param {string} charId - Character ID
 * @param {Object} acEffects - AC effects object
 * @returns {Object} Updated AC data {ac, ac_effects}
 */
function updateCharacterAC(db, charId, acEffects) {
  const totalAC = calculateTotalAC(acEffects);
  const acEffectsJson = JSON.stringify(acEffects);
  db.prepare('UPDATE characters SET ac = ?, ac_effects = ? WHERE id = ?').run(totalAC, acEffectsJson, charId);
  return { ac: totalAC, ac_effects: acEffects };
}

/**
 * Get all characters for a specific session
 * @param {Object} db - Database instance
 * @param {string} sessionId - Session ID
 * @returns {Array} Array of character objects
 */
function getSessionCharacters(db, sessionId) {
  return db.prepare(`
    SELECT c.* FROM characters c
    INNER JOIN session_characters sc ON c.id = sc.character_id
    WHERE sc.session_id = ?
    ORDER BY c.created_at DESC
  `).all(sessionId);
}

module.exports = {
  parseAcEffects,
  calculateTotalAC,
  updateCharacterAC,
  getSessionCharacters
};
