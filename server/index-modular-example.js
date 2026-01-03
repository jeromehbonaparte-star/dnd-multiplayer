/**
 * D&D Multiplayer - Modular Architecture Example
 *
 * This file demonstrates how to fully integrate all modular components.
 * Use this as a reference for migrating the main index.js to a cleaner architecture.
 *
 * To test: Copy relevant sections to index.js or rename this file to index.js
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const rateLimit = require('express-rate-limit');

// ============================================
// MODULAR IMPORTS
// ============================================

// Config
const { db } = require('./config/database');

// Utilities
const logger = require('./lib/logger');
const { validateBody, schemas } = require('./lib/validation');
const { securityHeaders, corsMiddleware } = require('./middleware/security');

// Services
const aiService = require('./services/aiService');
const tagParser = require('./services/tagParser');

// Middleware
const { createAuthMiddleware } = require('./middleware/auth');

// Routes
const {
  createAuthRoutes,
  createCharacterRoutes,
  createCombatRoutes,
  createApiConfigRoutes
} = require('./routes');

// ============================================
// APP SETUP
// ============================================

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Track sessions currently being processed by AI (prevents race conditions)
const processingSessions = new Set();

// ============================================
// RATE LIMITING
// ============================================

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: { error: 'Too many login attempts, please try again after 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100,
  message: { error: 'Too many requests, please slow down' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ============================================
// MIDDLEWARE
// ============================================

app.use(express.json({ limit: '1mb' }));
app.use(securityHeaders);

const allowedOrigins = process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : [];
app.use(corsMiddleware(allowedOrigins));

app.use(express.static(path.join(__dirname, '../public')));

// Create auth middleware
const auth = createAuthMiddleware(db);

// ============================================
// ROUTES - MODULAR
// ============================================

// Apply general rate limiting to all API routes
app.use('/api/', apiLimiter);

// Mount modular routes
app.use('/api', createAuthRoutes(db, auth, authLimiter));
app.use('/api/characters', createCharacterRoutes(db, io, auth, aiService));
app.use('/api/sessions', createCombatRoutes(db, io, auth));  // Combat routes are under /sessions/:id/combat
app.use('/api/api-configs', createApiConfigRoutes(db, auth));

// ============================================
// ADDITIONAL ROUTES (Not yet modularized)
// ============================================

// Session routes would go here
// AI character creation routes would go here
// etc.

// Example of how to use tagParser in session routes:
/*
app.post('/api/sessions/:id/process', auth.checkPassword, async (req, res) => {
  // ... process turn logic ...

  // Parse AI response for tracking tags
  const parsed = tagParser.parseAllTags(aiResponse, characters);

  // Apply XP awards
  for (const award of parsed.xp) {
    db.prepare('UPDATE characters SET xp = xp + ? WHERE id = ?').run(award.amount, award.characterId);
  }

  // Apply HP changes
  for (const change of parsed.hp) {
    const char = characters.find(c => c.id === change.characterId);
    const newHp = tagParser.calculateNewHP(char, change.operator, change.value);
    db.prepare('UPDATE characters SET hp = ? WHERE id = ?').run(newHp, change.characterId);
  }

  // Apply item changes
  for (const change of parsed.items) {
    const char = characters.find(c => c.id === change.characterId);
    let inventory = JSON.parse(char.inventory || '[]');
    inventory = tagParser.applyInventoryChange(inventory, change.item, change.quantity, change.isAdding);
    db.prepare('UPDATE characters SET inventory = ? WHERE id = ?').run(JSON.stringify(inventory), change.characterId);
  }

  // ... etc ...
});
*/

// ============================================
// SOCKET.IO
// ============================================

io.on('connection', (socket) => {
  logger.debug('Client connected', { socketId: socket.id });

  socket.on('disconnect', () => {
    logger.debug('Client disconnected', { socketId: socket.id });
  });
});

// ============================================
// SERVER START
// ============================================

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  logger.info(`D&D Multiplayer server running on port ${PORT}`);
  logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

// ============================================
// EXPORTS (for testing)
// ============================================

module.exports = { app, server, io, db };
