/**
 * Authentication Routes
 * Handles login, admin auth, and settings
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const { validate, validateBody, schemas } = require('../lib/validation');

/**
 * Create auth router with dependencies
 * @param {Object} db - Database instance
 * @param {Object} auth - Auth middleware {checkPassword, checkAdminPassword}
 * @param {Object} rateLimiter - Rate limiter for auth endpoints
 * @returns {express.Router} Configured router
 */
function createAuthRoutes(db, auth, rateLimiter) {
  const router = express.Router();
  const { checkPassword, checkAdminPassword } = auth;

  /**
   * POST /api/auth
   * Verify game password
   */
  router.post('/auth', rateLimiter, validateBody(schemas.auth), (req, res) => {
    const { password } = req.body;
    const sanitizedPassword = validate.sanitizeString(password, 200);
    const storedHash = db.prepare('SELECT value FROM settings WHERE key = ?').get('game_password');

    if (storedHash && bcrypt.compareSync(sanitizedPassword, storedHash.value)) {
      res.json({ success: true });
    } else {
      res.status(401).json({ error: 'Invalid password' });
    }
  });

  /**
   * POST /api/admin-auth
   * Verify admin password (requires game password)
   */
  router.post('/admin-auth', rateLimiter, checkPassword, validateBody(schemas.adminAuth), (req, res) => {
    const { adminPassword } = req.body;
    const sanitizedAdminPassword = validate.sanitizeString(adminPassword, 200);
    const storedHash = db.prepare('SELECT value FROM settings WHERE key = ?').get('admin_password');

    if (storedHash && bcrypt.compareSync(sanitizedAdminPassword, storedHash.value)) {
      res.json({ success: true });
    } else {
      res.status(403).json({ error: 'Invalid admin password' });
    }
  });

  /**
   * GET /api/settings
   * Get application settings (admin only)
   */
  router.get('/settings', checkPassword, checkAdminPassword, (req, res) => {
    const settings = {};
    const rows = db.prepare('SELECT key, value FROM settings').all();
    rows.forEach(row => {
      if (row.key === 'game_password' || row.key === 'admin_password') {
        settings[row.key] = '********';
      } else {
        settings[row.key] = row.value;
      }
    });

    // Get active API config
    const activeConfig = db.prepare('SELECT name, model FROM api_configs WHERE is_active = 1').get();
    settings.active_api_config = activeConfig || null;

    res.json(settings);
  });

  /**
   * POST /api/settings
   * Update application settings (admin only)
   */
  router.post('/settings', checkPassword, checkAdminPassword, (req, res) => {
    const { max_tokens_before_compact, new_password } = req.body;

    const updateSetting = db.prepare('UPDATE settings SET value = ? WHERE key = ?');

    if (max_tokens_before_compact !== undefined) {
      updateSetting.run(String(max_tokens_before_compact), 'max_tokens_before_compact');
    }
    if (new_password) {
      const hash = bcrypt.hashSync(new_password, 10);
      updateSetting.run(hash, 'game_password');
    }

    res.json({ success: true });
  });

  return router;
}

module.exports = { createAuthRoutes };
