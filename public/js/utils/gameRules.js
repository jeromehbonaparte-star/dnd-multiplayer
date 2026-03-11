// ============================================
// Game Rules (mirrors server's gameRules)
// ============================================

// XP requirements for each level (index = level, value = XP needed)
export const XP_TABLE = [
  0, 300, 900, 2700, 6500, 14000, 23000, 34000,
  48000, 64000, 85000, 100000, 120000, 140000,
  165000, 195000, 225000, 265000, 305000, 355000
];

export function getRequiredXP(level) {
  return XP_TABLE[level] || 355000;
}

export function canLevelUp(xp, level) {
  return xp >= getRequiredXP(level);
}
