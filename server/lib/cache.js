/**
 * Simple Response Cache
 * In-memory cache with TTL for API responses
 */

const responseCache = new Map();
const CACHE_TTL = 5000; // 5 seconds cache TTL

/**
 * Get cached value if not expired
 * @param {string} key - Cache key
 * @returns {*} Cached data or null
 */
function getCached(key) {
  const cached = responseCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }
  responseCache.delete(key);
  return null;
}

/**
 * Set cache value
 * @param {string} key - Cache key
 * @param {*} data - Data to cache
 */
function setCache(key, data) {
  responseCache.set(key, { data, timestamp: Date.now() });
  // Cleanup old entries periodically
  if (responseCache.size > 100) {
    const now = Date.now();
    for (const [k, v] of responseCache) {
      if (now - v.timestamp > CACHE_TTL) {
        responseCache.delete(k);
      }
    }
  }
}

/**
 * Invalidate cache entries by prefix
 * @param {string} prefix - Key prefix to invalidate
 */
function invalidateCache(prefix) {
  for (const key of responseCache.keys()) {
    if (key.startsWith(prefix)) {
      responseCache.delete(key);
    }
  }
}

/**
 * Clear entire cache
 */
function clearCache() {
  responseCache.clear();
}

module.exports = {
  getCached,
  setCache,
  invalidateCache,
  clearCache
};
