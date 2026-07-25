/**
 * API Configuration Routes
 * Handles AI provider configuration management
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { testConnection, validateEndpointSafety, normalizeReasoningEffort } = require('../services/aiService');

/**
 * Create API config router with dependencies
 * @param {Object} db - Database instance
 * @param {Object} auth - Auth middleware {requireUser, requireAdmin}
 * @returns {express.Router} Configured router
 */
function createApiConfigRoutes(db, auth) {
  const router = express.Router();
  const { requireAdmin } = auth;

  /**
   * GET /api/api-configs
   * List all API configurations (keys masked)
   */
  router.get('/', requireAdmin, (req, res) => {
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
  router.post('/', requireAdmin, async (req, res) => {
    const { name, endpoint, api_key, model, reasoning_effort, is_active } = req.body;

    if (!name || !endpoint || !api_key || !model) {
      return res.status(400).json({ error: 'Missing required fields: name, endpoint, api_key, model' });
    }

    let safeEndpoint;
    try {
      safeEndpoint = await validateEndpointSafety(endpoint);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    const id = uuidv4();

    // If this is set as active, deactivate all others
    if (is_active) {
      db.prepare('UPDATE api_configs SET is_active = 0').run();
    }

    db.prepare('INSERT INTO api_configs (id, name, endpoint, api_key, model, reasoning_effort, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id, name, safeEndpoint, api_key, model, normalizeReasoningEffort(reasoning_effort), is_active ? 1 : 0
    );

    const config = db.prepare('SELECT * FROM api_configs WHERE id = ?').get(id);
    config.api_key = '****' + config.api_key.slice(-4);
    res.json(config);
  });

  /**
   * PUT /api/api-configs/:id
   * Update API configuration
   */
  router.put('/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { name, endpoint, api_key, model, reasoning_effort } = req.body;

    const existing = db.prepare('SELECT * FROM api_configs WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Configuration not found' });
    }

    // Only update api_key if a new one is provided (not masked)
    const newApiKey = api_key && !api_key.startsWith('****') ? api_key : existing.api_key;

    let safeEndpoint;
    try {
      safeEndpoint = await validateEndpointSafety(endpoint || existing.endpoint);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    db.prepare('UPDATE api_configs SET name = ?, endpoint = ?, api_key = ?, model = ?, reasoning_effort = ? WHERE id = ?').run(
      name || existing.name,
      safeEndpoint,
      newApiKey,
      model || existing.model,
      reasoning_effort === undefined ? (existing.reasoning_effort || '') : normalizeReasoningEffort(reasoning_effort),
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
  router.delete('/:id', requireAdmin, (req, res) => {
    const { id } = req.params;

    const existing = db.prepare('SELECT * FROM api_configs WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Configuration not found' });
    }

    // Don't allow deleting the active configuration
    if (existing.is_active) {
      return res.status(400).json({ error: 'Cannot delete active configuration. Activate another configuration first.' });
    }
    const assignedRole = db.prepare(`
      SELECT key FROM settings
      WHERE key IN ('narrator_api_config_id', 'agent_api_config_id') AND value = ?
      LIMIT 1
    `).get(id);
    if (assignedRole) {
      return res.status(400).json({ error: 'Cannot delete a configuration assigned to an AI role. Change the Narrator or Agents selection first.' });
    }

    db.prepare('DELETE FROM api_configs WHERE id = ?').run(id);
    res.json({ success: true });
  });

  /**
   * POST /api/api-configs/:id/activate
   * Activate specific API configuration
   */
  router.post('/:id/activate', requireAdmin, (req, res) => {
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
  router.post('/test-connection', requireAdmin, async (req, res) => {
    const { api_endpoint, api_key, api_model, reasoning_effort } = req.body;

    if (!api_endpoint || !api_key || !api_model) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
      const safeEndpoint = await validateEndpointSafety(api_endpoint);
      const result = await testConnection({
        endpoint: safeEndpoint,
        api_key: api_key,
        model: api_model,
        reasoning_effort: normalizeReasoningEffort(reasoning_effort)
      });

      if (result.success) {
        res.json({ success: true, message: result.message });
      } else {
        res.status(500).json({ error: result.message });
      }
    } catch (error) {
      res.status(500).json({ error: 'Test failed: ' + error.message });
    }
  });

  /**
   * POST /api/test-connection/:id
   * Test API connection by config ID
   */
  router.post('/test-connection/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;

    const config = db.prepare('SELECT * FROM api_configs WHERE id = ?').get(id);
    if (!config) {
      return res.status(404).json({ error: 'Configuration not found' });
    }

    try {
      const result = await testConnection({
        endpoint: config.endpoint,
        api_key: config.api_key,
        model: config.model,
        reasoning_effort: config.reasoning_effort || ''
      });

      if (result.success) {
        res.json({ success: true, message: result.message });
      } else {
        res.status(500).json({ error: result.message });
      }
    } catch (error) {
      res.status(500).json({ error: 'Test failed: ' + error.message });
    }
  });

  return router;
}

module.exports = { createApiConfigRoutes };
