/**
 * Authentication Routes
 * Admin auth and settings (game auth handled by EasyPanel basic auth)
 */

const express = require('express');
const { validate, validateBody, schemas } = require('../lib/validation');

function createAuthRoutes(db, auth, rateLimiter) {
  const router = express.Router();
  const { checkAdminPassword } = auth;

  /**
   * POST /api/admin-auth
   * Verify admin password
   */
  router.post('/admin-auth', validateBody(schemas.adminAuth), (req, res) => {
    const bcrypt = require('bcryptjs');
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
  router.get('/settings', checkAdminPassword, (req, res) => {
    const settings = {};
    const rows = db.prepare('SELECT key, value FROM settings').all();
    rows.forEach(row => {
      if (row.key === 'game_password' || row.key === 'admin_password') {
        settings[row.key] = '********';
      } else {
        settings[row.key] = row.value;
      }
    });

    const activeConfig = db.prepare('SELECT name, model FROM api_configs WHERE is_active = 1').get();
    settings.active_api_config = activeConfig || null;

    res.json(settings);
  });

  /**
   * POST /api/settings
   * Update application settings (admin only)
   */
  router.post('/settings', checkAdminPassword, (req, res) => {
    const { max_tokens_before_compact } = req.body;

    const updateSetting = db.prepare('UPDATE settings SET value = ? WHERE key = ?');

    if (max_tokens_before_compact !== undefined) {
      updateSetting.run(String(max_tokens_before_compact), 'max_tokens_before_compact');
    }

    res.json({ success: true });
  });

  return router;
}

module.exports = { createAuthRoutes };
