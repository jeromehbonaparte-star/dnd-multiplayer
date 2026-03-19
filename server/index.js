require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
// Rate limiting removed — EasyPanel basic auth handles access control

// Import modular utilities
const logger = require('./lib/logger');
const { securityHeaders, corsMiddleware } = require('./middleware/security');
const { errorHandler } = require('./middleware/errorHandler');

// Import database (runs all migrations on load)
const { db } = require('./config/database');

// Import services
const aiService = require('./services/aiService');
const tagParser = require('./services/tagParser');
const { parseAcEffects, calculateTotalAC, updateCharacterAC, getSessionCharacters } = require('./services/characterService');
const { applyAllTags } = require('./services/tagApplicator');
const { processAITurn: processAITurnCore, streamAITurn: streamAITurnCore, compactHistory, estimateTokens } = require('./services/turnProcessor');

// Import auth middleware factory
const { createAuthMiddleware } = require('./middleware/auth');

// Import route initializer
const { initializeRoutes } = require('./routes');

// ============================================
// App & Server Setup
// ============================================
const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server);

// Track sessions currently being processed by AI (prevents race conditions)
const processingSessions = new Set();

// ============================================
// Middleware
// ============================================

// HTTP Basic Auth — credentials from BASIC_AUTH_USER / BASIC_AUTH_PASS env vars
const basicUser = process.env.BASIC_AUTH_USER;
const basicPass = process.env.BASIC_AUTH_PASS;
if (basicUser && basicPass) {
  app.use((req, res, next) => {
    // Skip auth for socket.io polling
    if (req.path.startsWith('/socket.io')) return next();

    const header = req.headers.authorization;
    if (header) {
      const [scheme, encoded] = header.split(' ');
      if (scheme === 'Basic' && encoded) {
        const [user, pass] = Buffer.from(encoded, 'base64').toString().split(':');
        if (user === basicUser && pass === basicPass) return next();
      }
    }
    res.setHeader('WWW-Authenticate', 'Basic realm="D&D Multiplayer"');
    res.status(401).send('Authentication required');
  });
} else {
  logger.warn('BASIC_AUTH_USER / BASIC_AUTH_PASS not set — no login required!');
}

app.use(express.json({ limit: '1mb' }));
app.use(securityHeaders);
const allowedOrigins = process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : [];
app.use(corsMiddleware(allowedOrigins));
app.use(express.static(path.join(__dirname, '../public')));
app.use('/uploads', express.static(path.join(__dirname, '../data/uploads')));

// ============================================
// Auth
// ============================================
const { checkPassword, checkAdminPassword } = createAuthMiddleware(db);
const auth = { checkPassword, checkAdminPassword };

// ============================================
// Helper: Get active API config (formatted for routes)
// ============================================
function getActiveApiConfig() {
  const config = db.prepare('SELECT * FROM api_configs WHERE is_active = 1').get();
  if (config) {
    return {
      api_endpoint: config.endpoint,
      api_key: config.api_key,
      api_model: config.model
    };
  }
  return null;
}

// ============================================
// Helper: Wrap processAITurn with deps
// ============================================
const turnDeps = {
  db, io, aiService, tagParser,
  getActiveApiConfig,
  DEFAULT_SYSTEM_PROMPT: aiService.DEFAULT_SYSTEM_PROMPT,
  AI_RESPONSE_PREFIX: aiService.AI_RESPONSE_PREFIX,
  processingSessions,
  parseAcEffects, calculateTotalAC, updateCharacterAC,
  applyAllTags
};

function processAITurn(sessionId, pendingActions, characters) {
  // Use streaming by default, fall back to non-streaming only if stream fails BEFORE any state mutation
  return streamAITurnCore(turnDeps, sessionId, pendingActions, characters)
    .catch(streamError => {
      // Only safe to fallback if the error is a connection/setup error (before history was mutated)
      // Check if history was already modified by re-reading session
      const session = turnDeps.db.prepare('SELECT full_history FROM game_sessions WHERE id = ?').get(sessionId);
      const history = JSON.parse(session?.full_history || '[]');
      const lastEntry = history[history.length - 1];
      if (lastEntry && lastEntry.type === 'narration') {
        // Stream already wrote a narration — don't double-process
        throw new Error('Streaming failed after partial processing: ' + streamError.message);
      }
      console.warn('Streaming failed before processing, falling back to non-streaming:', streamError.message);
      return processAITurnCore(turnDeps, sessionId, pendingActions, characters);
    });
}

// ============================================
// Helper: Get OpenAI API key
// ============================================
function getOpenAIApiKey() {
  return aiService.getOpenAIApiKey(db);
}

// ============================================
// Routes
// ============================================
const routes = initializeRoutes({
  db, io, auth, authLimiter: null, aiService,
  processingSessions,
  getActiveApiConfig,
  processAITurn,
  DEFAULT_SYSTEM_PROMPT: aiService.DEFAULT_SYSTEM_PROMPT,
  getOpenAIApiKey,
  parseAcEffects, calculateTotalAC, updateCharacterAC,
  compactHistory,
  AI_RESPONSE_PREFIX: aiService.AI_RESPONSE_PREFIX,
  getSessionCharacters
});

app.use('/api', routes.auth);
app.use('/api/characters', routes.characters);
app.use('/api/api-configs', routes.apiConfig);
app.use('/api/sessions', routes.sessions);
app.use('/api/tts', routes.tts);
app.use('/api/dnd', routes.dndData);

// Global error handler (must be last middleware)
app.use(errorHandler);

// ============================================
// Socket.IO
// ============================================
io.on('connection', (socket) => {
  logger.debug('Client connected', { socketId: socket.id });
  socket.on('disconnect', () => {
    logger.debug('Client disconnected', { socketId: socket.id });
  });
});

// ============================================
// Start Server
// ============================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  logger.info(`D&D Multiplayer server running on port ${PORT}`);
});
