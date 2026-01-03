/**
 * Session Routes
 * Handles game session management, actions, and history
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { validate, validateBody, schemas } = require('../lib/validation');
const tagParser = require('../services/tagParser');

/**
 * Create session router with dependencies
 * @param {Object} deps - Dependencies
 * @param {Object} deps.db - Database instance
 * @param {Object} deps.io - Socket.IO instance
 * @param {Object} deps.auth - Auth middleware
 * @param {Object} deps.aiService - AI service
 * @param {Set} deps.processingSessions - Set tracking sessions being processed
 * @param {Function} deps.getActiveApiConfig - Function to get active API config
 * @param {Function} deps.processAITurn - Function to process AI turn
 * @param {string} deps.DEFAULT_SYSTEM_PROMPT - Default DM system prompt
 * @returns {express.Router}
 */
function createSessionRoutes(deps) {
  const {
    db, io, auth, aiService,
    processingSessions,
    getActiveApiConfig,
    processAITurn,
    DEFAULT_SYSTEM_PROMPT
  } = deps;

  const router = express.Router();
  const { checkPassword, checkAdminPassword } = auth;

  // Helper to get session characters
  function getSessionCharacters(sessionId) {
    return db.prepare(`
      SELECT c.* FROM characters c
      INNER JOIN session_characters sc ON c.id = sc.character_id
      WHERE sc.session_id = ?
      ORDER BY c.created_at DESC
    `).all(sessionId);
  }

  /**
   * GET /api/sessions
   * List all sessions
   */
  router.get('/', checkPassword, (req, res) => {
    const sessions = db.prepare('SELECT * FROM game_sessions ORDER BY created_at DESC').all();
    res.json(sessions);
  });

  /**
   * POST /api/sessions
   * Create new session with optional AI opening scene
   */
  router.post('/', checkPassword, validateBody(schemas.session), async (req, res) => {
    const { name, scenario, scenarioPrompt, characterIds } = req.body;

    const sanitizedName = validate.sanitizeString(name, 200);
    const sanitizedScenario = validate.sanitizeString(scenario || 'classic_fantasy', 100);
    const sanitizedPrompt = validate.sanitizeString(scenarioPrompt || '', 10000);
    const validCharIds = (characterIds || []).filter(id => validate.isUUID(id));

    const id = uuidv4();

    db.prepare('INSERT INTO game_sessions (id, name, full_history, story_summary, scenario) VALUES (?, ?, ?, ?, ?)')
      .run(id, sanitizedName, '[]', '', sanitizedScenario);

    // Link selected characters
    if (validCharIds.length > 0) {
      const insertChar = db.prepare('INSERT OR IGNORE INTO session_characters (id, session_id, character_id) VALUES (?, ?, ?)');
      for (const charId of validCharIds) {
        insertChar.run(uuidv4(), id, charId);
      }
    }

    // Generate opening scene with AI
    if (sanitizedPrompt) {
      try {
        const apiConfig = getActiveApiConfig();
        if (apiConfig && apiConfig.api_key) {
          const characters = validCharIds.length > 0
            ? db.prepare(`SELECT * FROM characters WHERE id IN (${validCharIds.map(() => '?').join(',')})`).all(...validCharIds)
            : [];

          let characterIntro = '';
          if (characters.length > 0) {
            characterIntro = '\n\nThe party consists of:\n' + characters.map(c => {
              let classDisplay = `${c.class} ${c.level}`;
              try {
                const classes = JSON.parse(c.classes || '{}');
                if (Object.keys(classes).length > 0) {
                  classDisplay = Object.entries(classes).map(([cls, lvl]) => `${cls} ${lvl}`).join('/');
                }
              } catch (e) {}
              return `- ${c.character_name}, ${c.race} ${classDisplay} (played by ${c.player_name})`;
            }).join('\n');
          }

          const openingPrompt = `You are starting a new adventure with this setting: ${sanitizedPrompt}${characterIntro}

Write an atmospheric opening scene that sets the mood and introduces the world. Describe where the party finds themselves and what they see, hear, and sense around them. Make it vivid and immersive.

DO NOT give the players a list of choices or options. End with an evocative description that invites them to act on their own initiative.`;

          const response = await fetch(apiConfig.api_endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiConfig.api_key}`
            },
            body: JSON.stringify({
              model: apiConfig.api_model,
              messages: [
                { role: 'system', content: DEFAULT_SYSTEM_PROMPT },
                { role: 'user', content: openingPrompt }
              ],
              max_tokens: 2000
            })
          });

          if (response.ok) {
            const data = await response.json();
            const openingScene = aiService.extractAIMessage(data);
            if (openingScene) {
              const history = [{ role: 'assistant', content: openingScene, type: 'narration' }];
              db.prepare('UPDATE game_sessions SET full_history = ? WHERE id = ?').run(JSON.stringify(history), id);
            }
          }
        }
      } catch (error) {
        console.error('Failed to generate opening scene:', error);
      }
    }

    const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(id);
    io.emit('session_created', session);
    res.json(session);
  });

  /**
   * GET /api/sessions/:id
   * Get session details with pending actions
   */
  router.get('/:id', checkPassword, (req, res) => {
    const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const pendingActions = db.prepare('SELECT * FROM pending_actions WHERE session_id = ?').all(req.params.id);
    const sessionChars = getSessionCharacters(req.params.id);

    res.json({ session, pendingActions, sessionCharacters: sessionChars });
  });

  /**
   * DELETE /api/sessions/:id
   * Delete session and associated data
   */
  router.delete('/:id', checkPassword, (req, res) => {
    const sessionId = req.params.id;

    try {
      db.prepare('DELETE FROM pending_actions WHERE session_id = ?').run(sessionId);
      db.prepare('DELETE FROM session_characters WHERE session_id = ?').run(sessionId);
      db.prepare('DELETE FROM combats WHERE session_id = ?').run(sessionId);
      db.prepare('DELETE FROM game_sessions WHERE id = ?').run(sessionId);

      io.emit('session_deleted', sessionId);
      res.json({ success: true });
    } catch (error) {
      console.error('Error deleting session:', error);
      res.status(500).json({ error: 'Failed to delete session' });
    }
  });

  /**
   * POST /api/sessions/:id/action
   * Submit player action
   */
  router.post('/:id/action', checkPassword, async (req, res) => {
    const { character_id, action } = req.body;
    const sessionId = req.params.id;

    if (processingSessions.has(sessionId)) {
      return res.status(409).json({
        error: 'Turn is currently being processed. Please wait for the Narrator to finish.',
        processing: true
      });
    }

    const existing = db.prepare('SELECT * FROM pending_actions WHERE session_id = ? AND character_id = ?').get(sessionId, character_id);
    if (existing) {
      db.prepare('UPDATE pending_actions SET action = ? WHERE id = ?').run(action, existing.id);
    } else {
      db.prepare('INSERT INTO pending_actions (id, session_id, character_id, action) VALUES (?, ?, ?, ?)').run(uuidv4(), sessionId, character_id, action);
    }

    const pendingActions = db.prepare('SELECT * FROM pending_actions WHERE session_id = ?').all(sessionId);
    const characters = getSessionCharacters(sessionId);

    io.emit('action_submitted', { sessionId, pendingActions, character_id });

    if (pendingActions.length >= characters.length && characters.length > 0) {
      processingSessions.add(sessionId);
      io.emit('turn_processing', { sessionId });

      try {
        const result = await processAITurn(sessionId, pendingActions, characters);
        res.json({ processed: true, result });
      } catch (error) {
        console.error('AI processing error:', error);
        res.json({ processed: false, error: error.message });
      } finally {
        processingSessions.delete(sessionId);
      }
    } else {
      res.json({ processed: false, waiting: characters.length - pendingActions.length });
    }
  });

  /**
   * DELETE /api/sessions/:id/action/:characterId
   * Cancel pending action
   */
  router.delete('/:id/action/:characterId', checkPassword, (req, res) => {
    const { id: sessionId, characterId } = req.params;

    db.prepare('DELETE FROM pending_actions WHERE session_id = ? AND character_id = ?').run(sessionId, characterId);

    const pendingActions = db.prepare('SELECT * FROM pending_actions WHERE session_id = ?').all(sessionId);
    io.emit('action_cancelled', { sessionId, pendingActions, character_id: characterId });

    res.json({ success: true, pendingActions });
  });

  /**
   * POST /api/sessions/:id/process
   * Force process turn (DM override)
   */
  router.post('/:id/process', checkPassword, async (req, res) => {
    const sessionId = req.params.id;

    if (processingSessions.has(sessionId)) {
      return res.status(409).json({ error: 'Turn is already being processed.', processing: true });
    }

    const pendingActions = db.prepare('SELECT * FROM pending_actions WHERE session_id = ?').all(sessionId);
    const characters = getSessionCharacters(sessionId);

    processingSessions.add(sessionId);
    io.emit('turn_processing', { sessionId });

    try {
      const result = await processAITurn(sessionId, pendingActions, characters);
      res.json({ success: true, result });
    } catch (error) {
      console.error('AI processing error:', error);
      res.status(500).json({ error: error.message });
    } finally {
      processingSessions.delete(sessionId);
    }
  });

  /**
   * POST /api/sessions/:id/gm-message
   * Send hidden GM message (admin only)
   */
  router.post('/:id/gm-message', checkPassword, checkAdminPassword, (req, res) => {
    const sessionId = req.params.id;
    const { message } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    let fullHistory = JSON.parse(session.full_history || '[]');
    fullHistory.push({
      role: 'user',
      content: message.trim(),
      type: 'gm_nudge',
      hidden: true,
      timestamp: new Date().toISOString()
    });

    db.prepare('UPDATE game_sessions SET full_history = ? WHERE id = ?').run(JSON.stringify(fullHistory), sessionId);

    res.json({ success: true, message: 'GM message added. It will be included in the next AI response.' });
  });

  /**
   * GET /api/sessions/:id/summary
   * Get session summary (admin only)
   */
  router.get('/:id/summary', checkPassword, checkAdminPassword, (req, res) => {
    const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const fullHistory = JSON.parse(session.full_history || '[]');

    res.json({
      summary: session.story_summary || '',
      compactedCount: session.compacted_count || 0,
      totalMessages: fullHistory.length,
      pendingMessages: fullHistory.length - (session.compacted_count || 0)
    });
  });

  /**
   * POST /api/sessions/:id/summary
   * Update session summary (admin only)
   */
  router.post('/:id/summary', checkPassword, checkAdminPassword, (req, res) => {
    const { summary } = req.body;
    const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    db.prepare('UPDATE game_sessions SET story_summary = ? WHERE id = ?').run(summary || '', req.params.id);

    res.json({ success: true });
  });

  /**
   * POST /api/sessions/:id/delete-message
   * Delete message from history
   */
  router.post('/:id/delete-message', checkPassword, (req, res) => {
    const { index } = req.body;
    const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    let fullHistory = JSON.parse(session.full_history || '[]');

    if (index < 0 || index >= fullHistory.length) {
      return res.status(400).json({ error: 'Invalid message index' });
    }

    fullHistory.splice(index, 1);
    db.prepare('UPDATE game_sessions SET full_history = ? WHERE id = ?').run(JSON.stringify(fullHistory), req.params.id);

    res.json({ success: true, newLength: fullHistory.length });
  });

  /**
   * POST /api/sessions/:id/recalculate-xp
   * Scan history for XP awards
   */
  router.post('/:id/recalculate-xp', checkPassword, (req, res) => {
    const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const characters = getSessionCharacters(req.params.id);
    const history = JSON.parse(session.full_history || '[]');

    const xpAwarded = {};
    characters.forEach(c => { xpAwarded[c.id] = 0; });

    for (const entry of history) {
      if (entry.role === 'assistant') {
        const awards = tagParser.parseXPAwards(entry.content, characters);
        for (const award of awards) {
          xpAwarded[award.characterId] = (xpAwarded[award.characterId] || 0) + award.amount;
        }
      }
    }

    // Update characters
    for (const [charId, totalXP] of Object.entries(xpAwarded)) {
      if (totalXP > 0) {
        db.prepare('UPDATE characters SET xp = ? WHERE id = ?').run(totalXP, charId);
      }
    }

    res.json({ success: true, xpAwarded });
  });

  /**
   * POST /api/sessions/:id/recalculate-loot
   * Scan history for gold and items
   */
  router.post('/:id/recalculate-loot', checkPassword, (req, res) => {
    const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const characters = getSessionCharacters(req.params.id);
    const history = JSON.parse(session.full_history || '[]');

    const goldAwarded = {};
    const inventoryChanges = {};
    characters.forEach(c => {
      goldAwarded[c.id] = 0;
      inventoryChanges[c.id] = [];
    });

    for (const entry of history) {
      if (entry.role === 'assistant') {
        // Parse gold
        const goldChanges = tagParser.parseMoneyChanges(entry.content, characters);
        for (const change of goldChanges) {
          goldAwarded[change.characterId] = (goldAwarded[change.characterId] || 0) + change.amount;
        }

        // Parse items
        const itemChanges = tagParser.parseItemChanges(entry.content, characters);
        for (const change of itemChanges) {
          inventoryChanges[change.characterId].push(change);
        }
      }
    }

    // Apply changes
    for (const char of characters) {
      // Update gold
      const newGold = Math.max(0, goldAwarded[char.id] || 0);
      db.prepare('UPDATE characters SET gold = ? WHERE id = ?').run(newGold, char.id);

      // Update inventory
      let inventory = [];
      for (const change of inventoryChanges[char.id]) {
        inventory = tagParser.applyInventoryChange(inventory, change.item, change.quantity, change.isAdding);
      }
      db.prepare('UPDATE characters SET inventory = ? WHERE id = ?').run(JSON.stringify(inventory), char.id);
    }

    res.json({ success: true, goldAwarded, inventoryChanges });
  });

  return router;
}

module.exports = { createSessionRoutes };
