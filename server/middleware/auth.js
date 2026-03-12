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
   * Game password check — now a passthrough since EasyPanel basic auth
   * protects the entire service at the Traefik level.
   */
  const checkPassword = (req, res, next) => {
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
