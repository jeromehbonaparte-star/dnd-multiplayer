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
 * @param {Function} deps.parseAcEffects - AC effects parser
 * @param {Function} deps.calculateTotalAC - AC calculator
 * @param {Function} deps.updateCharacterAC - AC updater (takes db, charId, acEffects)
 * @param {Function} deps.compactHistory - History compaction function
 * @param {string} deps.AI_RESPONSE_PREFIX - Response prefix for AI
 * @param {Function} deps.getSessionCharacters - Get session characters (takes db, sessionId)
 * @returns {express.Router}
 */
function createSessionRoutes(deps) {
  const {
    db, io, auth, aiService,
    processingSessions,
    getActiveApiConfig,
    processAITurn,
    DEFAULT_SYSTEM_PROMPT,
    parseAcEffects,
    calculateTotalAC,
    updateCharacterAC,
    compactHistory,
    AI_RESPONSE_PREFIX,
    getSessionCharacters: getSessionCharactersFn
  } = deps;

  const router = express.Router();
  const { checkPassword, checkAdminPassword } = auth;
  const { findCharacterByName } = tagParser;

  // Helper to get session characters
  function getSessionCharacters(sessionId) {
    if (getSessionCharactersFn) {
      return getSessionCharactersFn(db, sessionId);
    }
    // Fallback inline implementation
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

Write an atmospheric opening scene that sets the mood and introduces the world. Describe where the party finds themselves and what they see, hear, and sense around them. Make it vivid and immersive, drawing the players into the story.

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
      db.prepare('DELETE FROM game_snapshots WHERE session_id = ?').run(sessionId);
      const result = db.prepare('DELETE FROM game_sessions WHERE id = ?').run(sessionId);

      if (result.changes > 0) {
        io.emit('session_deleted', sessionId);
        res.json({ success: true });
      } else {
        res.status(404).json({ error: 'Session not found' });
      }
    } catch (error) {
      console.error('Error deleting session:', error);
      res.status(500).json({ error: 'Failed to delete session: ' + error.message });
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

    console.log(`GM Nudge added to session ${sessionId}: "${message.substring(0, 50)}..."`);
    res.json({ success: true, message: 'GM message added. It will be included in the next AI response.' });
  });

  /**
   * POST /api/sessions/:id/generate-choices
   * Generate choices on demand for the current scene
   */
  router.post('/:id/generate-choices', checkPassword, async (req, res) => {
    const sessionId = req.params.id;
    const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const config = getActiveApiConfig();
    if (!config) return res.status(400).json({ error: 'No active API configuration' });

    const characters = getSessionCharacters(sessionId);
    if (characters.length === 0) return res.status(400).json({ error: 'No characters in session' });

    const fullHistory = JSON.parse(session.full_history || '[]');
    // Find the last narration
    const lastNarration = [...fullHistory].reverse().find(
      e => e.role === 'assistant' || e.type === 'narration'
    );
    if (!lastNarration) return res.status(400).json({ error: 'No narration found to generate choices for' });

    const charNames = characters.map(c => c.character_name).join(', ');
    const charDetails = characters.map(c =>
      `${c.character_name} (${c.race} ${c.class} Lv${c.level})`
    ).join(', ');

    const choicePrompt = [
      { role: 'system', content: `You are a D&D 5e Dungeon Master. Given the current scene, generate 2-4 suggested actions per character using CHOICE tags. Characters in the party: ${charDetails}.

Format: [CHOICE: CharacterName | STAT | DIFFICULTY | Short action description]
- STAT = STR, DEX, CON, INT, WIS, CHA
- DIFFICULTY = EASY, MEDIUM, or HARD
- Use "ALL" for actions any character can take
- Make choices organic to the scene, mix difficulties and stats
- Output ONLY the choice tags, nothing else.` },
      { role: 'user', content: `Current scene:\n${lastNarration.content.substring(0, 2000)}\n\nGenerate choices for: ${charNames}` }
    ];

    try {
      const data = await aiService.callAI(config, choicePrompt, { maxTokens: 1024, temperature: 0.9 });
      const responseText = data.choices?.[0]?.message?.content || '';
      const choices = tagParser.parseChoices(responseText, characters);
      io.emit('choices_generated', { sessionId, choices });
      res.json({ success: true, choices });
    } catch (error) {
      console.error('Failed to generate choices:', error);
      res.status(500).json({ error: 'Failed to generate choices: ' + error.message });
    }
  });

  /**
   * POST /api/sessions/:id/reroll
   * Reroll - Regenerate the last AI response (admin only)
   */
  router.post('/:id/reroll', checkPassword, checkAdminPassword, async (req, res) => {
    const sessionId = req.params.id;

    if (processingSessions.has(sessionId)) {
      return res.status(409).json({
        error: 'Turn is already being processed.',
        processing: true
      });
    }

    const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    let fullHistory = JSON.parse(session.full_history || '[]');

    if (fullHistory.length === 0) {
      return res.status(400).json({ error: 'No history to reroll' });
    }

    // Find the last assistant message
    let lastAssistantIdx = -1;
    for (let i = fullHistory.length - 1; i >= 0; i--) {
      if (fullHistory[i].role === 'assistant') {
        lastAssistantIdx = i;
        break;
      }
    }

    if (lastAssistantIdx === -1) {
      return res.status(400).json({ error: 'No AI response to reroll' });
    }

    // Find the context message that started this turn
    let turnStartIdx = lastAssistantIdx;
    for (let i = lastAssistantIdx - 1; i >= 0; i--) {
      if (fullHistory[i].type === 'context') {
        turnStartIdx = i;
        break;
      }
    }

    // Collect the actions from this turn
    const actionsThisTurn = [];
    for (let i = turnStartIdx; i < lastAssistantIdx; i++) {
      if (fullHistory[i].type === 'action' && fullHistory[i].character_id) {
        actionsThisTurn.push({
          character_id: fullHistory[i].character_id,
          action: fullHistory[i].content
        });
      }
    }

    if (actionsThisTurn.length === 0) {
      return res.status(400).json({ error: 'No actions found for this turn' });
    }

    // Remove everything from turnStartIdx onwards (includes the turn's context, actions, gm_nudges, and AI response)
    // Don't filter out gm_nudges from remaining history - they belong to earlier turns
    fullHistory = fullHistory.slice(0, turnStartIdx);

    // Adjust compacted_count if we truncated into the compacted region
    let compactedCount = session.compacted_count || 0;
    const originalCompactedCount = compactedCount;
    if (fullHistory.length < compactedCount) {
      compactedCount = fullHistory.length;
    }

    db.prepare('UPDATE game_sessions SET full_history = ?, compacted_count = ? WHERE id = ?')
      .run(JSON.stringify(fullHistory), compactedCount, sessionId);

    if (compactedCount !== originalCompactedCount) {
      console.log(`Reroll: Adjusted compacted_count from ${originalCompactedCount} to ${compactedCount}`);
    }

    // Restore character states from the most recent snapshot (fixes double stat changes on reroll)
    try {
      const snapshot = db.prepare('SELECT * FROM game_snapshots WHERE session_id = ? ORDER BY turn_number DESC LIMIT 1').get(sessionId);
      if (snapshot) {
        const states = JSON.parse(snapshot.character_states);
        for (const state of states) {
          db.prepare('UPDATE characters SET hp = ?, xp = ?, gold = ?, inventory = ?, spell_slots = ?, ac = ?, ac_effects = ? WHERE id = ?')
            .run(state.hp, state.xp, state.gold, state.inventory, state.spell_slots, state.ac, state.ac_effects, state.id);
        }
        // Delete the used snapshot so the new turn creates a fresh one
        db.prepare('DELETE FROM game_snapshots WHERE id = ?').run(snapshot.id);
        console.log(`Reroll: Restored character states from snapshot (turn ${snapshot.turn_number})`);
      }
    } catch (snapshotError) {
      console.error('Failed to restore snapshot during reroll:', snapshotError.message);
    }

    // Clear any existing pending actions and re-create from collected actions
    db.prepare('DELETE FROM pending_actions WHERE session_id = ?').run(sessionId);

    for (const action of actionsThisTurn) {
      db.prepare('INSERT INTO pending_actions (id, session_id, character_id, action) VALUES (?, ?, ?, ?)')
        .run(uuidv4(), sessionId, action.character_id, action.action);
    }

    const pendingActions = db.prepare('SELECT * FROM pending_actions WHERE session_id = ?').all(sessionId);
    const characters = getSessionCharacters(sessionId);

    console.log(`Reroll initiated for session ${sessionId}: removed last response, ${actionsThisTurn.length} actions restored`);

    processingSessions.add(sessionId);
    io.emit('reroll_started', { sessionId });

    try {
      const result = await processAITurn(sessionId, pendingActions, characters);
      res.json({ success: true, result });
    } catch (error) {
      console.error('Reroll AI processing error:', error);
      res.status(500).json({ error: error.message });
    } finally {
      processingSessions.delete(sessionId);
    }
  });

  /**
   * POST /api/sessions/:id/auto-reply
   * AI Auto-Reply - Generate and submit action for a character
   */
  router.post('/:id/auto-reply', checkPassword, async (req, res) => {
    const sessionId = req.params.id;
    const { character_id, context } = req.body;

    if (!character_id) {
      return res.status(400).json({ error: 'Character ID is required' });
    }

    const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(character_id);
    if (!character) {
      return res.status(404).json({ error: 'Character not found' });
    }

    const storySummary = session.story_summary || '';

    const fullHistory = JSON.parse(session.full_history || '[]');
    const visibleHistory = fullHistory.filter(m => !m.hidden && m.type !== 'context');
    const recentHistory = visibleHistory.slice(-30);

    const lastDMMessage = [...recentHistory].reverse().find(m => m.role === 'assistant');

    const recentExchanges = recentHistory.slice(-10).map(m => {
      if (m.role === 'assistant') return `DM: ${m.content.substring(0, 800)}`;
      if (m.character_name) return `${m.character_name}: ${m.content}`;
      return null;
    }).filter(Boolean).join('\n\n');

    const recentPlayerActions = recentHistory
      .filter(m => m.role === 'user' && m.character_name && m.character_name !== character.character_name)
      .slice(-5);

    const sessionChars = getSessionCharacters(sessionId);
    const partyContext = sessionChars.map(c => `${c.character_name} (${c.race} ${c.class}, Level ${c.level})`).join(', ');

    let classFeatures = character.class_features || '';
    let spells = character.spells || '';
    let feats = character.feats || '';

    const prompt = `You are writing a D&D turn action AS A PLAYER would write it - casual, natural, and practical.

CHARACTER:
Name: ${character.character_name}
Race: ${character.race}
Class: ${character.class} (Level ${character.level})
Background: ${character.background || 'Unknown'}
Backstory: ${character.backstory || 'Unknown'}
Spells: ${spells || 'None'}
Class Features: ${classFeatures || 'None'}
Feats: ${feats || 'None'}
HP: ${character.hp}/${character.max_hp}

PARTY: ${partyContext}

${storySummary ? `===== STORY SO FAR =====
${storySummary}
========================

` : ''}===== RECENT EVENTS =====
${recentExchanges}
=========================

===== CURRENT SITUATION (RESPOND TO THIS) =====
${lastDMMessage ? lastDMMessage.content : 'The adventure begins...'}
===============================================

${recentPlayerActions.length > 0 ? `OTHER PLAYERS THIS TURN (don't duplicate their actions):
${recentPlayerActions.map(m => `${m.character_name}: ${m.content}`).join('\n')}
` : ''}
${context ? `PLAYER GUIDANCE: ${context}` : ''}

Write what ${character.character_name} does in response to the current situation.

STYLE - Brief and practical like a real player at the table:
- Use "I" statements (I attack, I cast, I check...)
- 1-2 sentences MAX, casual tone
- Describe INTENT, not full dialogue
- Let the DM narrate the actual scene

GOOD EXAMPLES:
- "I let Lizzie vouch for me and keep my guard up"
- "I cast Fireball at the group of goblins"
- "I try to persuade the guard to let us through"
- "I sneak around to flank while they're distracted"
- "I use Arcane Recovery to get a spell slot back, then take a short rest"

BAD - Don't write dialogue or narration:
- "I say 'Well, that's a hell of a question...'" (too much dialogue)
- "I keep my sword lowered but ready, watching those amber eyes..." (too dramatic)
- Long speeches or in-character monologues

DON'T:
- Write out what your character SAYS word-for-word
- Write dramatically or narrate the scene
- Repeat what other players already did

Generate ONLY a brief action description.`;

    try {
      const activeConfig = db.prepare('SELECT * FROM api_configs WHERE is_active = 1').get();
      if (!activeConfig) {
        return res.status(500).json({ error: 'No active API configuration' });
      }

      const apiResponse = await fetch(activeConfig.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${activeConfig.api_key}`
        },
        body: JSON.stringify({
          model: activeConfig.model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 300,
          temperature: 0.7
        })
      });

      if (!apiResponse.ok) {
        const errorText = await apiResponse.text();
        console.error('AI API error for auto-reply:', errorText);
        return res.status(500).json({ error: 'Failed to generate action' });
      }

      const aiData = await apiResponse.json();
      const generatedAction = aiData.choices?.[0]?.message?.content?.trim();

      if (!generatedAction) {
        return res.status(500).json({ error: 'AI returned empty response' });
      }

      console.log(`Auto-reply generated for ${character.character_name}: "${generatedAction.substring(0, 100)}..."`);

      // Submit this action as if the player did it
      const existing = db.prepare('SELECT * FROM pending_actions WHERE session_id = ? AND character_id = ?').get(sessionId, character_id);
      if (existing) {
        db.prepare('UPDATE pending_actions SET action = ? WHERE id = ?').run(generatedAction, existing.id);
      } else {
        db.prepare('INSERT INTO pending_actions (id, session_id, character_id, action) VALUES (?, ?, ?, ?)').run(uuidv4(), sessionId, character_id, generatedAction);
      }

      const pendingActions = db.prepare('SELECT * FROM pending_actions WHERE session_id = ?').all(sessionId);
      const characters = getSessionCharacters(sessionId);

      io.emit('action_submitted', { sessionId, pendingActions, character_id });

      if (pendingActions.length >= characters.length && characters.length > 0) {
        processingSessions.add(sessionId);
        io.emit('turn_processing', { sessionId });

        try {
          const result = await processAITurn(sessionId, pendingActions, characters);
          res.json({
            success: true,
            action: generatedAction,
            processed: true,
            result,
            message: `Action submitted and turn processed for ${character.character_name}`
          });
        } catch (error) {
          console.error('AI processing error:', error);
          res.json({
            success: true,
            action: generatedAction,
            processed: false,
            error: error.message,
            message: `Action submitted for ${character.character_name}, but turn processing failed`
          });
        } finally {
          processingSessions.delete(sessionId);
        }
      } else {
        res.json({
          success: true,
          action: generatedAction,
          processed: false,
          waiting: characters.length - pendingActions.length,
          message: `Action submitted for ${character.character_name}. Waiting for ${characters.length - pendingActions.length} more player(s).`
        });
      }

    } catch (error) {
      console.error('Auto-reply error:', error);
      res.status(500).json({ error: 'Failed to generate auto-reply: ' + error.message });
    }
  });

  /**
   * GET /api/sessions/:id/summary
   * Get session summary (admin only)
   */
  router.get('/:id/summary', checkPassword, checkAdminPassword, (req, res) => {
    const sessionId = req.params.id;
    const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const fullHistory = JSON.parse(session.full_history || '[]');

    res.json({
      summary: session.story_summary || '',
      compactedCount: session.compacted_count || 0,
      totalMessages: fullHistory.length,
      uncompactedMessages: fullHistory.length - (session.compacted_count || 0)
    });
  });

  /**
   * POST /api/sessions/:id/summary
   * Update session summary (admin only)
   */
  router.post('/:id/summary', checkPassword, checkAdminPassword, (req, res) => {
    const sessionId = req.params.id;
    const { summary } = req.body;

    const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    db.prepare('UPDATE game_sessions SET story_summary = ? WHERE id = ?').run(summary || '', sessionId);

    console.log(`Summary manually updated for session ${sessionId}`);
    res.json({ success: true, message: 'Summary updated successfully.' });
  });

  /**
   * POST /api/sessions/:id/force-compact
   * Force compact session history (admin only)
   */
  router.post('/:id/force-compact', checkPassword, checkAdminPassword, async (req, res) => {
    const sessionId = req.params.id;
    const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const apiConfig = getActiveApiConfig();
    if (!apiConfig || !apiConfig.api_key) {
      return res.status(400).json({ error: 'No active API configuration.' });
    }

    const fullHistory = JSON.parse(session.full_history || '[]');
    const compactedCount = session.compacted_count || 0;
    const characters = getSessionCharacters(sessionId);

    const recentHistory = fullHistory.slice(compactedCount);

    if (recentHistory.length === 0) {
      return res.status(400).json({ error: 'No new messages to compact.' });
    }

    try {
      console.log(`Force compacting session ${sessionId}...`);
      const newSummary = await compactHistory(apiConfig, session.story_summary, recentHistory, characters, aiService.extractAIMessage);

      db.prepare('UPDATE game_sessions SET story_summary = ?, compacted_count = ?, total_tokens = 0 WHERE id = ?')
        .run(newSummary, fullHistory.length, sessionId);

      io.emit('session_compacted', { sessionId, compactedCount: fullHistory.length });

      res.json({
        success: true,
        message: `Compacted ${recentHistory.length} messages into summary.`,
        newSummaryLength: newSummary.length,
        messagesCompacted: recentHistory.length
      });

    } catch (error) {
      console.error('Force compact error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/sessions/:id/delete-message
   * Delete message from session history
   */
  router.post('/:id/delete-message', checkPassword, (req, res) => {
    const sessionId = req.params.id;
    const { index } = req.body;

    if (index === undefined || index < 0) {
      return res.status(400).json({ error: 'Invalid message index' });
    }

    const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    try {
      const history = JSON.parse(session.full_history || '[]');

      if (index >= history.length) {
        return res.status(400).json({ error: 'Message index out of range' });
      }

      const deletedMessage = history.splice(index, 1)[0];

      let compactedCount = session.compacted_count || 0;
      if (index < compactedCount) {
        compactedCount = Math.max(0, compactedCount - 1);
      }
      compactedCount = Math.min(compactedCount, history.length);

      db.prepare('UPDATE game_sessions SET full_history = ?, compacted_count = ? WHERE id = ?')
        .run(JSON.stringify(history), compactedCount, sessionId);

      io.emit('session_updated', { id: sessionId });

      console.log(`Deleted message at index ${index} from session ${sessionId}:`, deletedMessage?.type || deletedMessage?.role);
      if (compactedCount !== (session.compacted_count || 0)) {
        console.log(`Adjusted compacted_count from ${session.compacted_count || 0} to ${compactedCount}`);
      }

      res.json({ success: true, deletedIndex: index, remainingCount: history.length, compactedCount });
    } catch (error) {
      console.error('Failed to delete message:', error);
      res.status(500).json({ error: 'Failed to delete message: ' + error.message });
    }
  });

  /**
   * POST /api/sessions/:id/recalculate-xp
   * Scan history for XP awards
   */
  router.post('/:id/recalculate-xp', checkPassword, (req, res) => {
    const sessionId = req.params.id;
    const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const characters = getSessionCharacters(sessionId);
    const history = JSON.parse(session.full_history || '[]');

    const xpAwarded = {};
    characters.forEach(c => { xpAwarded[c.id] = 0; });

    console.log('=== Recalculating XP ===');
    console.log('Session characters:', characters.map(c => c.character_name));
    for (const entry of history) {
      if (entry.role === 'assistant') {
        const xpMatches = entry.content.match(/\[XP:\s*([^\]]+)\]/gi);
        if (xpMatches) {
          console.log('Found XP tags:', xpMatches);
          for (const match of xpMatches) {
            const xpAwards = match.replace(/\[XP:\s*/i, '').replace(']', '').split(',');
            for (const award of xpAwards) {
              const xpMatch = award.trim().match(/(.+?)\s*\+\s*(\d+)/);
              console.log('XP parse:', award.trim(), '->', xpMatch);
              if (xpMatch) {
                const charName = xpMatch[1].trim();
                const xpAmount = parseInt(xpMatch[2]);
                const char = findCharacterByName(characters, charName);
                if (char) {
                  xpAwarded[char.id] = (xpAwarded[char.id] || 0) + xpAmount;
                  console.log(`XP found: ${charName} -> ${char.character_name} +${xpAmount}`);
                } else {
                  console.log(`XP SKIP: Character "${charName}" not found in session`);
                }
              }
            }
          }
        }
      }
    }
    console.log('Total XP awarded:', xpAwarded);

    for (const [charId, xp] of Object.entries(xpAwarded)) {
      db.prepare('UPDATE characters SET xp = ? WHERE id = ?').run(xp, charId);
    }

    const updatedCharacters = getSessionCharacters(sessionId);
    for (const char of updatedCharacters) {
      io.emit('character_updated', char);
    }

    res.json({ success: true, xpAwarded });
  });

  /**
   * POST /api/sessions/:id/recalculate-loot
   * Scan history for gold and items
   */
  router.post('/:id/recalculate-loot', checkPassword, (req, res) => {
    const sessionId = req.params.id;
    const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const characters = getSessionCharacters(sessionId);
    const history = JSON.parse(session.full_history || '[]');

    const goldAwarded = {};
    const inventoryChanges = {};
    characters.forEach(c => {
      goldAwarded[c.id] = 0;
      inventoryChanges[c.id] = [];
    });

    for (const entry of history) {
      if (entry.role === 'assistant') {
        const goldMatches = entry.content.match(/\[(MONEY|GOLD):([^\]]+)\]/gi);
        if (goldMatches) {
          for (const match of goldMatches) {
            const goldAwards = match.replace(/\[(MONEY|GOLD):/i, '').replace(']', '').split(',');
            for (const award of goldAwards) {
              const goldMatch = award.trim().match(/(.+?)\s*([+-])(\d+)/);
              if (goldMatch) {
                const charName = goldMatch[1].trim();
                const sign = goldMatch[2] === '+' ? 1 : -1;
                const goldAmount = parseInt(goldMatch[3]) * sign;
                const char = findCharacterByName(characters, charName);
                if (char) {
                  goldAwarded[char.id] = (goldAwarded[char.id] || 0) + goldAmount;
                }
              }
            }
          }
        }

        const itemMatches = entry.content.match(/\[ITEM:([^\]]+)\]/gi);
        if (itemMatches) {
          for (const match of itemMatches) {
            const itemAwards = match.replace(/\[ITEM:/i, '').replace(']', '').split(',');
            for (const award of itemAwards) {
              const itemMatch = award.trim().match(/(.+?)\s*([+-])(.+)/);
              if (itemMatch) {
                const charName = itemMatch[1].trim();
                const isAdding = itemMatch[2] === '+';
                let itemName = itemMatch[3].trim();

                let quantity = 1;
                const qtyMatch = itemName.match(/(.+?)\s*x(\d+)$/i);
                if (qtyMatch) {
                  itemName = qtyMatch[1].trim();
                  quantity = parseInt(qtyMatch[2]);
                }

                const char = findCharacterByName(characters, charName);
                if (char) {
                  inventoryChanges[char.id].push({
                    item: itemName,
                    quantity: isAdding ? quantity : -quantity
                  });
                }
              }
            }
          }
        }
      }
    }

    for (const char of characters) {
      const newGold = Math.max(0, goldAwarded[char.id] || 0);

      const inventory = [];
      for (const change of inventoryChanges[char.id]) {
        const existingItem = inventory.find(i => i.name.toLowerCase() === change.item.toLowerCase());
        if (existingItem) {
          existingItem.quantity += change.quantity;
          if (existingItem.quantity <= 0) {
            inventory.splice(inventory.indexOf(existingItem), 1);
          }
        } else if (change.quantity > 0) {
          inventory.push({ name: change.item, quantity: change.quantity });
        }
      }

      db.prepare('UPDATE characters SET gold = ?, inventory = ? WHERE id = ?')
        .run(newGold, JSON.stringify(inventory), char.id);
    }

    const updatedCharacters = getSessionCharacters(sessionId);
    for (const char of updatedCharacters) {
      io.emit('character_updated', char);
    }

    res.json({ success: true, goldAwarded, inventoryChanges });
  });

  /**
   * POST /api/sessions/:id/recalculate-inventory
   * Recalculate inventory only from session history
   */
  router.post('/:id/recalculate-inventory', checkPassword, (req, res) => {
    const sessionId = req.params.id;
    const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const characters = getSessionCharacters(sessionId);
    const history = JSON.parse(session.full_history || '[]');
    const inventoryChanges = {};

    for (const char of characters) {
      inventoryChanges[char.id] = [];
    }

    for (const entry of history) {
      if (entry.role === 'assistant') {
        const itemMatches = entry.content.match(/\[ITEM:([^\]]+)\]/gi);
        if (itemMatches) {
          for (const match of itemMatches) {
            const itemAwards = match.replace(/\[ITEM:/i, '').replace(']', '').split(',');
            for (const award of itemAwards) {
              const itemMatch = award.trim().match(/(.+?)\s*([+-])(.+)/);
              if (itemMatch) {
                const charName = itemMatch[1].trim();
                const isAdding = itemMatch[2] === '+';
                let itemName = itemMatch[3].trim();

                let quantity = 1;
                const qtyMatch = itemName.match(/(.+?)\s*x(\d+)$/i);
                if (qtyMatch) {
                  itemName = qtyMatch[1].trim();
                  quantity = parseInt(qtyMatch[2]);
                }

                const char = findCharacterByName(characters, charName);
                if (char) {
                  inventoryChanges[char.id].push({
                    item: itemName,
                    quantity: isAdding ? quantity : -quantity
                  });
                }
              }
            }
          }
        }
      }
    }

    for (const char of characters) {
      const inventory = [];
      for (const change of inventoryChanges[char.id]) {
        const existingItem = inventory.find(i => i.name.toLowerCase() === change.item.toLowerCase());
        if (existingItem) {
          existingItem.quantity += change.quantity;
          if (existingItem.quantity <= 0) {
            inventory.splice(inventory.indexOf(existingItem), 1);
          }
        } else if (change.quantity > 0) {
          inventory.push({ name: change.item, quantity: change.quantity });
        }
      }

      db.prepare('UPDATE characters SET inventory = ? WHERE id = ?')
        .run(JSON.stringify(inventory), char.id);
    }

    const updatedCharacters = getSessionCharacters(sessionId);
    for (const char of updatedCharacters) {
      io.emit('character_updated', char);
    }

    res.json({ success: true, inventoryChanges });
  });

  /**
   * POST /api/sessions/:id/recalculate-ac-spells
   * Recalculate AC and spell slots from session history
   */
  router.post('/:id/recalculate-ac-spells', checkPassword, (req, res) => {
    const sessionId = req.params.id;
    const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const characters = getSessionCharacters(sessionId);
    const history = JSON.parse(session.full_history || '[]');
    const acValues = {};
    const acEffectsTracking = {};
    const spellSlotUsage = {};

    // Initialize tracking for each character
    for (const char of characters) {
      acValues[char.id] = null;
      acEffectsTracking[char.id] = parseAcEffects(char.ac_effects);
      spellSlotUsage[char.id] = {};
    }

    // Scan all messages for AC and spell slot information
    for (const entry of history) {
      const content = entry.content || '';

      // Parse [AC:] tags
      const acMatches = content.match(/\[AC:([^\]]+)\]/gi);
      if (acMatches) {
        for (const match of acMatches) {
          const acContent = match.replace(/\[AC:/i, '').replace(']', '').trim();

          const baseMatch = acContent.match(/(.+?)\s+base\s+(.+?)\s+(\d+)$/i);
          if (baseMatch) {
            const charName = baseMatch[1].trim();
            const armorName = baseMatch[2].trim();
            const baseValue = parseInt(baseMatch[3]);
            const char = findCharacterByName(characters, charName);
            if (char) {
              acEffectsTracking[char.id].base_source = armorName;
              acEffectsTracking[char.id].base_value = baseValue;
            }
            continue;
          }

          const addMatch = acContent.match(/(.+?)\s+\+(.+?)\s+\+(\d+)\s+(\w+)$/i);
          if (addMatch) {
            const charName = addMatch[1].trim();
            const effectName = addMatch[2].trim();
            const effectValue = parseInt(addMatch[3]);
            const effectType = addMatch[4].trim().toLowerCase();
            const char = findCharacterByName(characters, charName);
            if (char) {
              const existingIdx = acEffectsTracking[char.id].effects.findIndex(e => e.name.toLowerCase() === effectName.toLowerCase());
              if (existingIdx !== -1) {
                acEffectsTracking[char.id].effects[existingIdx].value = effectValue;
                acEffectsTracking[char.id].effects[existingIdx].type = effectType;
              } else {
                acEffectsTracking[char.id].effects.push({
                  id: uuidv4(),
                  name: effectName,
                  value: effectValue,
                  type: effectType,
                  temporary: effectType === 'spell',
                  notes: ''
                });
              }
            }
            continue;
          }

          const removeMatch = acContent.match(/(.+?)\s+-(.+)$/i);
          if (removeMatch) {
            const charName = removeMatch[1].trim();
            const effectName = removeMatch[2].trim();
            const char = findCharacterByName(characters, charName);
            if (char) {
              acEffectsTracking[char.id].effects = acEffectsTracking[char.id].effects.filter(
                e => e.name.toLowerCase() !== effectName.toLowerCase()
              );
            }
            continue;
          }
        }
      }

      // Parse [SPELL:] tags
      const spellMatches = content.match(/\[SPELL:([^\]]+)\]/gi);
      if (spellMatches) {
        for (const match of spellMatches) {
          const spellContent = match.replace(/\[SPELL:/i, '').replace(']', '');
          const parts = spellContent.split(',');

          for (const part of parts) {
            const trimmed = part.trim();

            const restMatch = trimmed.match(/(.+?)\s*\+REST/i);
            if (restMatch) {
              const charName = restMatch[1].trim();
              const char = findCharacterByName(characters, charName);
              if (char) {
                for (const level in spellSlotUsage[char.id]) {
                  spellSlotUsage[char.id][level].usedCount = 0;
                }
              }
              continue;
            }

            const slotMatch = trimmed.match(/(.+?)\s*([+-])(\d+)(?:st|nd|rd|th)/i);
            if (slotMatch) {
              const charName = slotMatch[1].trim();
              const isUsing = slotMatch[2] === '-';
              const level = slotMatch[3];
              const char = findCharacterByName(characters, charName);
              if (char) {
                if (!spellSlotUsage[char.id][level]) {
                  spellSlotUsage[char.id][level] = { usedCount: 0, detected: true };
                }
                if (isUsing) {
                  spellSlotUsage[char.id][level].usedCount++;
                } else {
                  spellSlotUsage[char.id][level].usedCount = Math.max(0, spellSlotUsage[char.id][level].usedCount - 1);
                }
              }
            }
          }
        }
      }

      // Parse natural language spell casting
      const naturalSpellPattern = /(\w+(?:\s+\w+)?)\s+(?:casts?|uses?|expends?)\s+.+?(?:using\s+)?(?:a\s+)?(\d+)(?:st|nd|rd|th)[\s-]*level\s+(?:spell\s+)?slot/gi;
      let naturalMatch;
      while ((naturalMatch = naturalSpellPattern.exec(content)) !== null) {
        const charName = naturalMatch[1].trim();
        const level = naturalMatch[2];
        const char = findCharacterByName(characters, charName);
        if (char) {
          if (!spellSlotUsage[char.id][level]) {
            spellSlotUsage[char.id][level] = { usedCount: 0, detected: true };
          }
          spellSlotUsage[char.id][level].usedCount++;
        }
      }

      // Parse AC mentions from AI responses
      if (entry.role === 'assistant') {
        for (const char of characters) {
          const charNamePattern = char.character_name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

          const acPatterns = [
            new RegExp(`${charNamePattern}[^.]*?(?:AC|Armor\\s*Class)\\s*(?:is\\s*(?:now\\s*)?|:\\s*|of\\s*|=\\s*)(\\d+)`, 'i'),
            new RegExp(`(?:AC|Armor\\s*Class)\\s*(?:is\\s*(?:now\\s*)?|:\\s*|of\\s*|=\\s*)(\\d+)[^.]*?${charNamePattern}`, 'i'),
            new RegExp(`${charNamePattern}'s\\s*(?:AC|Armor\\s*Class)\\s*(?:is\\s*)?(?:now\\s*)?(\\d+)`, 'i')
          ];

          for (const pattern of acPatterns) {
            const acMatch = content.match(pattern);
            if (acMatch) {
              const acValue = parseInt(acMatch[1]);
              if (acValue >= 5 && acValue <= 30) {
                acValues[char.id] = acValue;
              }
            }
          }
        }
      }
    }

    // Update characters with found values
    const results = { acUpdated: {}, acEffectsUpdated: {}, spellSlotsUpdated: {} };

    for (const char of characters) {
      let updated = false;

      const trackedEffects = acEffectsTracking[char.id];
      const totalAc = calculateTotalAC(trackedEffects);
      updateCharacterAC(db, char.id, trackedEffects);
      results.acEffectsUpdated[char.character_name] = {
        total: totalAc,
        base: `${trackedEffects.base_source}: ${trackedEffects.base_value}`,
        effects: trackedEffects.effects.map(e => `${e.name}: +${e.value}`)
      };
      updated = true;

      if (acValues[char.id] !== null && trackedEffects.effects.length === 0) {
        trackedEffects.base_value = acValues[char.id];
        updateCharacterAC(db, char.id, trackedEffects);
        results.acUpdated[char.character_name] = acValues[char.id];
      }

      // Update spell slots using .current/.max pattern
      const detectedSlots = spellSlotUsage[char.id];
      if (Object.keys(detectedSlots).length > 0) {
        let currentSlots = {};
        try {
          currentSlots = JSON.parse(char.spell_slots || '{}');
        } catch (e) {
          currentSlots = {};
        }

        for (const level in detectedSlots) {
          if (!currentSlots[level]) {
            const estimatedMax = Math.max(2, detectedSlots[level].usedCount + 1);
            currentSlots[level] = { current: estimatedMax - detectedSlots[level].usedCount, max: estimatedMax };
          } else {
            currentSlots[level].current = Math.max(0, currentSlots[level].max - detectedSlots[level].usedCount);
          }
        }

        db.prepare('UPDATE characters SET spell_slots = ? WHERE id = ?').run(JSON.stringify(currentSlots), char.id);
        results.spellSlotsUpdated[char.character_name] = currentSlots;
        updated = true;
      }
    }

    const updatedCharacters = getSessionCharacters(sessionId);
    for (const char of updatedCharacters) {
      io.emit('character_updated', char);
    }

    res.json({ success: true, ...results });
  });

  /**
   * POST /api/sessions/:id/add-character
   * Add a character to the session
   */
  router.post('/:id/add-character', checkPassword, (req, res) => {
    const sessionId = req.params.id;
    const { characterId } = req.body;

    if (!characterId) {
      return res.status(400).json({ error: 'characterId is required' });
    }

    const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(characterId);
    if (!character) {
      return res.status(404).json({ error: 'Character not found' });
    }

    db.prepare('INSERT OR IGNORE INTO session_characters (id, session_id, character_id) VALUES (?, ?, ?)')
      .run(uuidv4(), sessionId, characterId);

    const sessionChars = getSessionCharacters(sessionId);
    io.emit('session_updated', { id: sessionId });

    console.log(`Character ${character.character_name} added to session ${session.name}`);
    res.json({ success: true, sessionCharacters: sessionChars });
  });

  /**
   * POST /api/sessions/:id/remove-character
   * Remove a character from the session
   */
  router.post('/:id/remove-character', checkPassword, (req, res) => {
    const sessionId = req.params.id;
    const { characterId } = req.body;

    if (!characterId) {
      return res.status(400).json({ error: 'characterId is required' });
    }

    const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    db.prepare('DELETE FROM session_characters WHERE session_id = ? AND character_id = ?')
      .run(sessionId, characterId);

    // Also delete any pending actions for this character in this session
    db.prepare('DELETE FROM pending_actions WHERE session_id = ? AND character_id = ?')
      .run(sessionId, characterId);

    const sessionChars = getSessionCharacters(sessionId);
    io.emit('session_updated', { id: sessionId });

    console.log(`Character ${characterId} removed from session ${session.name}`);
    res.json({ success: true, sessionCharacters: sessionChars });
  });

  return router;
}

module.exports = { createSessionRoutes };
