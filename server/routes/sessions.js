/**
 * Session Routes
 * Handles game session management, actions, and history
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { validate, validateBody, schemas } = require('../lib/validation');
const tagParser = require('../services/tagParser');
const logger = require('../lib/logger');
const combatService = require('../services/combatService');
const combatIntegration = require('../services/combatIntegration');
const { searchYoutubeMusic } = require('../services/youtubeService');
const {
  deletePOVSceneImage,
  deleteEntryPOVImages,
  deleteSessionPOVScenes,
  loadPOVImageSettings,
  queuePOVSceneGeneration,
  queueAutoPOVScenes
} = require('../services/imageGenerationService');

/**
 * Create session router with dependencies
 * @param {Object} deps - Dependencies
 * @param {Object} deps.db - Database instance
 * @param {Object} deps.io - Socket.IO instance
 * @param {Object} deps.auth - Auth middleware
 * @param {Object} deps.aiService - AI service
 * @param {Set} deps.processingSessions - Set tracking sessions being processed
 * @param {Function} deps.getApiConfigForRole - Function to get narrator or agent API config
 * @param {Function} deps.processAITurn - Function to process AI turn
 * @param {Function} deps.emitCharacterUpdate - Character-scoped socket emitter (charId, event, payload)
 * @param {Function} deps.completeCombatTurn - Function to narrate a resolved combat encounter
 * @param {string} deps.DEFAULT_SYSTEM_PROMPT - Default DM system prompt
 * @param {Function} deps.parseAcEffects - AC effects parser
 * @param {Function} deps.calculateTotalAC - AC calculator
 * @param {Function} deps.updateCharacterAC - AC updater (takes db, charId, acEffects)
 * @param {Function} deps.compactHistory - History compaction function
 * @param {Function} deps.getSessionCharacters - Get session characters (takes db, sessionId)
 * @returns {express.Router}
 */
function createSessionRoutes(deps) {
  const {
    db, io, auth, aiService, emitToSession,
    emitCharacterUpdate,
    processingSessions,
    getActiveApiConfig,
    getApiConfigForRole,
    processAITurn,
    completeCombatTurn,
    DEFAULT_SYSTEM_PROMPT,
    parseAcEffects,
    calculateTotalAC,
    updateCharacterAC,
    compactHistory,
    getSessionCharacters: getSessionCharactersFn
  } = deps;

  const router = express.Router();
  const { requireUser, requireAdmin } = auth;
  const { findCharacterByName } = tagParser;
  const sendToSession = typeof emitToSession === 'function'
    ? emitToSession
    : (sessionId, event, payload) => io.emit(event, payload);
  const getRoleApiConfig = role => getApiConfigForRole ? getApiConfigForRole(role) : getActiveApiConfig();
  const sendToCharacter = typeof emitCharacterUpdate === 'function'
    ? emitCharacterUpdate
    : (characterId, event, payload) => io.emit(event, payload);

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

  function isCharacterInSession(sessionId, characterId) {
    const row = db.prepare('SELECT 1 FROM session_characters WHERE session_id = ? AND character_id = ?').get(sessionId, characterId);
    return !!row;
  }

  // Admin bypass, else user must own at least one character in the session.
  function userCanViewSession(user, sessionId) {
    if (user.is_admin) return true;
    const row = db.prepare(`
      SELECT 1 FROM session_characters sc
      JOIN characters c ON c.id = sc.character_id
      WHERE sc.session_id = ? AND c.user_id = ?
      LIMIT 1
    `).get(sessionId, user.id);
    return !!row;
  }

  // Admin bypass, else character.user_id must equal user.id.
  function userOwnsCharacter(user, characterId) {
    if (user.is_admin) return true;
    const row = db.prepare('SELECT user_id FROM characters WHERE id = ?').get(characterId);
    return !!row && row.user_id === user.id;
  }

  // ============================================
  // Narrative combat (NTC) plumbing
  // ============================================

  /**
   * Per-session serialization for every MUTATING combat route.
   *
   * `saveCombat` is a blind UPDATE and the optimistic `version` check happens
   * before the (up to 20s) adjudicator await, so two overlapping requests would
   * TOCTOU each other — a GM "end combat" landing mid-adjudication could be
   * resurrected by the losing writer. Deliberately NOT `processingSessions`:
   * `runCombatConclusion` inspects that set and degrades to the no-narration
   * path when it is already held.
   */
  const combatLocks = new Set();
  const COMBAT_BUSY_ERROR = 'Another combat action is still resolving. Try again in a moment.';

  /**
   * Wraps a combat route handler so at most one mutation per session is in
   * flight. The lock is taken BEFORE the handler body runs, so `getActiveCombat`
   * always loads state under it, and released once the handler settles.
   *
   * The lock is per-route-entry only: internal helpers (`continueCombat`,
   * `driveEnemyTurns`, `runCombatConclusion`) never re-check it, so the enemy
   * turns a route awaits run inside that route's own lock.
   */
  function withCombatLock(handler) {
    return async (req, res, ...rest) => {
      const sessionId = req.params.id;
      if (combatLocks.has(sessionId)) {
        return res.status(409).json({ error: COMBAT_BUSY_ERROR });
      }
      combatLocks.add(sessionId);
      try {
        return await handler(req, res, ...rest);
      } catch (error) {
        // Express 4 does not catch a rejected promise, and a hung request would
        // leave the player staring at a spinner. Answer, then release.
        logger.error('Combat route threw', { sessionId, url: req.originalUrl, error: error.message });
        if (!res.headersSent) res.status(500).json({ error: 'Combat action failed.' });
      } finally {
        combatLocks.delete(sessionId);
      }
    };
  }

  function saveCombat(combat, state) {
    db.prepare('UPDATE combats SET combatants = ?, current_turn = ?, round = ?, is_active = ? WHERE id = ?')
      .run(combatService.serialize(state), state.turnIndex, state.round, state.outcome ? 0 : 1, combat.id);
  }

  /**
   * Re-reads the sheet fields a migrated schema-1 unit cannot carry (grid combat
   * never tracked inventory, spells text, features or class resources).
   */
  function hydrateMigratedCombat(state) {
    const pending = combatIntegration.unitsNeedingHydration(state);
    if (!pending.length) return;
    const selectCharacter = db.prepare('SELECT * FROM characters WHERE id = ?');
    for (const unit of pending) {
      combatIntegration.hydrateMigratedUnit(unit, selectCharacter.get(unit.sourceCharacterId) || null);
    }
  }

  /**
   * Loads the active encounter as schema-2 state. A stored schema-1 grid blob is
   * transcoded, re-hydrated from the character rows and written back once, so
   * every later caller sees narrative state.
   */
  function getActiveCombat(sessionId) {
    const row = db.prepare('SELECT * FROM combats WHERE session_id = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 1').get(sessionId);
    if (!row) return null;
    let raw = null;
    try { raw = JSON.parse(row.combatants || 'null'); } catch (error) { raw = null; }
    const state = combatService.deserialize(raw);
    if (!state) {
      logger.error('Unable to read combat state', { sessionId, combatId: row.id });
      return null;
    }
    const { combatants, ...rest } = row;
    const combat = { ...rest, state };
    if (!raw || Number(raw.schema) !== combatService.COMBAT_SCHEMA_VERSION) {
      hydrateMigratedCombat(state);
      // Schema-1 blobs carried no name — the encounter name lived on the row.
      if (!raw?.name && row.name) state.name = row.name;
      saveCombat(combat, state);
      logger.info('Migrated a tactical encounter to narrative combat', { sessionId, combatId: row.id });
    }
    return combat;
  }

  /** REST-facing envelope: the combats row plus the stripped public state. */
  function toPublicCombat(combat, state) {
    if (!combat || !state) return null;
    return {
      id: combat.id,
      session_id: combat.session_id,
      name: combat.name,
      is_active: state.outcome ? 0 : 1,
      current_turn: state.turnIndex,
      round: state.round,
      created_at: combat.created_at,
      state: combatIntegration.publicCombatState(state)
    };
  }

  function emitCombatUpdate(sessionId, combat, state, options = {}) {
    sendToSession(sessionId, 'combat_updated', combatIntegration.buildCombatUpdatedPayload({
      sessionId,
      combatId: combat?.id,
      state,
      events: options.events || state.log,
      automatic: options.automatic
    }));
  }

  /** Syncs HP / spell slots / inventory back to every party character sheet. */
  function persistCombatWriteback(state) {
    const statements = combatIntegration.buildCharacterWritebackStatements(combatService.collectCharacterWriteback(state));
    for (const statement of statements) {
      try {
        db.prepare(statement.sql).run(...statement.args);
        const row = db.prepare('SELECT * FROM characters WHERE id = ?').get(statement.characterId);
        if (row) sendToCharacter(statement.characterId, 'character_updated', row);
      } catch (error) {
        logger.error('Unable to persist a combat writeback', { characterId: statement.characterId, error: error.message });
      }
    }
  }

  /**
   * Appends one visible combat beat to the session history. Carries no `role`,
   * so the narrator prompt builder skips it; combat reaches the narrator through
   * the conclusion summary instead. Never bumps `current_turn`.
   */
  function appendCombatHistory(sessionId, entryInput) {
    const session = db.prepare('SELECT full_history FROM game_sessions WHERE id = ?').get(sessionId);
    if (!session) return null;
    let history = [];
    try { history = JSON.parse(session.full_history || '[]'); } catch (error) { history = []; }
    if (!Array.isArray(history)) history = [];
    const entry = combatIntegration.buildCombatHistoryEntry(entryInput);
    history.push(entry);
    db.prepare('UPDATE game_sessions SET full_history = ? WHERE id = ?').run(JSON.stringify(history), sessionId);
    return entry;
  }

  function announceCombatStart(sessionId, state) {
    return appendCombatHistory(sessionId, {
      content: `Combat begins: ${state.name}. Every player rolls a d20 for initiative.`,
      unitName: '',
      round: state.round
    });
  }

  /** Fallback record of a finished encounter when the aftermath narration cannot run. */
  function recordCombatOutcome(sessionId, summary) {
    const session = db.prepare('SELECT full_history FROM game_sessions WHERE id = ?').get(sessionId);
    if (!session) return;
    let history = [];
    try { history = JSON.parse(session.full_history || '[]'); } catch (error) { history = []; }
    if (!Array.isArray(history)) history = [];
    history.push({
      role: 'assistant',
      type: 'narration',
      content: summary,
      timestamp: new Date().toISOString()
    });
    db.prepare('UPDATE game_sessions SET full_history = ?, current_turn = current_turn + 1 WHERE id = ?').run(JSON.stringify(history), sessionId);
  }

  /** Ownership without the admin bypass — used to auto-resolve "my" combatant. */
  function ownsCharacterDirectly(user, characterId) {
    const row = db.prepare('SELECT user_id FROM characters WHERE id = ?').get(characterId);
    return !!row && row.user_id === user.id;
  }

  /**
   * Resolves which combatant the caller is acting as. Mirrors /action: an
   * explicit characterId is validated for session membership and ownership;
   * otherwise the caller's own eligible combatant is used, and controlling more
   * than one eligible combatant requires the explicit id.
   */
  function resolveCombatActor(req, state, isEligible) {
    const sessionId = req.params.id;
    const explicitId = req.body?.characterId || req.body?.character_id;
    if (explicitId) {
      if (!isCharacterInSession(sessionId, explicitId)) return { status: 403, error: 'Character is not part of this session' };
      if (!userOwnsCharacter(req.user, explicitId)) return { status: 403, error: 'You do not own this character' };
      const unit = state.units.find(candidate => candidate.side === 'party' && String(candidate.sourceCharacterId) === String(explicitId));
      if (!unit) return { status: 404, error: 'That character is not in this encounter.' };
      return { unit };
    }
    const candidates = state.units.filter(unit => unit.side === 'party'
      && unit.sourceCharacterId
      && ownsCharacterDirectly(req.user, unit.sourceCharacterId)
      && isEligible(unit));
    if (candidates.length === 1) return { unit: candidates[0] };
    if (!candidates.length) return { status: 403, error: 'You have no character able to act in this encounter right now.' };
    return { status: 400, error: 'Send characterId — you control more than one combatant here.' };
  }

  /**
   * Resolves consecutive enemy turns. A failed AI call falls back to a
   * deterministic basic attack built from the engine pre-rolls, so a dead
   * adjudicator can never stall the fight.
   */
  async function driveEnemyTurns(sessionId, combat, state, config) {
    for (let guard = 0; guard < combatIntegration.MAX_ENEMY_TURNS; guard++) {
      if (state.outcome || state.phase !== 'active') break;
      const unit = combatService.currentUnit(state);
      if (!unit || unit.side !== 'enemy') break;

      const round = state.round;
      let adjudication = null;
      if (config?.api_key) {
        try {
          adjudication = await aiService.generateEnemyCombatTurn({ state, enemyUnitId: unit.id, config });
        } catch (error) {
          logger.warn('Enemy combat turn threw', { sessionId, unitId: unit.id, error: error.message });
          adjudication = null;
        }
      }
      if (!adjudication || adjudication.error) {
        if (adjudication?.error) {
          logger.warn('Enemy combat turn failed; using the deterministic fallback', { sessionId, unitId: unit.id, reason: adjudication.error });
        }
        adjudication = combatIntegration.buildEnemyFallbackAdjudication(state, unit.id);
      }
      if (!adjudication) break;

      let result = combatService.applyAdjudication(state, unit.id, adjudication);
      if (!result.ok) {
        const fallback = combatIntegration.buildEnemyFallbackAdjudication(state, unit.id);
        if (fallback) {
          adjudication = fallback;
          result = combatService.applyAdjudication(state, unit.id, fallback);
        }
      }
      if (!result.ok) {
        logger.error('Enemy turn could not be applied; forcing the turn to pass', { sessionId, unitId: unit.id, error: result.error });
        combatIntegration.forceTurnEnd(state);
        saveCombat(combat, state);
        emitCombatUpdate(sessionId, combat, state);
        continue;
      }

      state.turnActionCount = 0;
      persistCombatWriteback(state);
      saveCombat(combat, state);
      const narration = String(adjudication.narration || '');
      appendCombatHistory(sessionId, { content: narration, unitName: unit.name, round });
      sendToSession(sessionId, 'combat_turn_narration', combatIntegration.buildNarrationPayload({
        sessionId, unitName: unit.name, narration, round, warnings: result.warnings
      }));
      emitCombatUpdate(sessionId, combat, state);
    }
  }

  /**
   * The conclusion path shared by natural endings and the GM "end combat"
   * button: summary + aftermath narration through completeCombatTurn (which
   * consumes deferredTurn.openingResolution).
   */
  async function runCombatConclusion(sessionId, state) {
    const summary = combatService.getCombatSummary(state, (state.log || []).slice(-6));
    if (processingSessions.has(sessionId)) {
      recordCombatOutcome(sessionId, summary);
      sendToSession(sessionId, 'turn_processed', { sessionId, response: summary, choices: [], compacted: false });
      return { outcome: state.outcome, summary, narrationPending: false };
    }

    processingSessions.add(sessionId);
    sendToSession(sessionId, 'turn_processing', { sessionId, combatConclusion: true });
    try {
      const characters = getSessionCharacters(sessionId);
      const aftermath = await completeCombatTurn(sessionId, characters, {
        summary,
        openingResolution: state.deferredTurn?.openingResolution || ''
      });
      return { outcome: state.outcome, summary, narrationPending: false, aftermath };
    } catch (error) {
      logger.error('Combat ended but aftermath narration failed', { sessionId, error: error.message });
      recordCombatOutcome(sessionId, summary);
      sendToSession(sessionId, 'turn_processed', { sessionId, response: summary, choices: [], compacted: false, degraded: true });
      return { outcome: state.outcome, summary, narrationPending: false, aftermathError: error.message };
    } finally {
      processingSessions.delete(sessionId);
    }
  }

  /** Enemy turns first, then the conclusion path when the fight is over. */
  async function continueCombat(sessionId, combat, state) {
    await driveEnemyTurns(sessionId, combat, state, getRoleApiConfig('agent'));
    if (!state.outcome) return null;
    return runCombatConclusion(sessionId, state);
  }

  /**
   * Crash recovery for a parked enemy turn.
   *
   * Enemy turns only ever run inside a request. If the process dies mid
   * `driveEnemyTurns`, the persisted state is left resting on an enemy unit and
   * every player route answers 403 ("not your turn") forever. Any read that
   * notices that re-kicks the driver in the background under the same lock the
   * mutating routes take, so it can neither race them nor double-fire.
   *
   * Fire-and-forget on purpose: the caller's response must not wait for it.
   */
  function resumeIfParked(sessionId, combat, state) {
    if (!combat || !state || state.outcome || state.phase !== 'active') return false;
    const unit = combatService.currentUnit(state);
    if (!unit || unit.side !== 'enemy') return false;
    if (combatLocks.has(sessionId)) return false;

    combatLocks.add(sessionId);
    logger.warn('Resuming a parked enemy turn', { sessionId, combatId: combat.id, unitId: unit.id });
    Promise.resolve()
      .then(() => continueCombat(sessionId, combat, state))
      .catch(error => logger.error('Unable to resume a parked enemy turn', { sessionId, combatId: combat.id, error: error.message }))
      .finally(() => combatLocks.delete(sessionId));
    return true;
  }

  /**
   * GET /api/sessions
   * List all sessions
   */
  router.get('/', requireUser, (req, res) => {
    if (req.user.is_admin) {
      const sessions = db.prepare('SELECT * FROM game_sessions ORDER BY created_at DESC').all();
      return res.json(sessions);
    }
    const sessions = db.prepare(`
      SELECT DISTINCT gs.* FROM game_sessions gs
      JOIN session_characters sc ON sc.session_id = gs.id
      JOIN characters c ON c.id = sc.character_id
      WHERE c.user_id = ?
      ORDER BY gs.created_at DESC
    `).all(req.user.id);
    res.json(sessions);
  });

  /**
   * POST /api/sessions
   * Create new session with optional AI opening scene
   */
  router.post('/', requireUser, validateBody(schemas.session), async (req, res) => {
    const { name, scenario, scenarioPrompt, characterIds } = req.body;

    const sanitizedName = validate.sanitizeString(name, 200);
    const sanitizedScenario = validate.sanitizeString(scenario || 'classic_fantasy', 100);
    const sanitizedPrompt = validate.sanitizeString(scenarioPrompt || '', 10000);
    let validCharIds = (characterIds || []).filter(id => validate.isUUID(id));

    // Non-admins: must include at least one of their own characters, and any non-owned
    // character ids they passed are dropped (admin may create sessions with any chars).
    if (!req.user.is_admin && validCharIds.length > 0) {
      const placeholders = validCharIds.map(() => '?').join(',');
      const ownedRows = db.prepare(
        `SELECT id FROM characters WHERE user_id = ? AND id IN (${placeholders})`
      ).all(req.user.id, ...validCharIds);
      const ownedIds = new Set(ownedRows.map(r => r.id));
      validCharIds = validCharIds.filter(id => ownedIds.has(id));
      if (validCharIds.length === 0) {
        return res.status(400).json({ error: 'Session must include at least one character you own' });
      }
    }

    const id = uuidv4();

    db.prepare('INSERT INTO game_sessions (id, name, full_history, story_summary, scenario) VALUES (?, ?, ?, ?, ?)')
      .run(id, sanitizedName, '[]', '', sanitizedScenario);

    // Link selected characters and reset inspiration for the new session
    if (validCharIds.length > 0) {
      const insertChar = db.prepare('INSERT OR IGNORE INTO session_characters (id, session_id, character_id) VALUES (?, ?, ?)');
      const resetInspiration = db.prepare('UPDATE characters SET inspiration_points = 4 WHERE id = ?');
      for (const charId of validCharIds) {
        insertChar.run(uuidv4(), id, charId);
        resetInspiration.run(charId);
      }
    }

    // Generate opening scene with AI
    if (sanitizedPrompt) {
      try {
        const narratorConfig = getRoleApiConfig('narrator');
        const agentConfig = getRoleApiConfig('agent');
        const povConfig = getRoleApiConfig('pov');
        if (narratorConfig?.api_key && agentConfig?.api_key && povConfig?.api_key) {
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
              let info = `- ${c.character_name}, ${c.race} ${classDisplay}`;
              if (c.appearance) info += ` — ${c.appearance}`;
              if (c.backstory) info += ` | Backstory: ${c.backstory}`;
              return info;
            }).join('\n');
          }

          const openingPrompt = `Setting: ${sanitizedPrompt}${characterIntro}

Write an atmospheric opening scene in 3rd person that sets the mood and introduces the world. Describe where the party finds themselves and what they see, hear, and sense around them. Make it vivid and immersive. Keep it to ${aiService.OPENING_SCENE_WORD_LIMIT || 500} words or fewer, and end cleanly with something that invites the players to act.

Do NOT use [CHOICE:] tags or any tracking tags ([HP:], [XP:], etc.) — this is just the intro.`;

          const openingSystemPrompt = `You are the Dungeon Master for a multiplayer D&D 5e game, writing the opening scene. Set the mood and the world through vivid, grounded prose — concrete sensory detail (sound, smell, texture, temperature), not just sight. Show more than you tell. Give any NPCs distinct voices and their own wants. Vary how you name people with meaningful epithets rather than a repeated appearance tag. Match register to the setting. Never narrate the game as a game — no stats, DCs, or numbers in the prose. Avoid lifeless AI tics (delve, tapestry, palpable, "sent shivers down her spine," reflexive "not X but Y"). A blank line between every paragraph. You may use HTML/inline CSS for diegetic objects (signs, documents) — never code blocks.`;

          try {
            // Step 1: Generate unified 3rd-person opening scene
            const data = await aiService.callAI(narratorConfig, [
              { role: 'system', content: openingSystemPrompt },
              { role: 'user', content: openingPrompt }
            ], { maxTokens: aiService.OPENING_SCENE_MAX_TOKENS || 2800 });
            const openingScene = aiService.extractAIMessage(data);

            if (openingScene) {
              // Step 2: Convert to per-character POVs in parallel (with retry)
              let parsedPOVs = {};
              if (characters.length > 0) {
                const povResults = await Promise.all(characters.map(async (c) => {
                  const partyRoster = aiService.buildPOVPartyRoster
                    ? aiService.buildPOVPartyRoster(characters, c)
                    : characters.map(char => `- ${char.character_name}, ${char.race} ${char.class}`).join('\n');
                  const pov = await aiService.generateCharacterPOV(povConfig, c, openingScene, partyRoster);
                  return pov ? { name: c.character_name, pov } : null;
                }));
                for (const r of povResults) {
                  if (r) parsedPOVs[r.name] = r.pov;
                }
              }

              const historyEntry = { role: 'assistant', content: openingScene, type: 'narration' };
              if (Object.keys(parsedPOVs).length > 0) historyEntry.povs = parsedPOVs;

              const history = [historyEntry];
              db.prepare('UPDATE game_sessions SET full_history = ? WHERE id = ?').run(JSON.stringify(history), id);
              queueAutoPOVScenes({
                db,
                aiService,
                sessionId: id,
                index: 0,
                characters,
                aiConfig: agentConfig,
                sendToSession
              });
            }
          } catch (aiError) {
            console.error('Failed to generate opening scene:', aiError);
          }
        }
      } catch (error) {
        console.error('Failed to set up opening scene:', error);
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
  router.get('/:id', requireUser, (req, res) => {
    const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    if (!userCanViewSession(req.user, req.params.id)) {
      return res.status(403).json({ error: 'You do not have a character in this session' });
    }

    const pendingActions = db.prepare('SELECT * FROM pending_actions WHERE session_id = ?').all(req.params.id);
    const sessionChars = getSessionCharacters(req.params.id);
    const povImageEnabled = db.prepare("SELECT value FROM settings WHERE key = 'pov_image_enabled'").get()?.value === 'true';

    const activeCombat = getActiveCombat(req.params.id);
    res.json({
      session,
      pendingActions,
      sessionCharacters: sessionChars,
      combat: activeCombat ? toPublicCombat(activeCombat, activeCombat.state) : null,
      features: { povImageEnabled }
    });

    // After the response: a fight left resting on an enemy unit by a crashed
    // process is un-stuck here, in the background.
    if (activeCombat) resumeIfParked(req.params.id, activeCombat, activeCombat.state);
  });

  /**
   * POST /api/sessions/:id/combat
   * Start a narrative encounter manually. The GM supplies enemies; party units
   * always come from the current session characters. Combat opens in the
   * initiative phase — every player rolls a d20 before the first turn.
   */
  router.post('/:id/combat', requireAdmin, withCombatLock((req, res) => {
    const sessionId = req.params.id;
    const session = db.prepare('SELECT id FROM game_sessions WHERE id = ?').get(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (getActiveCombat(sessionId)) return res.status(409).json({ error: 'An encounter is already active.' });

    const rawEnemies = Array.isArray(req.body?.enemies) ? req.body.enemies : [];
    const enemies = rawEnemies.slice(0, combatService.MAX_COMBATANTS_PER_SIDE).map((enemy, index) => ({
      id: validate.sanitizeString(enemy?.id || String(index + 1), 60),
      name: validate.sanitizeString(enemy?.name || `Enemy ${index + 1}`, 80),
      hp: Number(enemy?.hp),
      ac: Number(enemy?.ac),
      attackBonus: Number(enemy?.attackBonus),
      damageBonus: Number(enemy?.damageBonus),
      damageDie: Number(enemy?.damageDie),
      initiativeBonus: Number(enemy?.initiativeBonus)
    }));
    if (!enemies.length) return res.status(400).json({ error: 'Add at least one enemy to begin combat.' });
    const characters = getSessionCharacters(sessionId);
    if (!characters.length) return res.status(400).json({ error: 'This session has no party members.' });

    try {
      const name = validate.sanitizeString(req.body?.name || 'Combat Encounter', 120);
      const environment = validate.sanitizeString(req.body?.environment || 'plains', 50);
      const state = combatService.createCombat({ name, environment, characters, enemies });
      const combat = {
        id: uuidv4(),
        session_id: sessionId,
        name,
        is_active: 1,
        current_turn: state.turnIndex,
        round: state.round,
        created_at: new Date().toISOString()
      };
      db.prepare('INSERT INTO combats (id, session_id, name, is_active, current_turn, round, combatants) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(combat.id, sessionId, name, 1, state.turnIndex, state.round, combatService.serialize(state));
      db.prepare('DELETE FROM pending_actions WHERE session_id = ?').run(sessionId);
      announceCombatStart(sessionId, state);
      emitCombatUpdate(sessionId, combat, state);
      res.status(201).json({ combat: toPublicCombat(combat, state) });
    } catch (error) {
      logger.error('Unable to start combat', { sessionId, error: error.message });
      res.status(400).json({ error: error.message || 'Unable to start combat.' });
    }
  }));

  /**
   * POST /api/sessions/:id/combat/initiative
   * Body: { roll: 1-20, characterId? }. The player reports the d20 they rolled;
   * the server adds the DEX-based bonus. When the last party unit rolls, the
   * turn order locks in and any leading enemy turns resolve immediately.
   */
  router.post('/:id/combat/initiative', requireUser, withCombatLock(async (req, res) => {
    const sessionId = req.params.id;
    if (!userCanViewSession(req.user, sessionId)) return res.status(403).json({ error: 'You do not have a character in this session' });
    const combat = getActiveCombat(sessionId);
    if (!combat) return res.status(404).json({ error: 'No active encounter.' });
    const state = combat.state;
    if (state.outcome) return res.status(409).json({ error: 'This encounter has already ended.' });
    if (state.phase !== 'initiative') return res.status(409).json({ error: 'Initiative has already been settled.' });

    const roll = combatIntegration.normalizeInitiativeRoll(req.body?.roll);
    if (roll.error) return res.status(400).json({ error: roll.error });

    const actor = resolveCombatActor(req, state, unit => state.pendingInitiative.includes(unit.id));
    if (actor.error) return res.status(actor.status).json({ error: actor.error });

    const applied = combatService.rollInitiative(state, actor.unit.id, roll.roll);
    if (!applied.ok) return res.status(409).json({ error: applied.error, combat: toPublicCombat(combat, state) });

    saveCombat(combat, state);
    emitCombatUpdate(sessionId, combat, state);

    let conclusion = null;
    if (applied.activated) {
      try {
        conclusion = await continueCombat(sessionId, combat, state);
      } catch (error) {
        logger.error('Enemy turns failed after initiative locked in', { sessionId, error: error.message });
      }
    }

    res.json({
      combat: state.outcome ? null : toPublicCombat(combat, state),
      version: state.version,
      phase: state.outcome ? 'ended' : state.phase,
      activated: Boolean(applied.activated),
      outcome: state.outcome || null,
      ...(conclusion || {})
    });
  }));

  /** POST /api/sessions/:id/combat/roll-remaining - GM rolls initiative for stragglers. */
  router.post('/:id/combat/roll-remaining', requireAdmin, withCombatLock(async (req, res) => {
    const sessionId = req.params.id;
    const combat = getActiveCombat(sessionId);
    if (!combat) return res.status(404).json({ error: 'No active encounter.' });
    const state = combat.state;

    const applied = combatService.rollRemainingInitiative(state);
    if (!applied.ok) return res.status(409).json({ error: applied.error, combat: toPublicCombat(combat, state) });

    saveCombat(combat, state);
    emitCombatUpdate(sessionId, combat, state);

    let conclusion = null;
    if (applied.activated) {
      try {
        conclusion = await continueCombat(sessionId, combat, state);
      } catch (error) {
        logger.error('Enemy turns failed after the GM rolled remaining initiative', { sessionId, error: error.message });
      }
    }

    res.json({
      combat: state.outcome ? null : toPublicCombat(combat, state),
      version: state.version,
      rolled: applied.rolled,
      activated: Boolean(applied.activated),
      outcome: state.outcome || null,
      ...(conclusion || {})
    });
  }));

  /**
   * POST /api/sessions/:id/combat/turn-action
   * Body: { action, characterId?, version? }. The active player's freeform
   * action (it may embed a [DICE ROLL] tag) goes to the combat adjudicator; the
   * engine applies the returned Adjudication JSON, the sheet is written back and
   * any enemy turns that follow resolve before the response returns.
   */
  router.post('/:id/combat/turn-action', requireUser, withCombatLock(async (req, res) => {
    const sessionId = req.params.id;
    if (!userCanViewSession(req.user, sessionId)) return res.status(403).json({ error: 'You do not have a character in this session' });
    const combat = getActiveCombat(sessionId);
    if (!combat) return res.status(404).json({ error: 'No active encounter.' });
    const state = combat.state;
    if (state.outcome) return res.status(409).json({ error: 'This encounter has already ended.' });
    if (state.phase !== 'active') return res.status(409).json({ error: 'Initiative is still being rolled.' });
    if (Number.isInteger(req.body?.version) && req.body.version !== state.version) {
      return res.status(409).json({ error: 'The combat changed. Reloading the latest state.', combat: toPublicCombat(combat, state) });
    }

    const parsedAction = combatIntegration.normalizeCombatAction(req.body?.action);
    if (parsedAction.error) return res.status(400).json({ error: parsedAction.error });

    const actor = resolveCombatActor(req, state, unit => combatService.isPlayerTurn(state, unit.sourceCharacterId));
    if (actor.error) return res.status(actor.status).json({ error: actor.error });
    if (!combatService.isPlayerTurn(state, actor.unit.sourceCharacterId)) {
      return res.status(403).json({ error: 'It is not that character\'s turn.', combat: toPublicCombat(combat, state) });
    }

    // Stall cap: a player who keeps submitting without ending their turn loses it.
    if (combatIntegration.shouldForceTurnEnd(combatIntegration.turnActionCount(state))) {
      combatIntegration.forceTurnEnd(state);
      saveCombat(combat, state);
      emitCombatUpdate(sessionId, combat, state);
      let stalledConclusion = null;
      try {
        stalledConclusion = await continueCombat(sessionId, combat, state);
      } catch (error) {
        logger.error('Enemy turns failed after a stalled turn was forced to end', { sessionId, error: error.message });
      }
      return res.status(409).json({
        error: `You have already taken ${combatIntegration.MAX_TURN_ACTIONS} actions this turn — the turn has passed.`,
        combat: state.outcome ? null : toPublicCombat(combat, state),
        version: state.version,
        outcome: state.outcome || null,
        ...(stalledConclusion || {})
      });
    }

    const config = getRoleApiConfig('agent');
    if (!config?.api_key) return res.status(400).json({ error: 'No agent API configuration. Choose one in Settings.' });

    let adjudication;
    try {
      adjudication = await aiService.adjudicateCombatAction({
        state, actingUnitId: actor.unit.id, actionText: parsedAction.action, config
      });
    } catch (error) {
      logger.error('Combat adjudication threw', { sessionId, error: error.message });
      adjudication = { error: 'request-failed', message: error.message };
    }
    if (!adjudication || adjudication.error) {
      logger.warn('Combat adjudication failed', { sessionId, reason: adjudication?.error || 'empty' });
      return res.status(502).json({ error: 'The DM stumbled — try again.' });
    }

    const round = state.round;
    const result = combatService.applyAdjudication(state, actor.unit.id, adjudication);
    if (!result.ok) {
      return res.status(409).json({ error: result.error, combat: toPublicCombat(combat, state) });
    }

    state.turnActionCount = combatIntegration.nextTurnActionCount(state, result.turnAdvanced);
    let turnAdvanced = result.turnAdvanced;
    if (!state.outcome && !turnAdvanced && combatIntegration.shouldForceTurnEnd(state.turnActionCount)) {
      combatIntegration.forceTurnEnd(state);
      turnAdvanced = true;
    }

    persistCombatWriteback(state);
    saveCombat(combat, state);
    const narration = String(adjudication.narration || '');
    appendCombatHistory(sessionId, { content: narration, unitName: actor.unit.name, round });
    sendToSession(sessionId, 'combat_turn_narration', combatIntegration.buildNarrationPayload({
      sessionId, unitName: actor.unit.name, narration, round, warnings: result.warnings
    }));
    emitCombatUpdate(sessionId, combat, state);

    let conclusion = null;
    try {
      if (turnAdvanced && !state.outcome) {
        conclusion = await continueCombat(sessionId, combat, state);
      } else if (state.outcome) {
        conclusion = await runCombatConclusion(sessionId, state);
      }
    } catch (error) {
      logger.error('Combat could not continue after a player turn', { sessionId, error: error.message });
    }

    res.json({
      combat: state.outcome ? null : toPublicCombat(combat, state),
      narration,
      warnings: result.warnings,
      turnAdvanced,
      version: state.version,
      outcome: state.outcome || null,
      ...(conclusion || {})
    });
  }));

  /**
   * POST /api/sessions/:id/combat/end-turn
   * Body: { characterId?, version? }. The acting player voluntarily passes.
   * Same auth + "is it your turn" gate as /combat/turn-action, but no
   * adjudication and no narration: the turn walker simply moves on and the
   * enemy turns that follow resolve before the response returns.
   */
  router.post('/:id/combat/end-turn', requireUser, withCombatLock(async (req, res) => {
    const sessionId = req.params.id;
    if (!userCanViewSession(req.user, sessionId)) return res.status(403).json({ error: 'You do not have a character in this session' });
    const combat = getActiveCombat(sessionId);
    if (!combat) return res.status(404).json({ error: 'No active encounter.' });
    const state = combat.state;
    if (state.outcome) return res.status(409).json({ error: 'This encounter has already ended.' });
    if (state.phase !== 'active') return res.status(409).json({ error: 'Initiative is still being rolled.' });
    if (Number.isInteger(req.body?.version) && req.body.version !== state.version) {
      return res.status(409).json({ error: 'The combat changed. Reloading the latest state.', combat: toPublicCombat(combat, state) });
    }

    const actor = resolveCombatActor(req, state, unit => combatService.isPlayerTurn(state, unit.sourceCharacterId));
    if (actor.error) return res.status(actor.status).json({ error: actor.error });
    if (!combatService.isPlayerTurn(state, actor.unit.sourceCharacterId)) {
      return res.status(403).json({ error: 'It is not that character\'s turn.', combat: toPublicCombat(combat, state) });
    }

    combatIntegration.passTurn(state);
    persistCombatWriteback(state);
    saveCombat(combat, state);
    emitCombatUpdate(sessionId, combat, state);

    let conclusion = null;
    try {
      conclusion = await continueCombat(sessionId, combat, state);
    } catch (error) {
      logger.error('Combat could not continue after a player ended their turn', { sessionId, error: error.message });
    }

    res.json({
      combat: state.outcome ? null : toPublicCombat(combat, state),
      turnAdvanced: true,
      version: state.version,
      outcome: state.outcome || null,
      ...(conclusion || {})
    });
  }));

  /**
   * POST /api/sessions/:id/combat/end
   * GM ends the encounter early. Unlike the old silent stop this resolves the
   * fight properly: outcome 'resolved' plus the same summary + aftermath
   * narration a natural ending produces.
   */
  router.post('/:id/combat/end', requireAdmin, withCombatLock(async (req, res) => {
    const sessionId = req.params.id;
    const combat = getActiveCombat(sessionId);
    if (!combat) return res.status(404).json({ error: 'No active encounter.' });
    const state = combat.state;

    if (!state.outcome) {
      state.outcome = 'resolved';
      if (!Array.isArray(state.log)) state.log = [];
      state.log.push({
        round: Number(state.round) || 1,
        type: 'end',
        text: 'The GM calls the encounter; the fighting stops.'
      });
      if (state.log.length > combatService.MAX_LOG_ENTRIES) {
        state.log.splice(0, state.log.length - combatService.MAX_LOG_ENTRIES);
      }
      state.version = (Number(state.version) || 0) + 1;
    }

    persistCombatWriteback(state);
    saveCombat(combat, state);
    emitCombatUpdate(sessionId, combat, state);

    let conclusion = null;
    try {
      conclusion = await runCombatConclusion(sessionId, state);
    } catch (error) {
      logger.error('GM ended combat but the aftermath narration failed', { sessionId, error: error.message });
    }
    res.json({ success: true, outcome: state.outcome, ...(conclusion || {}) });
  }));

  /** POST /api/sessions/:id/music - GM manual override for the shared YouTube DJ. */
  router.post('/:id/music', requireAdmin, async (req, res) => {
    const sessionId = req.params.id;
    const query = validate.sanitizeString(req.body?.query || '', 180);
    if (!query) return res.status(400).json({ error: 'Enter a song or soundtrack search.' });
    const apiKey = db.prepare("SELECT value FROM settings WHERE key = 'youtube_api_key'").get()?.value || '';
    try {
      const [track] = await searchYoutubeMusic(apiKey, query);
      if (!track) return res.status(404).json({ error: 'No embeddable YouTube result was found.' });
      const music = { ...track, query, mood: 'GM selection', startedAt: new Date().toISOString() };
      db.prepare('UPDATE game_sessions SET music_state = ? WHERE id = ?').run(JSON.stringify(music), sessionId);
      sendToSession(sessionId, 'music_updated', { sessionId, music });
      res.json({ music });
    } catch (error) {
      logger.warn('Manual YouTube DJ selection failed', { sessionId, error: error.message });
      res.status(400).json({ error: error.message });
    }
  });

  router.post('/:id/music/stop', requireAdmin, (req, res) => {
    const sessionId = req.params.id;
    db.prepare("UPDATE game_sessions SET music_state = '{}' WHERE id = ?").run(sessionId);
    sendToSession(sessionId, 'music_updated', { sessionId, music: {} });
    res.json({ success: true });
  });

  /**
   * DELETE /api/sessions/:id
   * Delete session and associated data
   */
  router.delete('/:id', requireAdmin, (req, res) => {
    const sessionId = req.params.id;

    try {
      db.prepare('DELETE FROM pending_actions WHERE session_id = ?').run(sessionId);
      db.prepare('DELETE FROM session_characters WHERE session_id = ?').run(sessionId);
      db.prepare('DELETE FROM combats WHERE session_id = ?').run(sessionId);
      db.prepare('DELETE FROM game_snapshots WHERE session_id = ?').run(sessionId);
      const result = db.prepare('DELETE FROM game_sessions WHERE id = ?').run(sessionId);

      if (result.changes > 0) {
        deleteSessionPOVScenes(sessionId);
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
  router.post('/:id/action', requireUser, async (req, res) => {
    const { character_id, action } = req.body;
    const sessionId = req.params.id;

    if (!character_id) {
      return res.status(400).json({ error: 'character_id is required' });
    }

    if (getActiveCombat(sessionId)) {
      return res.status(409).json({ error: 'A combat encounter is active. Use the combat controls until the encounter ends.' });
    }

    if (processingSessions.has(sessionId)) {
      return res.status(409).json({
        error: 'Turn is currently being processed. Please wait for the Narrator to finish.',
        processing: true
      });
    }

    if (!isCharacterInSession(sessionId, character_id)) {
      return res.status(403).json({ error: 'Character is not part of this session' });
    }

    if (!userOwnsCharacter(req.user, character_id)) {
      return res.status(403).json({ error: 'You do not own this character' });
    }

    const existing = db.prepare('SELECT * FROM pending_actions WHERE session_id = ? AND character_id = ?').get(sessionId, character_id);
    if (existing) {
      db.prepare('UPDATE pending_actions SET action = ? WHERE id = ?').run(action, existing.id);
    } else {
      db.prepare('INSERT INTO pending_actions (id, session_id, character_id, action) VALUES (?, ?, ?, ?)').run(uuidv4(), sessionId, character_id, action);
    }

    const pendingActions = db.prepare('SELECT * FROM pending_actions WHERE session_id = ?').all(sessionId);
    const characters = getSessionCharacters(sessionId);

    sendToSession(sessionId, 'action_submitted', { sessionId, pendingActions, character_id });

    if (pendingActions.length >= characters.length && characters.length > 0) {
      processingSessions.add(sessionId);
      sendToSession(sessionId, 'turn_processing', { sessionId });

      try {
        const result = await processAITurn(sessionId, pendingActions, characters);
        res.json({ processed: true, result });
      } catch (error) {
        console.error('AI processing error:', error);
        sendToSession(sessionId, 'turn_error', { sessionId, error: error.message });
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
  router.delete('/:id/action/:characterId', requireUser, (req, res) => {
    const { id: sessionId, characterId } = req.params;

    if (!userOwnsCharacter(req.user, characterId)) {
      return res.status(403).json({ error: 'You do not own this character' });
    }

    db.prepare('DELETE FROM pending_actions WHERE session_id = ? AND character_id = ?').run(sessionId, characterId);

    const pendingActions = db.prepare('SELECT * FROM pending_actions WHERE session_id = ?').all(sessionId);
    sendToSession(sessionId, 'action_cancelled', { sessionId, pendingActions, character_id: characterId });

    res.json({ success: true, pendingActions });
  });

  /**
   * POST /api/sessions/:id/process
   * Force process turn (DM override)
   */
  router.post('/:id/process', requireAdmin, async (req, res) => {
    const sessionId = req.params.id;

    if (getActiveCombat(sessionId)) {
      return res.status(409).json({ error: 'A combat encounter is active. Resolve it before processing narration.' });
    }

    if (processingSessions.has(sessionId)) {
      return res.status(409).json({ error: 'Turn is already being processed.', processing: true });
    }

    const pendingActions = db.prepare('SELECT * FROM pending_actions WHERE session_id = ?').all(sessionId);
    const characters = getSessionCharacters(sessionId);

    processingSessions.add(sessionId);
    sendToSession(sessionId, 'turn_processing', { sessionId });

    try {
      const result = await processAITurn(sessionId, pendingActions, characters);
      res.json({ success: true, result });
    } catch (error) {
      console.error('AI processing error:', error);
      sendToSession(sessionId, 'turn_error', { sessionId, error: error.message });
      res.status(500).json({ error: error.message });
    } finally {
      processingSessions.delete(sessionId);
    }
  });

  /**
   * POST /api/sessions/:id/gm-message
   * Send hidden GM message (admin only)
   */
  router.post('/:id/gm-message', requireAdmin, (req, res) => {
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
   * POST /api/sessions/:id/regenerate-pov
   * Regenerate one per-character POV on a specific narration entry.
   * Body: { index: <history index>, characterId: <character id> }
   * Admins may reroll any POV; players may only reroll POVs for characters they own.
   */
  router.post('/:id/regenerate-pov', requireUser, async (req, res) => {
    const sessionId = req.params.id;
    const { index, characterId } = req.body || {};
    const correctionNote = validate.sanitizeString(req.body?.correctionNote || '', aiService.POV_CORRECTION_NOTE_MAX_CHARS || 1000);

    if (processingSessions.has(sessionId)) {
      return res.status(409).json({
        error: 'Turn is currently being processed. Please wait for the Narrator to finish.',
        processing: true
      });
    }

    if (typeof index !== 'number' || index < 0) {
      return res.status(400).json({ error: 'Valid history index is required' });
    }
    if (!characterId) {
      return res.status(400).json({ error: 'characterId is required' });
    }

    const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    if (!userCanViewSession(req.user, sessionId)) {
      return res.status(403).json({ error: 'You do not have a character in this session' });
    }

    const history = JSON.parse(session.full_history || '[]');
    if (index >= history.length) {
      return res.status(400).json({ error: 'Index out of range' });
    }
    const entry = history[index];
    if (!entry || entry.role !== 'assistant') {
      return res.status(400).json({ error: 'Target entry is not a narration' });
    }

    const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(characterId);
    if (!character) return res.status(404).json({ error: 'Character not found' });
    if (!isCharacterInSession(sessionId, characterId)) {
      return res.status(400).json({ error: 'Character is not in this session' });
    }
    if (!userOwnsCharacter(req.user, characterId)) {
      return res.status(403).json({ error: 'You can only reroll POVs for characters you own' });
    }

    const apiConfig = getRoleApiConfig('pov');
    if (!apiConfig || !apiConfig.api_key) {
      return res.status(400).json({ error: 'No POV API configuration' });
    }

    const sessionChars = getSessionCharacters(sessionId);
    const partyRoster = aiService.buildPOVPartyRoster
      ? aiService.buildPOVPartyRoster(sessionChars, character)
      : sessionChars.map(c => `- ${c.character_name}, ${c.race} ${c.class}`).join('\n');
    const povCampaignContext = aiService.buildPOVCampaignContext
      ? aiService.buildPOVCampaignContext(history.slice(0, index))
      : '';

    const aiConfig = apiConfig;

    try {
      const pov = await aiService.generateCharacterPOV(
        aiConfig, character, entry.content || '', partyRoster, session.story_summary || '', povCampaignContext, correctionNote
      );
      if (!pov) {
        return res.status(502).json({ error: 'POV generation failed after retry' });
      }

      const latestSession = db.prepare('SELECT full_history FROM game_sessions WHERE id = ?').get(sessionId);
      const latestHistory = JSON.parse(latestSession?.full_history || '[]');
      const latestEntry = latestHistory[index];
      if (!latestEntry || latestEntry.role !== 'assistant') {
        return res.status(409).json({ error: 'Target narration changed while POV was generating. Please reload and try again.' });
      }
      if ((latestEntry.content || '') !== (entry.content || '')) {
        return res.status(409).json({ error: 'Target narration changed while POV was generating. Please reload and try again.' });
      }

      latestEntry.povs = latestEntry.povs || {};
      latestEntry.povs[character.character_name] = pov;
      const oldImageUrl = latestEntry.povImages?.[character.id]?.url;
      if (latestEntry.povImages) delete latestEntry.povImages[character.id];
      latestHistory[index] = latestEntry;
      db.prepare('UPDATE game_sessions SET full_history = ? WHERE id = ?')
        .run(JSON.stringify(latestHistory), sessionId);
      if (oldImageUrl) deletePOVSceneImage(oldImageUrl);

      sendToSession(sessionId, 'session_updated', { id: sessionId });
      console.log(`Regenerated POV for ${character.character_name} on session ${sessionId} index ${index}`);
      res.json({ success: true, characterName: character.character_name, povLength: pov.length });
    } catch (err) {
      console.error('regenerate-pov error:', err);
      res.status(500).json({ error: 'Failed to regenerate POV: ' + err.message });
    }
  });

  /**
   * POST /api/sessions/:id/generate-pov-image
   * Illustrate one POV using that character's uploaded avatar as the likeness reference.
   * Players may only generate images for characters they own; admins may generate any.
   */
  router.post('/:id/generate-pov-image', requireUser, async (req, res) => {
    const sessionId = req.params.id;
    const { index, characterId } = req.body || {};
    if (!Number.isInteger(index) || index < 0) return res.status(400).json({ error: 'Valid history index is required' });
    if (!characterId) return res.status(400).json({ error: 'characterId is required' });

    const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (!userCanViewSession(req.user, sessionId)) return res.status(403).json({ error: 'You do not have a character in this session' });
    if (!isCharacterInSession(sessionId, characterId)) return res.status(400).json({ error: 'Character is not in this session' });
    if (!userOwnsCharacter(req.user, characterId)) return res.status(403).json({ error: 'You can only illustrate POVs for characters you own' });

    const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(characterId);
    if (!character) return res.status(404).json({ error: 'Character not found' });
    const history = JSON.parse(session.full_history || '[]');
    const entry = history[index];
    if (!entry || entry.role !== 'assistant') return res.status(400).json({ error: 'Target entry is not a narration' });
    const povContent = entry.povs?.[character.character_name] || entry.content || '';
    if (!povContent.trim()) return res.status(400).json({ error: 'This POV has no narration to illustrate' });

    const settings = loadPOVImageSettings(db);
    if (settings.pov_image_enabled !== 'true') return res.status(400).json({ error: 'POV scene images are disabled in Admin Settings' });
    if (!settings.pov_image_endpoint || !settings.pov_image_api_key || !settings.pov_image_model) {
      return res.status(400).json({ error: 'POV image generation is not fully configured in Admin Settings' });
    }

    const aiConfig = getRoleApiConfig('agent');
    if (!aiConfig?.api_key) return res.status(400).json({ error: 'No agent API configuration' });
    const job = queuePOVSceneGeneration({
      db,
      aiService,
      sessionId,
      index,
      character,
      aiConfig,
      settings
    });
    if (!job.started) return res.status(409).json({ error: 'This POV image is already being generated' });
    try {
      const image = await job.promise;
      sendToSession(sessionId, 'session_updated', { id: sessionId, reason: 'pov_image' });
      res.json({ success: true, image });
    } catch (error) {
      logger.error('POV scene image generation failed', { sessionId, characterId, error: error.message });
      const status = error.message.startsWith('The POV changed') ? 409 : 502;
      res.status(status).json({ error: 'POV scene image generation failed: ' + error.message });
    }
  });

  /**
   * POST /api/sessions/:id/generate-choices
   * Generate choices on demand for the current scene
   */
  router.post('/:id/generate-choices', requireUser, async (req, res) => {
    const sessionId = req.params.id;
    const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    if (!userCanViewSession(req.user, sessionId)) {
      return res.status(403).json({ error: 'You do not have a character in this session' });
    }

    const rawConfig = getRoleApiConfig('agent');
    if (!rawConfig) return res.status(400).json({ error: 'No active API configuration' });
    const config = rawConfig;

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
      { role: 'system', content: `You are a D&D 5e Dungeon Master. Read the current scene carefully and generate IMMEDIATE NEXT ACTIONS the characters can take RIGHT NOW.

Characters in the party: ${charDetails}

Format: [CHOICE: CharacterName | STAT | DIFFICULTY | Short action description]
- STAT = STR, DEX, CON, INT, WIS, CHA
- DIFFICULTY = EASY, MEDIUM, or HARD
- "ALL" for actions any character can take (limit to 1-2)

RULES:
- Choices must DIRECTLY respond to what's happening in the scene
- Reference specific NPCs, objects, threats, or opportunities from the narration
- Tailor choices to each character's class — fighters get physical options, rogues get stealth/cunning, casters get magical solutions
- NEVER give generic choices like "look around" or "explore"
- Mix difficulties — include at least one HARD risky option
- 2-4 choices per character
- Output ONLY the [CHOICE: ...] tags, nothing else` },
      { role: 'user', content: `Current scene:\n\n${(() => {
        // Use POV content if available (richer scene detail), otherwise fall back to content
        if (lastNarration.povs && Object.keys(lastNarration.povs).length > 0) {
          return Object.entries(lastNarration.povs).map(([name, pov]) => `[${name}'s perspective]: ${pov}`).join('\n\n');
        }
        return lastNarration.content;
      })().substring(0, 4000)}\n\nGenerate focused, scene-specific choices for: ${charNames}` }
    ];

    try {
      const data = await aiService.callAI(config, choicePrompt, { maxTokens: 1024, temperature: 0.9 });
      const responseText = aiService.extractAIMessage(data) || '';
      console.log('Generate choices raw response:', responseText.substring(0, 500));
      const choices = tagParser.parseChoices(responseText, characters);
      console.log(`Parsed ${choices.length} choices from response`);
      if (choices.length > 0) {
        sendToSession(sessionId, 'choices_generated', { sessionId, choices });
      }
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
  router.post('/:id/reroll', requireAdmin, async (req, res) => {
    const sessionId = req.params.id;

    if (getActiveCombat(sessionId)) {
      return res.status(409).json({ error: 'A combat encounter is active. Resolve it before rerolling narration.' });
    }

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
    const removedTurnEntries = fullHistory.slice(turnStartIdx);
    fullHistory = fullHistory.slice(0, turnStartIdx);

    // Adjust compacted_count if we truncated into the compacted region
    let compactedCount = session.compacted_count || 0;
    const originalCompactedCount = compactedCount;
    if (fullHistory.length < compactedCount) {
      compactedCount = fullHistory.length;
    }

    db.prepare('UPDATE game_sessions SET full_history = ?, compacted_count = ? WHERE id = ?')
      .run(JSON.stringify(fullHistory), compactedCount, sessionId);
    removedTurnEntries.forEach(deleteEntryPOVImages);

    if (compactedCount !== originalCompactedCount) {
      console.log(`Reroll: Adjusted compacted_count from ${originalCompactedCount} to ${compactedCount}`);
    }

    // Restore character states from the most recent snapshot (fixes double stat changes on reroll)
    try {
      const snapshot = db.prepare('SELECT * FROM game_snapshots WHERE session_id = ? ORDER BY turn_number DESC LIMIT 1').get(sessionId);
      if (snapshot) {
        const states = JSON.parse(snapshot.character_states);
        for (const state of states) {
          db.prepare('UPDATE characters SET hp = ?, xp = ?, gold = ?, inventory = ?, spell_slots = ?, ac = ?, ac_effects = ?, inspiration_points = COALESCE(?, inspiration_points) WHERE id = ?')
            .run(state.hp, state.xp, state.gold, state.inventory, state.spell_slots, state.ac, state.ac_effects, state.inspiration_points ?? null, state.id);
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
    sendToSession(sessionId, 'reroll_started', { sessionId });

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
  router.post('/:id/auto-reply', requireUser, async (req, res) => {
    const sessionId = req.params.id;
    const { character_id, context } = req.body;

    if (getActiveCombat(sessionId)) {
      return res.status(409).json({ error: 'A combat encounter is active. Use the combat controls instead.' });
    }

    if (processingSessions.has(sessionId)) {
      return res.status(409).json({
        error: 'Turn is currently being processed. Please wait for the Narrator to finish.',
        processing: true
      });
    }

    if (!character_id) {
      return res.status(400).json({ error: 'Character ID is required' });
    }

    if (!userOwnsCharacter(req.user, character_id)) {
      return res.status(403).json({ error: 'You do not own this character' });
    }

    const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(character_id);
    if (!character) {
      return res.status(404).json({ error: 'Character not found' });
    }

    if (!isCharacterInSession(sessionId, character_id)) {
      return res.status(403).json({ error: 'Character is not part of this session' });
    }

    const storySummary = session.story_summary || '';

    const fullHistory = JSON.parse(session.full_history || '[]');
    const visibleHistory = fullHistory.filter(m => !m.hidden && m.type !== 'context');
    const recentHistory = visibleHistory.slice(-30);

    const lastDMMessageRaw = [...recentHistory].reverse().find(m => m.role === 'assistant');
    // For auto-reply, prefer the character's POV (richer context) over stripped content
    const lastDMMessage = lastDMMessageRaw ? {
      ...lastDMMessageRaw,
      content: (lastDMMessageRaw.povs && lastDMMessageRaw.povs[character.character_name])
        ? lastDMMessageRaw.povs[character.character_name]
        : lastDMMessageRaw.content
    } : null;

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
      const rawConfig = getRoleApiConfig('agent');
      if (!rawConfig) {
        return res.status(500).json({ error: 'No active API configuration' });
      }
      const config = rawConfig;

      const aiData = await aiService.callAI(config, [{ role: 'user', content: prompt }], { maxTokens: 300, temperature: 0.7 });
      const generatedAction = (aiService.extractAIMessage(aiData) || '').trim();

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

      sendToSession(sessionId, 'action_submitted', { sessionId, pendingActions, character_id });

      if (pendingActions.length >= characters.length && characters.length > 0) {
        processingSessions.add(sessionId);
        sendToSession(sessionId, 'turn_processing', { sessionId });

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
  router.get('/:id/summary', requireAdmin, (req, res) => {
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
  router.post('/:id/summary', requireAdmin, (req, res) => {
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
  router.post('/:id/force-compact', requireAdmin, async (req, res) => {
    const sessionId = req.params.id;
    const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const apiConfig = getRoleApiConfig('agent');
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

      sendToSession(sessionId, 'session_compacted', { sessionId, compactedCount: fullHistory.length });

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
  router.post('/:id/delete-message', requireAdmin, (req, res) => {
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
      deleteEntryPOVImages(deletedMessage);

      sendToSession(sessionId, 'session_updated', { id: sessionId });

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
  router.post('/:id/recalculate-xp', requireAdmin, (req, res) => {
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
        const scanText = `${entry.content || ''}\n${entry.stateTags || ''}`;
        const xpMatches = scanText.match(/\[XP:\s*([^\]]+)\]/gi);
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
      sendToSession(sessionId, 'character_updated', char);
    }

    res.json({ success: true, xpAwarded });
  });

  /**
   * POST /api/sessions/:id/recalculate-loot
   * Scan history for gold and items
   */
  router.post('/:id/recalculate-loot', requireAdmin, (req, res) => {
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
        const scanText = `${entry.content || ''}\n${entry.stateTags || ''}`;
        const goldMatches = scanText.match(/\[(MONEY|GOLD):([^\]]+)\]/gi);
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

        const itemMatches = scanText.match(/\[ITEM:([^\]]+)\]/gi);
        if (itemMatches) {
          for (const match of itemMatches) {
            const itemAwards = match.replace(/\[ITEM:/i, '').replace(']', '').split(',');
            for (const award of itemAwards) {
              const itemMatch = award.trim().match(/(.+?)\s+([+-])\s*(.+)/);
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
      sendToSession(sessionId, 'character_updated', char);
    }

    res.json({ success: true, goldAwarded, inventoryChanges });
  });

  /**
   * POST /api/sessions/:id/recalculate-inventory
   * Recalculate inventory only from session history
   */
  router.post('/:id/recalculate-inventory', requireAdmin, (req, res) => {
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
        const scanText = `${entry.content || ''}\n${entry.stateTags || ''}`;
        const itemMatches = scanText.match(/\[ITEM:([^\]]+)\]/gi);
        if (itemMatches) {
          for (const match of itemMatches) {
            const itemAwards = match.replace(/\[ITEM:/i, '').replace(']', '').split(',');
            for (const award of itemAwards) {
              const itemMatch = award.trim().match(/(.+?)\s+([+-])\s*(.+)/);
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
      sendToSession(sessionId, 'character_updated', char);
    }

    res.json({ success: true, inventoryChanges });
  });

  /**
   * POST /api/sessions/:id/recalculate-ac-spells
   * Recalculate AC and spell slots from session history
   */
  router.post('/:id/recalculate-ac-spells', requireAdmin, (req, res) => {
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
      const content = `${entry.content || ''}\n${entry.stateTags || ''}`;

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
      sendToSession(sessionId, 'character_updated', char);
    }

    res.json({ success: true, ...results });
  });

  /**
   * POST /api/sessions/:id/add-character
   * Add a character to the session
   */
  router.post('/:id/add-character', requireAdmin, (req, res) => {
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
    sendToSession(sessionId, 'session_updated', { id: sessionId });

    console.log(`Character ${character.character_name} added to session ${session.name}`);
    res.json({ success: true, sessionCharacters: sessionChars });
  });

  /**
   * POST /api/sessions/:id/remove-character
   * Remove a character from the session
   */
  router.post('/:id/remove-character', requireAdmin, (req, res) => {
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
    sendToSession(sessionId, 'session_updated', { id: sessionId });

    console.log(`Character ${characterId} removed from session ${session.name}`);
    res.json({ success: true, sessionCharacters: sessionChars });
  });

  return router;
}

module.exports = { createSessionRoutes };
