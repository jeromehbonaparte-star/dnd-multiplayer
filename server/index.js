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

// Static SRD data self-check — a broken class/subclass data file must never
// reach the level-up engine, so fail fast before anything else boots.
const { validateClassData } = require('./services/classProgressionService');
validateClassData();

// Import database (runs all migrations on load)
const { db } = require('./config/database');

// Import services
const aiService = require('./services/aiService');
const { formatAIConfig, getApiConfigForRole: resolveApiConfigForRole } = require('./services/aiConfigService');
const tagParser = require('./services/tagParser');
const { parseAcEffects, calculateTotalAC, updateCharacterAC, getSessionCharacters } = require('./services/characterService');
const { applyAllTags } = require('./services/tagApplicator');
const {
  processAITurn: processAITurnCore,
  streamAITurn: streamAITurnCore,
  completeCombatTurn: completeCombatTurnCore,
  compactHistory,
  estimateTokens,
  didTurnCommit
} = require('./services/turnProcessor');

// Import auth middleware factory
const { createAuthHelpers, parseCookie, SESSION_COOKIE } = require('./middleware/auth');

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
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(origin => origin.trim()).filter(Boolean)
  : [];
app.use(corsMiddleware(allowedOrigins));
app.use(express.static(path.join(__dirname, '../public')));
app.use('/uploads', express.static(path.join(__dirname, '../data/uploads')));

// ============================================
// Auth
// ============================================
const auth = createAuthHelpers(db);

const SESSION_ROOM_PREFIX = 'session:';
function getSessionRoom(sessionId) {
  return `${SESSION_ROOM_PREFIX}${sessionId}`;
}

function emitToSession(sessionId, event, payload) {
  io.to(getSessionRoom(sessionId)).emit(event, payload);
}

// ============================================
// Identity rooms + scoped character broadcasts
// ============================================
// Every socket joins its own user room (and, for admins, the shared admin room)
// on connect. Character-scoped events are delivered only to the union of the
// character's session rooms, its owner's room, and the admin room — never a
// global io.emit, which would leak one player's HP/gold/inventory/backstory to
// every connected client regardless of session.
const USER_ROOM_PREFIX = 'user:';
const ADMIN_ROOM = 'admins';
function getUserRoom(userId) {
  return `${USER_ROOM_PREFIX}${userId}`;
}

function characterBroadcastRooms(characterId) {
  const rooms = new Set([ADMIN_ROOM]);
  const owner = db.prepare('SELECT user_id FROM characters WHERE id = ?').get(characterId);
  if (owner && owner.user_id != null) rooms.add(getUserRoom(owner.user_id));
  const sessionRows = db.prepare('SELECT session_id FROM session_characters WHERE character_id = ?').all(characterId);
  for (const row of sessionRows) rooms.add(getSessionRoom(row.session_id));
  return [...rooms];
}

// Emit a character-scoped event to exactly the clients entitled to see it.
// For delete, call this BEFORE removing the row so the owner/session lookup resolves.
function emitCharacterUpdate(characterId, event, payload) {
  io.to(characterBroadcastRooms(characterId)).emit(event, payload);
}

function emitToUser(userId, event, payload) {
  if (userId == null) return;
  io.to(getUserRoom(userId)).emit(event, payload);
}

// ============================================
// Helper: Get active API config (formatted for routes)
// ============================================
function getActiveApiConfig() {
  const config = db.prepare('SELECT * FROM api_configs WHERE is_active = 1').get();
  return formatAIConfig(config);
}

function getApiConfigForRole(role) {
  return resolveApiConfigForRole(db, role);
}

// ============================================
// Helper: Wrap processAITurn with deps
// ============================================
const turnDeps = {
  db, io, aiService, tagParser,
  getActiveApiConfig,
  getApiConfigForRole,
  DEFAULT_SYSTEM_PROMPT: aiService.DEFAULT_SYSTEM_PROMPT,
  processingSessions,
  parseAcEffects, calculateTotalAC, updateCharacterAC,
  emitToSession,
  emitCharacterUpdate,
  applyAllTags
};

function processAITurn(sessionId, pendingActions, characters) {
  const before = turnDeps.db.prepare('SELECT current_turn, full_history FROM game_sessions WHERE id = ?').get(sessionId);
  // Use streaming by default, fall back to non-streaming only if stream fails BEFORE any state mutation
  return streamAITurnCore(turnDeps, sessionId, pendingActions, characters)
    .catch(streamError => {
      // Only safe to fallback if the error is a connection/setup error (before history was mutated)
      // Check if history was already modified by re-reading session
      const session = turnDeps.db.prepare('SELECT current_turn, full_history, total_tokens FROM game_sessions WHERE id = ?').get(sessionId);
      const history = JSON.parse(session?.full_history || '[]');
      const lastEntry = history[history.length - 1];
      const activeCombat = turnDeps.db.prepare('SELECT * FROM combats WHERE session_id = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 1').get(sessionId);
      if (activeCombat) {
        logger.error('Post-handoff work failed after tactical combat started', { sessionId, error: streamError.message });
        return {
          response: '',
          tokensUsed: Number(session?.total_tokens || 0),
          combat: { ...activeCombat, state: JSON.parse(activeCombat.combatants || '{}') },
          deferredNarration: true,
          degraded: true
        };
      }
      if (didTurnCommit(before, session)) {
        // The turn is already committed; optional failures must not trigger a reroll.
        logger.error('Post-turn work failed after narration was committed', { sessionId, error: streamError.message });
        return {
          response: lastEntry?.content || '',
          tokensUsed: Number(session?.total_tokens || 0),
          degraded: true
        };
      }
      console.warn('Streaming failed before processing, falling back to non-streaming:', streamError.message);
      return processAITurnCore(turnDeps, sessionId, pendingActions, characters);
    });
}

function completeCombatTurn(sessionId, characters, combatConclusion) {
  const before = turnDeps.db.prepare('SELECT current_turn, full_history FROM game_sessions WHERE id = ?').get(sessionId);
  return completeCombatTurnCore(turnDeps, sessionId, characters, combatConclusion, { stream: true })
    .catch(streamError => {
      const session = turnDeps.db.prepare('SELECT current_turn, full_history, total_tokens FROM game_sessions WHERE id = ?').get(sessionId);
      const history = JSON.parse(session?.full_history || '[]');
      const lastEntry = history[history.length - 1];
      if (didTurnCommit(before, session)) {
        logger.error('Post-combat work failed after narration was committed', { sessionId, error: streamError.message });
        return {
          response: lastEntry?.content || '',
          tokensUsed: Number(session?.total_tokens || 0),
          degraded: true
        };
      }
      logger.warn('Streaming combat conclusion failed; retrying without streaming', { sessionId, error: streamError.message });
      return completeCombatTurnCore(turnDeps, sessionId, characters, combatConclusion, { stream: false });
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
  emitToSession,
  emitCharacterUpdate,
  emitToUser,
  processingSessions,
  getActiveApiConfig,
  getApiConfigForRole,
  processAITurn,
  completeCombatTurn,
  DEFAULT_SYSTEM_PROMPT: aiService.DEFAULT_SYSTEM_PROMPT,
  getOpenAIApiKey,
  parseAcEffects, calculateTotalAC, updateCharacterAC,
  compactHistory,
  getSessionCharacters
});

app.use('/api', routes.auth);
app.use('/api/characters', routes.characters);
app.use('/api/api-configs', routes.apiConfig);
app.use('/api/sessions', routes.sessions);
app.use('/api/tts', routes.tts);
app.use('/api/dnd', routes.dndData);
app.use('/api/admin', routes.adminUsers);

// Global error handler (must be last middleware)
app.use(errorHandler);

// ============================================
// Socket.IO
// ============================================
function userCanViewSessionSocket(user, sessionId) {
  if (user.is_admin) return true;
  const row = db.prepare(`
    SELECT 1 FROM session_characters sc
    JOIN characters c ON c.id = sc.character_id
    WHERE sc.session_id = ? AND c.user_id = ?
    LIMIT 1
  `).get(sessionId, user.id);
  return !!row;
}

io.use((socket, next) => {
  const cookieHeader = socket.handshake.headers.cookie || '';
  const token = parseCookie(cookieHeader, SESSION_COOKIE);
  const loaded = token ? auth.loadUserByToken(token) : null;
  if (!loaded) return next(new Error('authentication required'));
  // Extend DB expiry if near end of window. HTTP routes emit a Set-Cookie to
  // refresh the browser cookie too, which will happen on the next XHR.
  try { auth.maybeRefreshDb(token, loaded.expires_at); } catch (e) { /* best-effort */ }
  socket.data.user = loaded.user;
  next();
});

io.on('connection', (socket) => {
  logger.debug('Client connected', { socketId: socket.id, userId: socket.data.user?.id });

  // Join identity rooms so character-scoped broadcasts can reach this client
  // even when it is not currently viewing a session (e.g. the Characters tab).
  const connectedUser = socket.data.user;
  if (connectedUser) {
    socket.join(getUserRoom(connectedUser.id));
    if (connectedUser.is_admin) socket.join(ADMIN_ROOM);
  }

  socket.on('join_session', ({ sessionId } = {}) => {
    if (!sessionId) return;
    const user = socket.data.user;
    if (!user || !userCanViewSessionSocket(user, sessionId)) {
      logger.warn('Socket join_session rejected', { socketId: socket.id, userId: user?.id, sessionId });
      return;
    }
    socket.join(getSessionRoom(sessionId));
    logger.debug('Socket joined session room', { socketId: socket.id, sessionId });
  });

  socket.on('leave_session', ({ sessionId } = {}) => {
    if (!sessionId) return;
    socket.leave(getSessionRoom(sessionId));
    logger.debug('Socket left session room', { socketId: socket.id, sessionId });
  });

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
