/**
 * API Configuration Routes
 * Handles AI provider configuration management
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { testConnection } = require('../services/aiService');

/**
 * Create API config router with dependencies
 * @param {Object} db - Database instance
 * @param {Object} auth - Auth middleware {checkPassword}
 * @returns {express.Router} Configured router
 */
function createApiConfigRoutes(db, auth) {
  const router = express.Router();
  const { checkPassword } = auth;

  /**
   * GET /api/api-configs
   * List all API configurations (keys masked)
   */
  router.get('/', checkPassword, (req, res) => {
    const configs = db.prepare('SELECT * FROM api_configs ORDER BY created_at DESC').all();
    // Mask API keys for security
    const maskedConfigs = configs.map(config => ({
      ...config,
      api_key: config.api_key ? '****' + config.api_key.slice(-4) : ''
    }));
    res.json(maskedConfigs);
  });

  /**
   * POST /api/api-configs
   * Create new API configuration
   */
  router.post('/', checkPassword, (req, res) => {
    const { name, endpoint, api_key, model, is_active } = req.body;

    if (!name || !endpoint || !api_key || !model) {
      return res.status(400).json({ error: 'Missing required fields: name, endpoint, api_key, model' });
    }

    const id = uuidv4();

    // If this is set as active, deactivate all others
    if (is_active) {
      db.prepare('UPDATE api_configs SET is_active = 0').run();
    }

    db.prepare('INSERT INTO api_configs (id, name, endpoint, api_key, model, is_active) VALUES (?, ?, ?, ?, ?, ?)').run(id, name, endpoint, api_key, model, is_active ? 1 : 0);

    const config = db.prepare('SELECT * FROM api_configs WHERE id = ?').get(id);
    config.api_key = '****' + config.api_key.slice(-4);
    res.json(config);
  });

  /**
   * PUT /api/api-configs/:id
   * Update API configuration
   */
  router.put('/:id', checkPassword, (req, res) => {
    const { id } = req.params;
    const { name, endpoint, api_key, model } = req.body;

    const existing = db.prepare('SELECT * FROM api_configs WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Configuration not found' });
    }

    // Only update api_key if a new one is provided (not masked)
    const newApiKey = api_key && !api_key.startsWith('****') ? api_key : existing.api_key;

    db.prepare('UPDATE api_configs SET name = ?, endpoint = ?, api_key = ?, model = ? WHERE id = ?').run(
      name || existing.name,
      endpoint || existing.endpoint,
      newApiKey,
      model || existing.model,
      id
    );

    const updated = db.prepare('SELECT * FROM api_configs WHERE id = ?').get(id);
    updated.api_key = '****' + updated.api_key.slice(-4);
    res.json(updated);
  });

  /**
   * DELETE /api/api-configs/:id
   * Delete API configuration
   */
  router.delete('/:id', checkPassword, (req, res) => {
    const { id } = req.params;

    const existing = db.prepare('SELECT * FROM api_configs WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Configuration not found' });
    }

    // Don't allow deleting the active configuration
    if (existing.is_active) {
      return res.status(400).json({ error: 'Cannot delete active configuration. Activate another configuration first.' });
    }

    db.prepare('DELETE FROM api_configs WHERE id = ?').run(id);
    res.json({ success: true });
  });

  /**
   * POST /api/api-configs/:id/activate
   * Activate specific API configuration
   */
  router.post('/:id/activate', checkPassword, (req, res) => {
    const { id } = req.params;

    const existing = db.prepare('SELECT * FROM api_configs WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Configuration not found' });
    }

    db.prepare('UPDATE api_configs SET is_active = 0').run();
    db.prepare('UPDATE api_configs SET is_active = 1 WHERE id = ?').run(id);

    res.json({ success: true });
  });

  /**
   * POST /api/test-connection
   * Test API connection with provided credentials
   */
  router.post('/test-connection', checkPassword, async (req, res) => {
    const { api_endpoint, api_key, api_model } = req.body;

    if (!api_endpoint || !api_key || !api_model) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const result = await testConnection({
      endpoint: api_endpoint,
      api_key: api_key,
      model: api_model
    });

    if (result.success) {
      res.json({ success: true, message: result.message });
    } else {
      res.status(500).json({ error: result.message });
    }
  });

  /**
   * POST /api/test-connection/:id
   * Test API connection by config ID
   */
  router.post('/test-connection/:id', checkPassword, async (req, res) => {
    const { id } = req.params;

    const config = db.prepare('SELECT * FROM api_configs WHERE id = ?').get(id);
    if (!config) {
      return res.status(404).json({ error: 'Configuration not found' });
    }

    const result = await testConnection({
      endpoint: config.endpoint,
      api_key: config.api_key,
      model: config.model
    });

    if (result.success) {
      res.json({ success: true, message: result.message });
    } else {
      res.status(500).json({ error: result.message });
    }
  });

  return router;
}

module.exports = { createApiConfigRoutes };
