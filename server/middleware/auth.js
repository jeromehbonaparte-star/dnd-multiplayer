/**
 * Authentication Middleware
 * Handles game password and admin password verification
 */

const bcrypt = require('bcryptjs');

/**
 * Create authentication middleware with database dependency
 * @param {Object} db - Database instance
 * @returns {Object} Middleware functions
 */
function createAuthMiddleware(db) {
  /**
   * Check game password
   */
  const checkPassword = (req, res, next) => {
    const password = req.headers['x-game-password'];
    const storedHash = db.prepare('SELECT value FROM settings WHERE key = ?').get('game_password');

    if (!storedHash || !bcrypt.compareSync(password || '', storedHash.value)) {
      return res.status(401).json({ error: 'Invalid password' });
    }
    next();
  };

  /**
   * Check admin password (requires game password first)
   */
  const checkAdminPassword = (req, res, next) => {
    const adminPwd = req.headers['x-admin-password'];
    const storedHash = db.prepare('SELECT value FROM settings WHERE key = ?').get('admin_password');

    if (!storedHash || !bcrypt.compareSync(adminPwd || '', storedHash.value)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  };

  return {
    checkPassword,
    checkAdminPassword
  };
}

module.exports = { createAuthMiddleware };
