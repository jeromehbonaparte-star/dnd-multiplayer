/**
 * Game Rules Service
 * XP tables, level-up logic, and other D&D 5e rule helpers
 */

// XP requirements for each level (index = current level, value = XP needed to reach next)
const XP_TABLE = [0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000, 85000, 100000, 120000, 140000, 165000, 195000, 225000, 265000, 305000, 355000];

/**
 * Get the XP required to reach the next level
 * @param {number} level - Current level
 * @returns {number} XP required for next level
 */
function getRequiredXP(level) {
  return XP_TABLE[level] || 355000;
}

/**
 * Check if a character can level up
 * @param {number} xp - Current XP
 * @param {number} level - Current level
 * @returns {boolean} Whether the character can level up
 */
function canLevelUp(xp, level) {
  return xp >= getRequiredXP(level);
}

module.exports = {
  XP_TABLE,
  getRequiredXP,
  canLevelUp
};
