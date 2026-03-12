require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const rateLimit = require('express-rate-limit');

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
// Rate Limiting
// ============================================
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts, please try again after 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please slow down' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ============================================
// Middleware
// ============================================
app.use(express.json({ limit: '1mb' }));
app.use(securityHeaders);
const allowedOrigins = process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : [];
app.use(corsMiddleware(allowedOrigins));
app.use(express.static(path.join(__dirname, '../public')));

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
  // Use streaming by default, fall back to non-streaming on error
  return streamAITurnCore(turnDeps, sessionId, pendingActions, characters)
    .catch(streamError => {
      console.warn('Streaming failed, falling back to non-streaming:', streamError.message);
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
app.use('/api/', apiLimiter);

const routes = initializeRoutes({
  db, io, auth, authLimiter, aiService,
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
app.use('/api/sessions', routes.combat);
app.use('/api/api-configs', routes.apiConfig);
app.use('/api/sessions', routes.sessions);
app.use('/api/tts', routes.tts);

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
