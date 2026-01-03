/**
 * Routes Index
 * Exports all route factories for easy integration
 */

const { createAuthRoutes } = require('./auth');
const { createCharacterRoutes } = require('./characters');
const { createCombatRoutes } = require('./combat');
const { createApiConfigRoutes } = require('./apiConfig');
const { createSessionRoutes } = require('./sessions');
const { createTTSRoutes } = require('./tts');

/**
 * Initialize all routes with dependencies
 * @param {Object} deps - Dependencies object
 * @returns {Object} Object containing all route handlers
 */
function initializeRoutes(deps) {
  const { db, io, auth, authLimiter, aiService, processingSessions, getActiveApiConfig, processAITurn, DEFAULT_SYSTEM_PROMPT, getOpenAIApiKey } = deps;

  return {
    auth: createAuthRoutes(db, auth, authLimiter),
    characters: createCharacterRoutes({ db, io, auth, aiService, getActiveApiConfig }),
    combat: createCombatRoutes(db, io, auth),
    apiConfig: createApiConfigRoutes(db, auth),
    sessions: createSessionRoutes({
      db, io, auth, aiService,
      processingSessions,
      getActiveApiConfig,
      processAITurn,
      DEFAULT_SYSTEM_PROMPT
    }),
    tts: createTTSRoutes({ db, auth, getOpenAIApiKey })
  };
}

module.exports = {
  initializeRoutes,
  createAuthRoutes,
  createCharacterRoutes,
  createCombatRoutes,
  createApiConfigRoutes,
  createSessionRoutes,
  createTTSRoutes
};
