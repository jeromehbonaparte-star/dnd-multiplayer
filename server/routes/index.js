/**
 * Routes Index
 * Exports all route factories for easy integration
 */

const { createAuthRoutes } = require('./auth');
const { createCharacterRoutes } = require('./characters');
const { createApiConfigRoutes } = require('./apiConfig');
const { createSessionRoutes } = require('./sessions');
const { createTTSRoutes } = require('./tts');
const { createDndDataRoutes } = require('./dndData');

/**
 * Initialize all routes with dependencies
 * @param {Object} deps - Dependencies object
 * @returns {Object} Object containing all route handlers
 */
function initializeRoutes(deps) {
  const {
    db, io, auth, authLimiter, aiService,
    processingSessions, getActiveApiConfig, processAITurn,
    DEFAULT_SYSTEM_PROMPT, getOpenAIApiKey,
    parseAcEffects, calculateTotalAC, updateCharacterAC,
    compactHistory, AI_RESPONSE_PREFIX, getSessionCharacters
  } = deps;

  return {
    auth: createAuthRoutes(db, auth, authLimiter),
    characters: createCharacterRoutes({ db, io, auth, aiService, getActiveApiConfig }),
    apiConfig: createApiConfigRoutes(db, auth),
    sessions: createSessionRoutes({
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
      getSessionCharacters
    }),
    tts: createTTSRoutes({ db, auth, getOpenAIApiKey }),
    dndData: createDndDataRoutes(db, auth)
  };
}

module.exports = {
  initializeRoutes,
  createAuthRoutes,
  createCharacterRoutes,
  createApiConfigRoutes,
  createSessionRoutes,
  createTTSRoutes,
  createDndDataRoutes
};
