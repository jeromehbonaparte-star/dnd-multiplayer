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
const { createAdminUserRoutes } = require('./adminUsers');

/**
 * Initialize all routes with dependencies
 */
function initializeRoutes(deps) {
  const {
    db, io, auth, aiService, emitToSession,
    emitCharacterUpdate, emitToUser,
    processingSessions, getActiveApiConfig, getApiConfigForRole, processAITurn,
    DEFAULT_SYSTEM_PROMPT, getOpenAIApiKey,
    parseAcEffects, calculateTotalAC, updateCharacterAC,
    compactHistory, getSessionCharacters
  } = deps;

  return {
    auth: createAuthRoutes(db, auth),
    characters: createCharacterRoutes({ db, io, auth, aiService, getActiveApiConfig, getApiConfigForRole, emitCharacterUpdate }),
    apiConfig: createApiConfigRoutes(db, auth),
    sessions: createSessionRoutes({
      db, io, auth, aiService, emitToSession,
      processingSessions,
      getActiveApiConfig,
      getApiConfigForRole,
      processAITurn,
      DEFAULT_SYSTEM_PROMPT,
      parseAcEffects,
      calculateTotalAC,
      updateCharacterAC,
      compactHistory,
      getSessionCharacters
    }),
    tts: createTTSRoutes({ db, auth, getOpenAIApiKey }),
    dndData: createDndDataRoutes(db, auth),
    adminUsers: createAdminUserRoutes(db, auth, io, { emitCharacterUpdate, emitToUser })
  };
}

module.exports = {
  initializeRoutes,
  createAuthRoutes,
  createCharacterRoutes,
  createApiConfigRoutes,
  createSessionRoutes,
  createTTSRoutes,
  createDndDataRoutes,
  createAdminUserRoutes
};
