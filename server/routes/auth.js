/**
 * Authentication Routes
 * Cookie-based user sessions.
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const { validate, validateBody, schemas } = require('../lib/validation');
const { queuePOVImageCleanup } = require('../services/imageGenerationService');

// Precomputed bcrypt hash of a random string. Used to keep login timing constant
// when a supplied username does not exist (prevents user enumeration).
const DUMMY_HASH = bcrypt.hashSync('__invalid__placeholder__', 10);

// In-memory sliding-window rate limit for POST /api/login.
// Keyed on client IP + submitted username. Single-node deploy behind Basic Auth,
// so a Map is sufficient; no Redis/new dep required.
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const LOGIN_MAX_ATTEMPTS = 10;
const loginAttempts = new Map();

function checkLoginRateLimit(key) {
  const now = Date.now();
  const windowStart = now - LOGIN_WINDOW_MS;
  const entry = loginAttempts.get(key) || [];
  const recent = entry.filter(ts => ts > windowStart);
  if (recent.length >= LOGIN_MAX_ATTEMPTS) {
    return { allowed: false, retryAfter: Math.ceil((recent[0] + LOGIN_WINDOW_MS - now) / 1000) };
  }
  recent.push(now);
  loginAttempts.set(key, recent);
  return { allowed: true };
}

function clearLoginRateLimit(key) {
  loginAttempts.delete(key);
}

// Periodic sweep so the Map can't grow unboundedly.
setInterval(() => {
  const cutoff = Date.now() - LOGIN_WINDOW_MS;
  for (const [key, timestamps] of loginAttempts) {
    const kept = timestamps.filter(ts => ts > cutoff);
    if (kept.length === 0) loginAttempts.delete(key);
    else loginAttempts.set(key, kept);
  }
}, 5 * 60 * 1000).unref();

function createAuthRoutes(db, auth) {
  const router = express.Router();
  const { requireUser, requireAdmin, createSession, deleteSession, buildCookie, isSecureRequest } = auth;

  /**
   * POST /api/login  { username, password }
   */
  router.post('/login', validateBody(schemas.login), (req, res) => {
    const username = validate.sanitizeString(req.body.username, 100);
    const password = validate.sanitizeString(req.body.password, 200);
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const rateKey = `${req.ip}:${username.toLowerCase()}`;
    const gate = checkLoginRateLimit(rateKey);
    if (!gate.allowed) {
      res.setHeader('Retry-After', String(gate.retryAfter));
      return res.status(429).json({ error: `Too many login attempts. Try again in ${gate.retryAfter}s.` });
    }

    const user = db.prepare('SELECT id, username, password_hash, is_admin FROM users WHERE username = ?').get(username);
    // Always run bcrypt — against the real hash if the user exists, else a dummy.
    // Keeps response time constant so attackers can't enumerate usernames via timing.
    const hashToCheck = user ? user.password_hash : DUMMY_HASH;
    const passwordValid = bcrypt.compareSync(password, hashToCheck);
    if (!user || !passwordValid) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const { token, maxAgeSeconds } = createSession(user.id);
    const cookie = buildCookie(token, { maxAgeSeconds, secure: isSecureRequest(req) });
    res.setHeader('Set-Cookie', cookie);
    clearLoginRateLimit(rateKey);
    res.json({ user: { id: user.id, username: user.username, is_admin: user.is_admin } });
  });

  /**
   * POST /api/logout
   */
  router.post('/logout', requireUser, (req, res) => {
    deleteSession(req.sessionToken);
    const cookie = buildCookie('', { clear: true, secure: isSecureRequest(req) });
    res.setHeader('Set-Cookie', cookie);
    res.json({ success: true });
  });

  /**
   * GET /api/me
   */
  router.get('/me', requireUser, (req, res) => {
    res.json({ user: req.user });
  });

  /**
   * GET /api/settings  (admin only)
   */
  router.get('/settings', requireAdmin, (req, res) => {
    const settings = {};
    const rows = db.prepare('SELECT key, value FROM settings').all();
    rows.forEach(row => {
      if (row.key === 'game_password' || row.key === 'admin_password' || row.key === 'youtube_api_key' || row.key === 'pov_image_api_key') return;
      settings[row.key] = row.value;
    });
    settings.youtube_configured = !!db.prepare("SELECT value FROM settings WHERE key = 'youtube_api_key'").get()?.value;
    settings.pov_image_configured = !!db.prepare("SELECT value FROM settings WHERE key = 'pov_image_api_key'").get()?.value;

    const activeConfig = db.prepare('SELECT name, model FROM api_configs WHERE is_active = 1').get();
    settings.active_api_config = activeConfig || null;

    res.json(settings);
  });

  /**
   * POST /api/settings  (admin only)
   */
  router.post('/settings', requireAdmin, (req, res) => {
    const {
      max_tokens_before_compact,
      narrator_api_config_id,
      agent_api_config_id,
      youtube_dj_enabled,
      youtube_api_key,
      pov_image_enabled,
      pov_image_auto_enabled,
      pov_image_provider,
      pov_image_endpoint,
      pov_image_api_key,
      pov_image_model,
      pov_image_style_prompt
    } = req.body;
    const updateSetting = db.prepare('UPDATE settings SET value = ? WHERE key = ?');
    const roleAssignments = [
      ['narrator_api_config_id', narrator_api_config_id],
      ['agent_api_config_id', agent_api_config_id]
    ];
    for (const [key, value] of roleAssignments) {
      if (value === undefined) continue;
      const configId = String(value || '').trim();
      if (configId && !db.prepare('SELECT 1 FROM api_configs WHERE id = ?').get(configId)) {
        return res.status(400).json({ error: `The selected ${key === 'narrator_api_config_id' ? 'narrator' : 'agent'} configuration no longer exists.` });
      }
    }
    if (max_tokens_before_compact !== undefined) {
      updateSetting.run(String(max_tokens_before_compact), 'max_tokens_before_compact');
    }
    for (const [key, value] of roleAssignments) {
      if (value !== undefined) updateSetting.run(String(value || '').trim(), key);
    }
    if (youtube_dj_enabled !== undefined) {
      updateSetting.run(youtube_dj_enabled ? 'true' : 'false', 'youtube_dj_enabled');
    }
    if (typeof youtube_api_key === 'string' && youtube_api_key.trim()) {
      updateSetting.run(youtube_api_key.trim().slice(0, 300), 'youtube_api_key');
    }
    if (pov_image_enabled !== undefined) {
      updateSetting.run(pov_image_enabled ? 'true' : 'false', 'pov_image_enabled');
    }
    if (pov_image_auto_enabled !== undefined) {
      updateSetting.run(pov_image_auto_enabled ? 'true' : 'false', 'pov_image_auto_enabled');
    }
    if (['openai', 'nanogpt', 'chat_completions'].includes(pov_image_provider)) {
      updateSetting.run(pov_image_provider, 'pov_image_provider');
    }
    if (typeof pov_image_endpoint === 'string' && pov_image_endpoint.trim()) {
      updateSetting.run(pov_image_endpoint.trim().slice(0, 500), 'pov_image_endpoint');
    }
    if (typeof pov_image_api_key === 'string' && pov_image_api_key.trim()) {
      updateSetting.run(pov_image_api_key.trim().slice(0, 500), 'pov_image_api_key');
    }
    if (typeof pov_image_model === 'string' && pov_image_model.trim()) {
      updateSetting.run(pov_image_model.trim().slice(0, 200), 'pov_image_model');
    }
    if (typeof pov_image_style_prompt === 'string') {
      updateSetting.run(pov_image_style_prompt.trim().slice(0, 1000), 'pov_image_style_prompt');
    }
    res.json({ success: true });
  });

  router.post('/settings/pov-images/cleanup', requireAdmin, async (req, res) => {
    try {
      const result = await queuePOVImageCleanup(db, 3);
      res.json({ success: true, ...result });
    } catch (error) {
      res.status(500).json({ error: 'Failed to clean POV scene images: ' + error.message });
    }
  });

  return router;
}

module.exports = { createAuthRoutes };
