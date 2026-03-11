// ============================================
// Inventory Parse Cache
// Avoids re-parsing the same JSON string on every render
// ============================================

const _inventoryCache = new Map();

/**
 * Parse inventory JSON with caching.
 * Returns cached result if the raw string hasn't changed for this character.
 * @param {string} charId - Character ID
 * @param {string} inventoryJson - Raw inventory JSON string
 * @returns {Array} Parsed inventory array
 */
export function getCachedInventory(charId, inventoryJson) {
  const raw = inventoryJson || '[]';
  const cached = _inventoryCache.get(charId);
  if (cached && cached.raw === raw) {
    return cached.parsed;
  }
  let parsed = [];
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    parsed = [];
  }
  _inventoryCache.set(charId, { raw, parsed });
  return parsed;
}

/**
 * Invalidate the cache for a specific character.
 */
export function invalidateInventoryCache(charId) {
  _inventoryCache.delete(charId);
}
