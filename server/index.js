require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const Database = require('better-sqlite3');
const rateLimit = require('express-rate-limit');

// Import modular utilities
const logger = require('./lib/logger');
const { validate, validateBody, schemas } = require('./lib/validation');
const { getCached, setCache, invalidateCache } = require('./lib/cache');
const { securityHeaders, corsMiddleware } = require('./middleware/security');

// Import new modular components
const { createAuthMiddleware } = require('./middleware/auth');
const aiService = require('./services/aiService');
const tagParser = require('./services/tagParser');

// Extract commonly used functions from aiService for backward compatibility
const { extractAIMessage, DEFAULT_SYSTEM_PROMPT } = aiService;

// Import modular routes
const { initializeRoutes } = require('./routes');

const app = express();

// Track sessions currently being processed by AI (prevents race conditions)
const processingSessions = new Set();

// Rate limiting for auth endpoints (prevent brute force)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 attempts per window
  message: { error: 'Too many login attempts, please try again after 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false,
});

// General API rate limiting
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute
  message: { error: 'Too many requests, please slow down' },
  standardHeaders: true,
  legacyHeaders: false,
});
const server = http.createServer(app);
const io = new Server(server);

// Ensure data directory exists
const dbPath = process.env.DB_PATH || './data/dnd.db';
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// Database setup
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// Initialize database tables
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS characters (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    player_name TEXT,
    character_name TEXT,
    race TEXT,
    class TEXT,
    level INTEGER DEFAULT 1,
    xp INTEGER DEFAULT 0,
    strength INTEGER,
    dexterity INTEGER,
    constitution INTEGER,
    intelligence INTEGER,
    wisdom INTEGER,
    charisma INTEGER,
    hp INTEGER,
    max_hp INTEGER,
    background TEXT,
    equipment TEXT,
    spells TEXT,
    skills TEXT,
    passives TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS game_sessions (
    id TEXT PRIMARY KEY,
    name TEXT,
    story_summary TEXT,
    full_history TEXT,
    current_turn INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS pending_actions (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    character_id TEXT,
    action TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS api_configs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    api_key TEXT NOT NULL,
    model TEXT NOT NULL,
    is_active INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS session_characters (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    character_id TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(session_id, character_id)
  );
`);

// Migrate existing databases - add new columns if they don't exist
const columns = db.prepare("PRAGMA table_info(characters)").all().map(c => c.name);
if (!columns.includes('xp')) {
  db.exec('ALTER TABLE characters ADD COLUMN xp INTEGER DEFAULT 0');
}
if (!columns.includes('spells')) {
  db.exec('ALTER TABLE characters ADD COLUMN spells TEXT');
}
if (!columns.includes('skills')) {
  db.exec('ALTER TABLE characters ADD COLUMN skills TEXT');
}
if (!columns.includes('passives')) {
  db.exec('ALTER TABLE characters ADD COLUMN passives TEXT');
}
if (!columns.includes('gold')) {
  db.exec('ALTER TABLE characters ADD COLUMN gold INTEGER DEFAULT 0');
}
if (!columns.includes('inventory')) {
  db.exec("ALTER TABLE characters ADD COLUMN inventory TEXT DEFAULT '[]'");
}
if (!columns.includes('ac')) {
  db.exec('ALTER TABLE characters ADD COLUMN ac INTEGER DEFAULT 10');
}
if (!columns.includes('spell_slots')) {
  db.exec("ALTER TABLE characters ADD COLUMN spell_slots TEXT DEFAULT '{}'");
}
if (!columns.includes('feats')) {
  db.exec("ALTER TABLE characters ADD COLUMN feats TEXT DEFAULT ''");
}
if (!columns.includes('classes')) {
  // Multiclass support: JSON object like {"Fighter": 5, "Wizard": 3}
  // Will be initialized from existing class column on first load
  db.exec("ALTER TABLE characters ADD COLUMN classes TEXT DEFAULT '{}'");
}
if (!columns.includes('ac_effects')) {
  // AC effects tracking: JSON object with base_source, base_value, and effects array
  // Structure: { base_source: "Studded Leather", base_value: 14, effects: [{id, name, value, type, temporary, notes}] }
  db.exec(`ALTER TABLE characters ADD COLUMN ac_effects TEXT DEFAULT '{"base_source":"Unarmored","base_value":10,"effects":[]}'`);
}
if (!columns.includes('class_features')) {
  // Class features tracking: class abilities like Second Wind, Action Surge, Song of Rest, etc.
  db.exec("ALTER TABLE characters ADD COLUMN class_features TEXT DEFAULT ''");
}
if (!columns.includes('appearance')) {
  // Physical appearance description: hair, eyes, height, distinguishing features, etc.
  db.exec("ALTER TABLE characters ADD COLUMN appearance TEXT DEFAULT ''");
}
if (!columns.includes('backstory')) {
  // Character's personal history and background story
  db.exec("ALTER TABLE characters ADD COLUMN backstory TEXT DEFAULT ''");
}

// Combat tracker table
db.exec(`
  CREATE TABLE IF NOT EXISTS combats (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    name TEXT DEFAULT 'Combat',
    is_active INTEGER DEFAULT 1,
    current_turn INTEGER DEFAULT 0,
    round INTEGER DEFAULT 1,
    combatants TEXT DEFAULT '[]',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES game_sessions(id)
  )
`);

// Add initiative column to characters if not exists
if (!columns.includes('initiative_bonus')) {
  db.exec("ALTER TABLE characters ADD COLUMN initiative_bonus INTEGER DEFAULT 0");
}

// Migrate existing characters to use multiclass format
const charsToMigrate = db.prepare("SELECT id, class, level, classes FROM characters WHERE classes = '{}' OR classes IS NULL").all();
for (const char of charsToMigrate) {
  if (char.class && char.level) {
    const classesObj = {};
    classesObj[char.class] = char.level;
    db.prepare("UPDATE characters SET classes = ? WHERE id = ?").run(JSON.stringify(classesObj), char.id);
  }
}

// Migrate existing characters to use ac_effects format
const charsToMigrateAc = db.prepare("SELECT id, ac, ac_effects FROM characters WHERE ac_effects IS NULL OR ac_effects = '{\"base_source\":\"Unarmored\",\"base_value\":10,\"effects\":[]}'").all();
for (const char of charsToMigrateAc) {
  const currentAc = char.ac || 10;
  // If AC is different from default 10, preserve it as base value
  if (currentAc !== 10 || !char.ac_effects) {
    const acEffects = {
      base_source: currentAc > 10 ? "Equipment" : "Unarmored",
      base_value: currentAc,
      effects: []
    };
    db.prepare("UPDATE characters SET ac_effects = ? WHERE id = ?").run(JSON.stringify(acEffects), char.id);
  }
}

// Migrate equipment text to inventory items
const charsWithEquipment = db.prepare("SELECT id, equipment, inventory FROM characters WHERE equipment IS NOT NULL AND equipment != ''").all();
for (const char of charsWithEquipment) {
  try {
    // Parse existing inventory
    let inventory = [];
    try {
      inventory = JSON.parse(char.inventory || '[]');
    } catch (e) {
      inventory = [];
    }

    // Parse equipment text (comma or newline separated)
    const equipmentText = char.equipment || '';
    const equipmentItems = equipmentText
      .split(/[,\n]/)
      .map(item => item.trim())
      .filter(item => item.length > 0);

    // Add equipment items to inventory (avoid duplicates)
    for (const itemName of equipmentItems) {
      // Check for quantity pattern like "10 torches" or "Arrows x20"
      let name = itemName;
      let quantity = 1;

      const qtyPrefixMatch = itemName.match(/^(\d+)\s+(.+)$/);
      const qtySuffixMatch = itemName.match(/^(.+?)\s*x(\d+)$/i);

      if (qtyPrefixMatch) {
        quantity = parseInt(qtyPrefixMatch[1]);
        name = qtyPrefixMatch[2];
      } else if (qtySuffixMatch) {
        name = qtySuffixMatch[1].trim();
        quantity = parseInt(qtySuffixMatch[2]);
      }

      // Check if item already exists in inventory
      const existingItem = inventory.find(i => i.name.toLowerCase() === name.toLowerCase());
      if (existingItem) {
        existingItem.quantity = (existingItem.quantity || 1) + quantity;
      } else {
        inventory.push({ name, quantity });
      }
    }

    // Update inventory and clear equipment
    db.prepare('UPDATE characters SET inventory = ?, equipment = NULL WHERE id = ?')
      .run(JSON.stringify(inventory), char.id);
  } catch (e) {
    logger.error(`Failed to migrate equipment for character ${char.id}`, { error: e.message });
  }
}

// Migrate game_sessions table - add compacted_count column
const sessionColumns = db.prepare("PRAGMA table_info(game_sessions)").all().map(c => c.name);
if (!sessionColumns.includes('compacted_count')) {
  db.exec('ALTER TABLE game_sessions ADD COLUMN compacted_count INTEGER DEFAULT 0');
}

// Migrate game_sessions table - add scenario column
if (!sessionColumns.includes('scenario')) {
  db.exec("ALTER TABLE game_sessions ADD COLUMN scenario TEXT DEFAULT 'classic_fantasy'");
}

// Migrate existing API settings to api_configs table if needed
const existingConfigs = db.prepare('SELECT COUNT(*) as count FROM api_configs').get();
if (existingConfigs.count === 0) {
  // Check if there are old-style settings to migrate
  const oldEndpoint = db.prepare("SELECT value FROM settings WHERE key = 'api_endpoint'").get();
  const oldKey = db.prepare("SELECT value FROM settings WHERE key = 'api_key'").get();
  const oldModel = db.prepare("SELECT value FROM settings WHERE key = 'api_model'").get();

  if (oldKey && oldKey.value) {
    // Migrate old settings to new api_configs table
    db.prepare('INSERT INTO api_configs (id, name, endpoint, api_key, model, is_active) VALUES (?, ?, ?, ?, ?, 1)')
      .run(uuidv4(), 'Default', oldEndpoint?.value || 'https://api.openai.com/v1/chat/completions', oldKey.value, oldModel?.value || 'gpt-4');
  }
}

// ============================================
// Database Indexes for Query Performance
// ============================================
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_pending_actions_session ON pending_actions(session_id);
  CREATE INDEX IF NOT EXISTS idx_pending_actions_character ON pending_actions(character_id);
  CREATE INDEX IF NOT EXISTS idx_session_characters_session ON session_characters(session_id);
  CREATE INDEX IF NOT EXISTS idx_session_characters_character ON session_characters(character_id);
  CREATE INDEX IF NOT EXISTS idx_combats_session ON combats(session_id);
  CREATE INDEX IF NOT EXISTS idx_api_configs_active ON api_configs(is_active);
  CREATE INDEX IF NOT EXISTS idx_characters_created ON characters(created_at);
  CREATE INDEX IF NOT EXISTS idx_game_sessions_created ON game_sessions(created_at);
`);

// Helper function to get active API config
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

// XP requirements for each level
const XP_TABLE = [0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000, 85000, 100000, 120000, 140000, 165000, 195000, 225000, 265000, 305000, 355000];

function getRequiredXP(level) {
  return XP_TABLE[level] || 355000;
}

function canLevelUp(xp, level) {
  return xp >= getRequiredXP(level);
}

// AC Effects helper functions
function parseAcEffects(acEffectsJson) {
  try {
    const parsed = JSON.parse(acEffectsJson || '{}');
    return {
      base_source: parsed.base_source || 'Unarmored',
      base_value: parsed.base_value || 10,
      effects: parsed.effects || []
    };
  } catch (e) {
    return { base_source: 'Unarmored', base_value: 10, effects: [] };
  }
}

function calculateTotalAC(acEffects) {
  const data = typeof acEffects === 'string' ? parseAcEffects(acEffects) : acEffects;
  const effectsBonus = data.effects.reduce((sum, e) => sum + (e.value || 0), 0);
  return data.base_value + effectsBonus;
}

function updateCharacterAC(charId, acEffects) {
  const totalAC = calculateTotalAC(acEffects);
  const acEffectsJson = JSON.stringify(acEffects);
  db.prepare('UPDATE characters SET ac = ?, ac_effects = ? WHERE id = ?').run(totalAC, acEffectsJson, charId);
  return { ac: totalAC, ac_effects: acEffects };
}

// Initialize default settings if not exist
const initSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
const upsertSetting = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');

// Passwords from environment variables - ALWAYS update if env var is set
const defaultPassword = process.env.GAME_PASSWORD;
const adminPassword = process.env.ADMIN_PASSWORD;

// Helper to generate secure random password
function generateSecurePassword() {
  return require('crypto').randomBytes(16).toString('hex');
}

// Check if passwords already exist in database
const existingGamePassword = db.prepare('SELECT value FROM settings WHERE key = ?').get('game_password');
const existingAdminPassword = db.prepare('SELECT value FROM settings WHERE key = ?').get('admin_password');

// Always update passwords if environment variables are provided
if (defaultPassword) {
  upsertSetting.run('game_password', bcrypt.hashSync(defaultPassword, 10));
} else if (!existingGamePassword) {
  // Only generate random password on first run (no existing password)
  const generatedGamePassword = generateSecurePassword();
  upsertSetting.run('game_password', bcrypt.hashSync(generatedGamePassword, 10));
  console.log('\n' + '='.repeat(60));
  console.log('SECURITY: No GAME_PASSWORD env var set.');
  console.log('Generated random game password: ' + generatedGamePassword);
  console.log('Set GAME_PASSWORD env var to use a custom password.');
  console.log('='.repeat(60) + '\n');
}

if (adminPassword) {
  upsertSetting.run('admin_password', bcrypt.hashSync(adminPassword, 10));
} else if (!existingAdminPassword) {
  // Only generate random password on first run (no existing password)
  const generatedAdminPassword = generateSecurePassword();
  upsertSetting.run('admin_password', bcrypt.hashSync(generatedAdminPassword, 10));
  console.log('\n' + '='.repeat(60));
  console.log('SECURITY: No ADMIN_PASSWORD env var set.');
  console.log('Generated random admin password: ' + generatedAdminPassword);
  console.log('Set ADMIN_PASSWORD env var to use a custom password.');
  console.log('='.repeat(60) + '\n');
}

initSetting.run('api_endpoint', 'https://api.openai.com/v1/chat/completions');
initSetting.run('api_key', '');
initSetting.run('api_model', 'gpt-4');
initSetting.run('max_tokens_before_compact', '8000');

// Response prefix for session AI - helps with immersion, stripped from final output
const AI_RESPONSE_PREFIX = "All right! Let's get to writing!\n\n";

// Request body size limits to prevent DoS
app.use(express.json({ limit: '1mb' }));

// Security middleware (from modules)
app.use(securityHeaders);
const allowedOrigins = process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : [];
app.use(corsMiddleware(allowedOrigins));

app.use(express.static(path.join(__dirname, '../public')));

// Auth middleware - using modular component
const { checkPassword, checkAdminPassword } = createAuthMiddleware(db);
const auth = { checkPassword, checkAdminPassword };

// ============================================
// MODULAR ROUTES (New Architecture)
// ============================================

// Apply general rate limiting to all API routes
app.use('/api/', apiLimiter);

// Initialize all modular routes
const routes = initializeRoutes({
  db,
  io,
  auth,
  authLimiter,
  aiService,
  processingSessions,
  getActiveApiConfig,
  processAITurn,
  DEFAULT_SYSTEM_PROMPT,
  getOpenAIApiKey
});

// Mount modular routes
app.use('/api', routes.auth);                    // /api/auth, /api/admin-auth, /api/settings
app.use('/api/characters', routes.characters);   // /api/characters/*
app.use('/api/sessions', routes.combat);         // /api/sessions/:id/combat/*
app.use('/api/api-configs', routes.apiConfig);   // /api/api-configs/*
app.use('/api/sessions', routes.sessions);       // /api/sessions/*
app.use('/api/tts', routes.tts);                 // /api/tts/*

// ============================================
// REMAINING INLINE ROUTES
// (Complex routes that depend on inline functions)
// ============================================
// Auth routes now handled by routes.auth
// Settings routes now handled by routes.auth

// Helper function to find character by name - using modular tagParser
const { findCharacterByName } = tagParser;

// Helper function to get characters for a specific session
function getSessionCharacters(sessionId) {
  return db.prepare(`
    SELECT c.* FROM characters c
    INNER JOIN session_characters sc ON c.id = sc.character_id
    WHERE sc.session_id = ?
    ORDER BY c.created_at DESC
  `).all(sessionId);
}


// Game session routes
app.get('/api/sessions', checkPassword, (req, res) => {
  const sessions = db.prepare('SELECT * FROM game_sessions ORDER BY created_at DESC').all();
  res.json(sessions);
});

app.post('/api/sessions', checkPassword, validateBody(schemas.session), async (req, res) => {
  const { name, scenario, scenarioPrompt, characterIds } = req.body;

  // Sanitize inputs
  const sanitizedName = validate.sanitizeString(name, 200);
  const sanitizedScenario = validate.sanitizeString(scenario || 'classic_fantasy', 100);
  const sanitizedPrompt = validate.sanitizeString(scenarioPrompt || '', 10000);

  // Validate characterIds are UUIDs
  const validCharIds = (characterIds || []).filter(id => validate.isUUID(id));

  const id = uuidv4();

  db.prepare('INSERT INTO game_sessions (id, name, full_history, story_summary, scenario) VALUES (?, ?, ?, ?, ?)').run(id, sanitizedName, '[]', '', sanitizedScenario);

  // Link selected characters to this session
  if (validCharIds && validCharIds.length > 0) {
    const insertCharacter = db.prepare('INSERT OR IGNORE INTO session_characters (id, session_id, character_id) VALUES (?, ?, ?)');
    for (const charId of validCharIds) {
      insertCharacter.run(uuidv4(), id, charId);
    }
  }

  // Generate opening scene with AI if scenario provided
  if (sanitizedPrompt) {
    try {
      const apiConfig = getActiveApiConfig();
      if (apiConfig && apiConfig.api_key) {
        // Get only the selected characters for this session
        const characters = validCharIds && validCharIds.length > 0
          ? db.prepare(`SELECT * FROM characters WHERE id IN (${validCharIds.map(() => '?').join(',')})`).all(...validCharIds)
          : [];

        // Build character intro
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
          const openingScene = extractAIMessage(data);

          if (openingScene) {
            // Save opening scene to history
            const history = [
              { role: 'assistant', content: openingScene, type: 'narration' }
            ];
            db.prepare('UPDATE game_sessions SET full_history = ? WHERE id = ?').run(JSON.stringify(history), id);
          }
        }
      }
    } catch (error) {
      console.error('Failed to generate opening scene:', error);
      // Continue without opening scene
    }
  }

  const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(id);
  io.emit('session_created', session);
  res.json(session);
});

app.get('/api/sessions/:id', checkPassword, (req, res) => {
  const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const pendingActions = db.prepare('SELECT * FROM pending_actions WHERE session_id = ?').all(req.params.id);
  const sessionCharacters = getSessionCharacters(req.params.id);

  res.json({ session, pendingActions, sessionCharacters });
});

// Delete session
app.delete('/api/sessions/:id', checkPassword, (req, res) => {
  const sessionId = req.params.id;

  try {
    // Delete associated pending actions first
    db.prepare('DELETE FROM pending_actions WHERE session_id = ?').run(sessionId);

    // Delete session character links
    db.prepare('DELETE FROM session_characters WHERE session_id = ?').run(sessionId);

    // Delete associated combats
    db.prepare('DELETE FROM combats WHERE session_id = ?').run(sessionId);

    // Delete the session
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

// Submit action
app.post('/api/sessions/:id/action', checkPassword, async (req, res) => {
  const { character_id, action } = req.body;
  const sessionId = req.params.id;

  // RACE CONDITION FIX: Reject submissions if AI is currently processing this session
  if (processingSessions.has(sessionId)) {
    logger.warn('Action rejected - session is currently processing', { sessionId, character_id });
    return res.status(409).json({
      error: 'Turn is currently being processed. Please wait for the Narrator to finish.',
      processing: true
    });
  }

  // Check if character already has pending action
  const existing = db.prepare('SELECT * FROM pending_actions WHERE session_id = ? AND character_id = ?').get(sessionId, character_id);
  if (existing) {
    db.prepare('UPDATE pending_actions SET action = ? WHERE id = ?').run(action, existing.id);
  } else {
    db.prepare('INSERT INTO pending_actions (id, session_id, character_id, action) VALUES (?, ?, ?, ?)').run(uuidv4(), sessionId, character_id, action);
  }

  const pendingActions = db.prepare('SELECT * FROM pending_actions WHERE session_id = ?').all(sessionId);
  const characters = getSessionCharacters(sessionId);

  io.emit('action_submitted', { sessionId, pendingActions, character_id });

  // Check if all characters have submitted actions
  if (pendingActions.length >= characters.length && characters.length > 0) {
    // RACE CONDITION FIX: Set processing lock BEFORE starting AI processing
    processingSessions.add(sessionId);
    io.emit('turn_processing', { sessionId });

    // Process turn with AI
    try {
      const result = await processAITurn(sessionId, pendingActions, characters);
      res.json({ processed: true, result });
    } catch (error) {
      console.error('AI processing error:', error);
      res.json({ processed: false, error: error.message });
    } finally {
      // RACE CONDITION FIX: Always clear the lock when done
      processingSessions.delete(sessionId);
    }
  } else {
    res.json({ processed: false, waiting: characters.length - pendingActions.length });
  }
});

// Cancel a pending action
app.delete('/api/sessions/:id/action/:characterId', checkPassword, (req, res) => {
  const sessionId = req.params.id;
  const characterId = req.params.characterId;

  db.prepare('DELETE FROM pending_actions WHERE session_id = ? AND character_id = ?').run(sessionId, characterId);

  const pendingActions = db.prepare('SELECT * FROM pending_actions WHERE session_id = ?').all(sessionId);
  io.emit('action_cancelled', { sessionId, pendingActions, character_id: characterId });

  res.json({ success: true, pendingActions });
});

// Force process turn (DM override)
app.post('/api/sessions/:id/process', checkPassword, async (req, res) => {
  const sessionId = req.params.id;

  // RACE CONDITION FIX: Reject if already processing
  if (processingSessions.has(sessionId)) {
    return res.status(409).json({
      error: 'Turn is already being processed.',
      processing: true
    });
  }

  const pendingActions = db.prepare('SELECT * FROM pending_actions WHERE session_id = ?').all(sessionId);
  const characters = getSessionCharacters(sessionId);

  // RACE CONDITION FIX: Set processing lock
  processingSessions.add(sessionId);
  io.emit('turn_processing', { sessionId });

  try {
    const result = await processAITurn(sessionId, pendingActions, characters);
    res.json({ success: true, result });
  } catch (error) {
    console.error('AI processing error:', error);
    res.status(500).json({ error: error.message });
  } finally {
    // RACE CONDITION FIX: Always clear the lock
    processingSessions.delete(sessionId);
  }
});

// GM Mode - Send hidden message to nudge AI (admin only)
app.post('/api/sessions/:id/gm-message', checkPassword, checkAdminPassword, (req, res) => {
  const sessionId = req.params.id;
  const { message } = req.body;

  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Message is required' });
  }

  const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  // Add GM message to history as hidden
  let fullHistory = JSON.parse(session.full_history || '[]');
  fullHistory.push({
    role: 'user',
    content: message.trim(),
    type: 'gm_nudge',
    hidden: true,
    timestamp: new Date().toISOString()
  });

  // Update session history
  db.prepare('UPDATE game_sessions SET full_history = ? WHERE id = ?')
    .run(JSON.stringify(fullHistory), sessionId);

  console.log(`GM Nudge added to session ${sessionId}: "${message.substring(0, 50)}..."`);

  res.json({ success: true, message: 'GM message added. It will be included in the next AI response.' });
});

// Reroll - Regenerate the last AI response (admin only)
app.post('/api/sessions/:id/reroll', checkPassword, checkAdminPassword, async (req, res) => {
  const sessionId = req.params.id;

  // RACE CONDITION FIX: Reject if already processing
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

  // Find the context message that started this turn (going backwards from assistant)
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

  // Remove everything from turnStartIdx onwards (context, actions, gm_nudges, and the assistant response)
  fullHistory = fullHistory.slice(0, turnStartIdx);

  // Also remove any gm_nudge messages from the remaining history
  fullHistory = fullHistory.filter(entry => entry.type !== 'gm_nudge');

  // Adjust compacted_count if we truncated into the compacted region
  let compactedCount = session.compacted_count || 0;
  const originalCompactedCount = compactedCount;
  if (fullHistory.length < compactedCount) {
    compactedCount = fullHistory.length;
  }

  // Save the modified history with adjusted compacted_count
  db.prepare('UPDATE game_sessions SET full_history = ?, compacted_count = ? WHERE id = ?')
    .run(JSON.stringify(fullHistory), compactedCount, sessionId);

  if (compactedCount !== originalCompactedCount) {
    console.log(`Reroll: Adjusted compacted_count from ${originalCompactedCount} to ${compactedCount}`);
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

  // RACE CONDITION FIX: Set processing lock
  processingSessions.add(sessionId);

  // Notify clients that reroll is starting
  io.emit('reroll_started', { sessionId });

  try {
    const result = await processAITurn(sessionId, pendingActions, characters);
    res.json({ success: true, result });
  } catch (error) {
    console.error('Reroll AI processing error:', error);
    res.status(500).json({ error: error.message });
  } finally {
    // RACE CONDITION FIX: Always clear the lock
    processingSessions.delete(sessionId);
  }
});

// AI Auto-Reply - Generate and submit action for a character
app.post('/api/sessions/:id/auto-reply', checkPassword, async (req, res) => {
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

  // Get story summary for context
  const storySummary = session.story_summary || '';

  // Get recent history for context - filter out hidden/context messages
  const fullHistory = JSON.parse(session.full_history || '[]');
  const visibleHistory = fullHistory.filter(m => !m.hidden && m.type !== 'context');
  const recentHistory = visibleHistory.slice(-30); // Last 30 visible messages for better context

  // Find the most recent DM narration (this is what we need to respond to)
  const lastDMMessage = [...recentHistory].reverse().find(m => m.role === 'assistant');

  // Get recent conversation flow (last few exchanges)
  const recentExchanges = recentHistory.slice(-10).map(m => {
    if (m.role === 'assistant') return `DM: ${m.content.substring(0, 800)}`;
    if (m.character_name) return `${m.character_name}: ${m.content}`;
    return null;
  }).filter(Boolean).join('\n\n');

  // Find other player actions this turn (to avoid duplicating)
  const recentPlayerActions = recentHistory
    .filter(m => m.role === 'user' && m.character_name && m.character_name !== character.character_name)
    .slice(-5);

  // Get all characters in session for party context
  const sessionChars = getSessionCharacters(sessionId);
  const partyContext = sessionChars.map(c => `${c.character_name} (${c.race} ${c.class}, Level ${c.level})`).join(', ');

  // Parse character abilities for context
  let classFeatures = character.class_features || '';
  let spells = character.spells || '';
  let feats = character.feats || '';

  // Build prompt for AI to generate character action
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
    // Get active API config
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

    // Now submit this action as if the player did it
    const existing = db.prepare('SELECT * FROM pending_actions WHERE session_id = ? AND character_id = ?').get(sessionId, character_id);
    if (existing) {
      db.prepare('UPDATE pending_actions SET action = ? WHERE id = ?').run(generatedAction, existing.id);
    } else {
      db.prepare('INSERT INTO pending_actions (id, session_id, character_id, action) VALUES (?, ?, ?, ?)').run(uuidv4(), sessionId, character_id, generatedAction);
    }

    const pendingActions = db.prepare('SELECT * FROM pending_actions WHERE session_id = ?').all(sessionId);
    const characters = getSessionCharacters(sessionId);

    io.emit('action_submitted', { sessionId, pendingActions, character_id });

    // Check if all characters have submitted actions
    if (pendingActions.length >= characters.length && characters.length > 0) {
      // Process turn with AI
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

// Get session summary (for viewing/editing)
app.get('/api/sessions/:id/summary', checkPassword, checkAdminPassword, (req, res) => {
  const sessionId = req.params.id;
  const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const fullHistory = JSON.parse(session.full_history || '[]');

  res.json({
    summary: session.story_summary || '',
    compactedCount: session.compacted_count || 0,
    totalMessages: fullHistory.length,
    uncompactedMessages: fullHistory.length - (session.compacted_count || 0)
  });
});

// Update session summary manually (admin only)
app.post('/api/sessions/:id/summary', checkPassword, checkAdminPassword, (req, res) => {
  const sessionId = req.params.id;
  const { summary } = req.body;

  const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  db.prepare('UPDATE game_sessions SET story_summary = ? WHERE id = ?').run(summary || '', sessionId);

  console.log(`Summary manually updated for session ${sessionId}`);
  res.json({ success: true, message: 'Summary updated successfully.' });
});

// Force compact session history (admin only)
app.post('/api/sessions/:id/force-compact', checkPassword, checkAdminPassword, async (req, res) => {
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

  // Get messages since last compaction
  const recentHistory = fullHistory.slice(compactedCount);

  if (recentHistory.length === 0) {
    return res.status(400).json({ error: 'No new messages to compact.' });
  }

  try {
    console.log(`Force compacting session ${sessionId}...`);
    const newSummary = await compactHistory(apiConfig, session.story_summary, recentHistory, characters);

    // Update database
    db.prepare('UPDATE game_sessions SET story_summary = ?, compacted_count = ?, total_tokens = 0 WHERE id = ?')
      .run(newSummary, fullHistory.length, sessionId);

    // Notify clients
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

// Recalculate XP from session history (for existing sessions)
app.post('/api/sessions/:id/recalculate-xp', checkPassword, (req, res) => {
  const sessionId = req.params.id;
  const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const characters = getSessionCharacters(sessionId);
  const history = JSON.parse(session.full_history || '[]');
  const xpAwarded = {};

  // Scan all assistant messages for XP awards
  console.log('=== Recalculating XP ===');
  console.log('Session characters:', characters.map(c => c.character_name));
  for (const entry of history) {
    if (entry.role === 'assistant') {
      // Match [XP: ...] with optional space after colon (consistent with live parsing)
      const xpMatches = entry.content.match(/\[XP:\s*([^\]]+)\]/gi);
      if (xpMatches) {
        console.log('Found XP tags:', xpMatches);
        for (const match of xpMatches) {
          const xpAwards = match.replace(/\[XP:\s*/i, '').replace(']', '').split(',');
          for (const award of xpAwards) {
            // Allow optional spaces around the + sign
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

  // Update character XP
  for (const [charId, xp] of Object.entries(xpAwarded)) {
    db.prepare('UPDATE characters SET xp = ? WHERE id = ?').run(xp, charId);
  }

  // Notify clients
  const updatedCharacters = getSessionCharacters(sessionId);
  for (const char of updatedCharacters) {
    io.emit('character_updated', char);
  }

  res.json({ success: true, xpAwarded });
});

// Recalculate gold and inventory from session history
app.post('/api/sessions/:id/recalculate-loot', checkPassword, (req, res) => {
  const sessionId = req.params.id;
  const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const characters = getSessionCharacters(sessionId);
  const history = JSON.parse(session.full_history || '[]');
  const goldAwarded = {};
  const inventoryChanges = {};

  // Initialize tracking objects for each character
  for (const char of characters) {
    goldAwarded[char.id] = 0;
    inventoryChanges[char.id] = [];
  }

  // Scan all assistant messages for gold and item awards
  for (const entry of history) {
    if (entry.role === 'assistant') {
      // Parse MONEY/GOLD awards (AI uses MONEY, but support GOLD for backward compatibility)
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

      // Parse ITEM awards
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

  // Update character gold and inventory
  for (const char of characters) {
    // Update gold
    const newGold = Math.max(0, goldAwarded[char.id] || 0);

    // Build inventory from changes
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

  // Notify clients
  const updatedCharacters = getSessionCharacters(sessionId);
  for (const char of updatedCharacters) {
    io.emit('character_updated', char);
  }

  res.json({ success: true, goldAwarded, inventoryChanges });
});

// Recalculate inventory only from session history
app.post('/api/sessions/:id/recalculate-inventory', checkPassword, (req, res) => {
  const sessionId = req.params.id;
  const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const characters = getSessionCharacters(sessionId);
  const history = JSON.parse(session.full_history || '[]');
  const inventoryChanges = {};

  // Initialize tracking for each character
  for (const char of characters) {
    inventoryChanges[char.id] = [];
  }

  // Scan all assistant messages for item awards
  for (const entry of history) {
    if (entry.role === 'assistant') {
      // Parse ITEM tags
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

  // Update character inventories
  for (const char of characters) {
    // Build inventory from changes
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

  // Notify clients
  const updatedCharacters = getSessionCharacters(sessionId);
  for (const char of updatedCharacters) {
    io.emit('character_updated', char);
  }

  res.json({ success: true, inventoryChanges });
});

// Recalculate AC and spell slots from session history
app.post('/api/sessions/:id/recalculate-ac-spells', checkPassword, (req, res) => {
  const sessionId = req.params.id;
  const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const characters = getSessionCharacters(sessionId);
  const history = JSON.parse(session.full_history || '[]');
  const acValues = {};
  const acEffectsTracking = {};  // Track AC effects per character
  const spellSlotUsage = {};

  // Initialize tracking for each character
  for (const char of characters) {
    acValues[char.id] = null; // null means not found
    acEffectsTracking[char.id] = parseAcEffects(char.ac_effects); // Start with current effects
    spellSlotUsage[char.id] = {};
  }

  // Scan all messages for AC and spell slot information
  for (const entry of history) {
    const content = entry.content || '';

    // Parse [AC:] tags for AC effects
    const acMatches = content.match(/\[AC:([^\]]+)\]/gi);
    if (acMatches) {
      for (const match of acMatches) {
        const acContent = match.replace(/\[AC:/i, '').replace(']', '').trim();

        // Try to match "base" command: CharacterName base ArmorName Value
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

        // Try to match add effect: CharacterName +EffectName +Value Type
        const addMatch = acContent.match(/(.+?)\s+\+(.+?)\s+\+(\d+)\s+(\w+)$/i);
        if (addMatch) {
          const charName = addMatch[1].trim();
          const effectName = addMatch[2].trim();
          const effectValue = parseInt(addMatch[3]);
          const effectType = addMatch[4].trim().toLowerCase();

          const char = findCharacterByName(characters, charName);
          if (char) {
            // Check if effect already exists
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

        // Try to match remove effect: CharacterName -EffectName
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

    // Parse [SPELL:] tags (our format)
    const spellMatches = content.match(/\[SPELL:([^\]]+)\]/gi);
    if (spellMatches) {
      for (const match of spellMatches) {
        const spellContent = match.replace(/\[SPELL:/i, '').replace(']', '');
        const parts = spellContent.split(',');

        for (const part of parts) {
          const trimmed = part.trim();

          // Check for REST command
          const restMatch = trimmed.match(/(.+?)\s*\+REST/i);
          if (restMatch) {
            const charName = restMatch[1].trim();
            const char = findCharacterByName(characters, charName);
            if (char) {
              // Reset all spell slots to max
              for (const level in spellSlotUsage[char.id]) {
                spellSlotUsage[char.id][level].used = 0;
              }
            }
            continue;
          }

          // Check for slot usage: CharacterName -1st, +2nd, etc.
          const slotMatch = trimmed.match(/(.+?)\s*([+-])(\d+)(?:st|nd|rd|th)/i);
          if (slotMatch) {
            const charName = slotMatch[1].trim();
            const isUsing = slotMatch[2] === '-';
            const level = slotMatch[3];
            const char = findCharacterByName(characters, charName);
            if (char) {
              if (!spellSlotUsage[char.id][level]) {
                spellSlotUsage[char.id][level] = { used: 0, detected: true };
              }
              if (isUsing) {
                spellSlotUsage[char.id][level].used++;
              } else {
                spellSlotUsage[char.id][level].used = Math.max(0, spellSlotUsage[char.id][level].used - 1);
              }
            }
          }
        }
      }
    }

    // Parse natural language spell casting (for older chats without [SPELL:] tags)
    // Patterns like "Gandalf casts Fireball using a 3rd level spell slot"
    const naturalSpellPattern = /(\w+(?:\s+\w+)?)\s+(?:casts?|uses?|expends?)\s+.+?(?:using\s+)?(?:a\s+)?(\d+)(?:st|nd|rd|th)[\s-]*level\s+(?:spell\s+)?slot/gi;
    let naturalMatch;
    while ((naturalMatch = naturalSpellPattern.exec(content)) !== null) {
      const charName = naturalMatch[1].trim();
      const level = naturalMatch[2];
      const char = findCharacterByName(characters, charName);
      if (char) {
        if (!spellSlotUsage[char.id][level]) {
          spellSlotUsage[char.id][level] = { used: 0, detected: true };
        }
        spellSlotUsage[char.id][level].used++;
      }
    }

    // Parse AC mentions from AI responses
    // Patterns: "AC is now 16", "AC: 18", "Armor Class of 15", "AC 14"
    if (entry.role === 'assistant') {
      for (const char of characters) {
        const charNamePattern = char.character_name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        // Look for AC mentions near character name
        const acPatterns = [
          new RegExp(`${charNamePattern}[^.]*?(?:AC|Armor\\s*Class)\\s*(?:is\\s*(?:now\\s*)?|:\\s*|of\\s*|=\\s*)(\\d+)`, 'i'),
          new RegExp(`(?:AC|Armor\\s*Class)\\s*(?:is\\s*(?:now\\s*)?|:\\s*|of\\s*|=\\s*)(\\d+)[^.]*?${charNamePattern}`, 'i'),
          new RegExp(`${charNamePattern}'s\\s*(?:AC|Armor\\s*Class)\\s*(?:is\\s*)?(?:now\\s*)?(\\d+)`, 'i')
        ];

        for (const pattern of acPatterns) {
          const acMatch = content.match(pattern);
          if (acMatch) {
            const acValue = parseInt(acMatch[1]);
            if (acValue >= 5 && acValue <= 30) { // Sanity check for AC values
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

    // Update AC effects from [AC:] tags
    const trackedEffects = acEffectsTracking[char.id];
    const totalAc = calculateTotalAC(trackedEffects);
    updateCharacterAC(char.id, trackedEffects);
    results.acEffectsUpdated[char.character_name] = {
      total: totalAc,
      base: `${trackedEffects.base_source}: ${trackedEffects.base_value}`,
      effects: trackedEffects.effects.map(e => `${e.name}: +${e.value}`)
    };
    updated = true;

    // Also check for simple AC mentions (legacy support)
    if (acValues[char.id] !== null && trackedEffects.effects.length === 0) {
      // Only use simple AC if no effects were detected
      trackedEffects.base_value = acValues[char.id];
      updateCharacterAC(char.id, trackedEffects);
      results.acUpdated[char.character_name] = acValues[char.id];
    }

    // Update spell slots if any were detected
    const detectedSlots = spellSlotUsage[char.id];
    if (Object.keys(detectedSlots).length > 0) {
      // Get current spell slots or initialize
      let currentSlots = {};
      try {
        currentSlots = JSON.parse(char.spell_slots || '{}');
      } catch (e) {
        currentSlots = {};
      }

      // Update with detected usage
      for (const level in detectedSlots) {
        if (!currentSlots[level]) {
          // If we detected usage but no slot config exists, estimate max based on typical caster
          const estimatedMax = Math.max(2, detectedSlots[level].used + 1);
          currentSlots[level] = { current: estimatedMax - detectedSlots[level].used, max: estimatedMax };
        } else {
          // Update current based on usage (max - used)
          currentSlots[level].current = Math.max(0, currentSlots[level].max - detectedSlots[level].used);
        }
      }

      db.prepare('UPDATE characters SET spell_slots = ? WHERE id = ?').run(JSON.stringify(currentSlots), char.id);
      results.spellSlotsUpdated[char.character_name] = currentSlots;
      updated = true;
    }
  }

  // Notify clients
  const updatedCharacters = getSessionCharacters(sessionId);
  for (const char of updatedCharacters) {
    io.emit('character_updated', char);
  }

  res.json({ success: true, ...results });
});

// Delete a message from session history
app.post('/api/sessions/:id/delete-message', checkPassword, (req, res) => {
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

    // Remove the message at the specified index
    const deletedMessage = history.splice(index, 1)[0];

    // Adjust compacted_count if we deleted a message in the compacted region
    let compactedCount = session.compacted_count || 0;
    if (index < compactedCount) {
      compactedCount = Math.max(0, compactedCount - 1);
    }
    // Safety: ensure compacted_count never exceeds history length
    compactedCount = Math.min(compactedCount, history.length);

    // Update the database with adjusted compacted_count
    db.prepare('UPDATE game_sessions SET full_history = ?, compacted_count = ? WHERE id = ?')
      .run(JSON.stringify(history), compactedCount, sessionId);

    // Notify clients
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

// AI Processing function
async function processAITurn(sessionId, pendingActions, characters) {
  // Note: turn_processing event is now emitted by the calling endpoint (before lock is set)
  // This ensures proper coordination with the processingSessions lock

  const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(sessionId);
  const apiConfig = getActiveApiConfig();
  if (!apiConfig || !apiConfig.api_key) {
    throw new Error('No active API configuration. Please add and activate one in Settings.');
  }

  // Get general settings (non-API settings)
  const settings = {};
  db.prepare('SELECT key, value FROM settings').all().forEach(row => settings[row.key] = row.value);

  let fullHistory = JSON.parse(session.full_history || '[]');
  const compactedCount = session.compacted_count || 0;

  // Build character info
  const characterInfo = characters.map(c => {
    // Parse multiclass info
    let classDisplay = `${c.class} ${c.level}`;
    try {
      const classes = JSON.parse(c.classes || '{}');
      if (Object.keys(classes).length > 0) {
        classDisplay = Object.entries(classes).map(([cls, lvl]) => `${cls} ${lvl}`).join(' / ');
      }
    } catch (e) {}

    // Parse AC effects for display
    const acEffects = parseAcEffects(c.ac_effects);
    let acDisplay = `${c.ac || 10} (${acEffects.base_source}: ${acEffects.base_value}`;
    if (acEffects.effects.length > 0) {
      const effectsStr = acEffects.effects.map(e => `${e.name}: +${e.value}`).join(', ');
      acDisplay += ` + ${effectsStr}`;
    }
    acDisplay += ')';

    let info = `${c.character_name} (${c.race} ${classDisplay}, played by ${c.player_name}):\n`;
    info += `  Stats: STR:${c.strength} DEX:${c.dexterity} CON:${c.constitution} INT:${c.intelligence} WIS:${c.wisdom} CHA:${c.charisma}\n`;
    info += `  HP: ${c.hp}/${c.max_hp}, AC: ${acDisplay}`;
    if (c.appearance) info += `\n  Appearance: ${c.appearance}`;
    if (c.backstory) info += `\n  Backstory: ${c.backstory}`;
    if (c.skills) info += `\n  Skills: ${c.skills}`;
    if (c.spells) info += `\n  Spells: ${c.spells}`;
    if (c.passives) info += `\n  Passives: ${c.passives}`;
    if (c.class_features) info += `\n  Class Features: ${c.class_features}`;
    if (c.feats) info += `\n  Feats: ${c.feats}`;
    return info;
  }).join('\n\n');

  // Build action summary for AI
  const actionSummary = pendingActions.map(pa => {
    const char = characters.find(c => c.id === pa.character_id);
    return `${char ? char.character_name : 'Unknown'}: ${pa.action}`;
  }).join('\n');

  // Build the full AI message (includes everything for AI context)
  const aiUserMessage = `
PARTY STATUS:
${characterInfo}

PLAYER ACTIONS THIS TURN:
${actionSummary}

Please narrate the outcome of these actions and describe what happens next.`;

  // Store character context as hidden system context (not shown in UI but sent to AI)
  fullHistory.push({
    role: 'user',
    content: characterInfo,
    type: 'context',
    hidden: true
  });

  // Store each player action as a separate entry for display
  for (const pa of pendingActions) {
    const char = characters.find(c => c.id === pa.character_id);
    if (char) {
      fullHistory.push({
        role: 'user',
        content: pa.action,
        type: 'action',
        character_id: char.id,
        character_name: char.character_name,
        player_name: char.player_name
      });
    }
  }

  // Build messages array for AI - only send messages after compacted_count
  // The summary covers messages 0 to compactedCount-1
  // For AI, we combine the stored entries into proper user/assistant messages
  let recentHistory = fullHistory.slice(compactedCount);

  // Safety net: If compacted_count is stale and we have no recent context,
  // fall back to using the last N messages to ensure AI has context
  if (recentHistory.length === 0 && fullHistory.length > 0) {
    const fallbackCount = Math.min(10, fullHistory.length);
    recentHistory = fullHistory.slice(-fallbackCount);
    console.warn(`Safety fallback: compacted_count (${compactedCount}) exceeded history length (${fullHistory.length}). Using last ${fallbackCount} messages.`);
  }

  // Convert stored history to AI-compatible format
  // Combine context + actions into single user messages for AI
  const aiMessages = [];
  let currentUserContent = [];

  for (const entry of recentHistory) {
    if (entry.role === 'assistant') {
      // Flush any pending user content
      if (currentUserContent.length > 0) {
        aiMessages.push({ role: 'user', content: currentUserContent.join('\n\n') });
        currentUserContent = [];
      }
      aiMessages.push({ role: 'assistant', content: entry.content });
    } else if (entry.role === 'user') {
      if (entry.type === 'context') {
        currentUserContent.push(`PARTY STATUS:\n${entry.content}`);
      } else if (entry.type === 'action') {
        currentUserContent.push(`${entry.character_name}: ${entry.content}`);
      } else if (entry.type === 'gm_nudge') {
        // GM Mode: Hidden instruction for the AI (players don't see this)
        currentUserContent.push(`[GM INSTRUCTION - DO NOT REVEAL THIS TO PLAYERS]: ${entry.content}`);
      } else {
        // Legacy format - use content as-is
        currentUserContent.push(entry.content);
      }
    }
  }

  // Flush remaining user content and add the prompt
  if (currentUserContent.length > 0) {
    currentUserContent.push('Please narrate the outcome of these actions and describe what happens next.');
    aiMessages.push({ role: 'user', content: currentUserContent.join('\n\n') });
  }

  const messages = [
    { role: 'system', content: DEFAULT_SYSTEM_PROMPT + (session.story_summary ? `\n\nSTORY SO FAR:\n${session.story_summary}` : '') },
    ...aiMessages,
    // Prefill assistant response to help with immersion (will be stripped from output)
    { role: 'assistant', content: AI_RESPONSE_PREFIX }
  ];

  // Debug: Log what's being sent to AI
  console.log('=== AI Request Debug ===');
  console.log(`Compacted count: ${compactedCount}`);
  console.log(`Full history length: ${fullHistory.length}`);
  console.log(`Recent history length (sent to AI): ${recentHistory.length}`);
  console.log(`Has story summary: ${!!session.story_summary}`);
  if (session.story_summary) {
    console.log(`Story summary length: ${session.story_summary.length} chars`);
  }
  console.log(`Total messages to AI: ${messages.length} (1 system + ${aiMessages.length} conversation)`);

  // Call AI API
  const response = await fetch(apiConfig.api_endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiConfig.api_key}`
    },
    body: JSON.stringify({
      model: apiConfig.api_model,
      messages: messages,
      max_tokens: 64000
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`API Error: ${error}`);
  }

  const data = await response.json();
  let aiResponse = extractAIMessage(data);

  if (!aiResponse) {
    console.log('Failed to extract AI response:', JSON.stringify(data, null, 2));
    throw new Error('Could not parse AI response. Check server logs.');
  }

  // Strip the response prefix if present (it was used to help with immersion)
  if (aiResponse.startsWith(AI_RESPONSE_PREFIX)) {
    aiResponse = aiResponse.slice(AI_RESPONSE_PREFIX.length);
  } else if (aiResponse.startsWith(AI_RESPONSE_PREFIX.trim())) {
    aiResponse = aiResponse.slice(AI_RESPONSE_PREFIX.trim().length).trimStart();
  }

  const tokensUsed = data.usage?.total_tokens || estimateTokens(JSON.stringify(messages) + aiResponse);

  fullHistory.push({ role: 'assistant', content: aiResponse, type: 'narration' });

  // Debug: Log AI response to check for tags
  console.log('=== AI Response received ===');
  console.log('Looking for tags in response...');

  // Check what tags exist in the response
  const allTags = aiResponse.match(/\[[A-Z]+:[^\]]+\]/gi);
  console.log('All tags found:', allTags);

  // Parse and award XP from AI response
  // Format: [XP: CharacterName +100, OtherCharacter +50]
  const xpMatches = aiResponse.match(/\[XP:\s*([^\]]+)\]/gi);
  console.log('XP tags found:', xpMatches);
  if (xpMatches) {
    for (const match of xpMatches) {
      const xpAwards = match.replace(/\[XP:\s*/i, '').replace(']', '').split(',');
      for (const award of xpAwards) {
        // Allow optional spaces around the + sign
        const xpMatch = award.trim().match(/(.+?)\s*\+\s*(\d+)/);
        console.log('XP award parse:', award.trim(), '->', xpMatch);
        if (xpMatch) {
          const charName = xpMatch[1].trim();
          const xpAmount = parseInt(xpMatch[2]);
          // Find character by name and update XP
          const char = findCharacterByName(characters, charName);
          if (char) {
            db.prepare('UPDATE characters SET xp = xp + ? WHERE id = ?').run(xpAmount, char.id);
            const updatedChar = db.prepare('SELECT * FROM characters WHERE id = ?').get(char.id);
            io.emit('character_updated', updatedChar);
            console.log(`XP Update: ${char.character_name} +${xpAmount} -> ${updatedChar.xp} XP`);
          } else {
            console.log(`XP Update FAILED: Character "${charName}" not found in session`);
          }
        }
      }
    }
  }

  // Parse and award MONEY (or GOLD for backward compatibility) from AI response
  // Format: [MONEY: CharacterName +50, OtherCharacter -25] or [GOLD: CharacterName +50]
  const moneyMatches = aiResponse.match(/\[(MONEY|GOLD):\s*([^\]]+)\]/gi);
  console.log('MONEY/GOLD tags found:', moneyMatches);
  if (moneyMatches) {
    for (const match of moneyMatches) {
      const moneyAwards = match.replace(/\[(MONEY|GOLD):\s*/i, '').replace(']', '').split(',');
      for (const award of moneyAwards) {
        // Allow optional spaces around the operator
        const moneyMatch = award.trim().match(/(.+?)\s*([+-])\s*(\d+)/);
        console.log('Money award parse:', award.trim(), '->', moneyMatch);
        if (moneyMatch) {
          const charName = moneyMatch[1].trim();
          const sign = moneyMatch[2] === '+' ? 1 : -1;
          const moneyAmount = parseInt(moneyMatch[3]) * sign;
          const char = findCharacterByName(characters, charName);
          if (char) {
            const newMoney = Math.max(0, (char.gold || 0) + moneyAmount);
            db.prepare('UPDATE characters SET gold = ? WHERE id = ?').run(newMoney, char.id);
            const updatedChar = db.prepare('SELECT * FROM characters WHERE id = ?').get(char.id);
            io.emit('character_updated', updatedChar);
            console.log(`Money update: ${char.character_name} ${sign > 0 ? '+' : ''}${moneyAmount} -> ${newMoney}`);
          } else {
            console.log(`Money Update FAILED: Character "${charName}" not found in session`);
          }
        }
      }
    }
  }

  // Parse and update INVENTORY from AI response
  // Format: [ITEM: CharacterName +Sword of Fire, CharacterName -Health Potion]
  const itemMatches = aiResponse.match(/\[ITEM:([^\]]+)\]/gi);
  if (itemMatches) {
    console.log('Found item tags:', itemMatches);
    for (const match of itemMatches) {
      const itemAwards = match.replace(/\[ITEM:/i, '').replace(']', '').split(',');
      for (const award of itemAwards) {
        const itemMatch = award.trim().match(/(.+?)\s*([+-])(.+)/);
        if (itemMatch) {
          const charName = itemMatch[1].trim();
          const isAdding = itemMatch[2] === '+';
          let itemName = itemMatch[3].trim();

          // Parse quantity (e.g., "Health Potion x3")
          let quantity = 1;
          const qtyMatch = itemName.match(/(.+?)\s*x(\d+)$/i);
          if (qtyMatch) {
            itemName = qtyMatch[1].trim();
            quantity = parseInt(qtyMatch[2]);
          }

          console.log(`Item ${isAdding ? 'add' : 'remove'}: "${itemName}" x${quantity} for "${charName}"`);

          const char = findCharacterByName(characters, charName);
          if (char) {
            let inventory = [];
            try {
              inventory = JSON.parse(char.inventory || '[]');
            } catch (e) {
              inventory = [];
            }

            if (isAdding) {
              // Check if item already exists (fuzzy match)
              const existingItem = inventory.find(i =>
                i.name.toLowerCase() === itemName.toLowerCase() ||
                i.name.toLowerCase().includes(itemName.toLowerCase()) ||
                itemName.toLowerCase().includes(i.name.toLowerCase())
              );
              if (existingItem) {
                existingItem.quantity = (existingItem.quantity || 1) + quantity;
                console.log(`Updated existing item: ${existingItem.name} -> qty ${existingItem.quantity}`);
              } else {
                inventory.push({ name: itemName, quantity: quantity });
                console.log(`Added new item: ${itemName} x${quantity}`);
              }
            } else {
              // Remove item (fuzzy match)
              const existingIdx = inventory.findIndex(i =>
                i.name.toLowerCase() === itemName.toLowerCase() ||
                i.name.toLowerCase().includes(itemName.toLowerCase()) ||
                itemName.toLowerCase().includes(i.name.toLowerCase())
              );
              if (existingIdx !== -1) {
                const oldQty = inventory[existingIdx].quantity || 1;
                inventory[existingIdx].quantity = oldQty - quantity;
                console.log(`Removed item: ${inventory[existingIdx].name} ${oldQty} -> ${inventory[existingIdx].quantity}`);
                if (inventory[existingIdx].quantity <= 0) {
                  console.log(`Item fully removed: ${inventory[existingIdx].name}`);
                  inventory.splice(existingIdx, 1);
                }
              } else {
                console.log(`Item not found for removal: "${itemName}" in inventory:`, inventory.map(i => i.name));
              }
            }

            db.prepare('UPDATE characters SET inventory = ? WHERE id = ?').run(JSON.stringify(inventory), char.id);
            io.emit('character_updated', { ...char, inventory: JSON.stringify(inventory) });
          } else {
            console.log(`Character not found: "${charName}". Available:`, characters.map(c => c.character_name));
          }
        }
      }
    }
  }

  // Parse and update SPELL SLOTS from AI response
  // Format: [SPELL: CharacterName -1st] or [SPELL: CharacterName +REST]
  const spellMatches = aiResponse.match(/\[SPELL:([^\]]+)\]/gi);
  if (spellMatches) {
    for (const match of spellMatches) {
      const spellAwards = match.replace(/\[SPELL:/i, '').replace(']', '').split(',');
      for (const award of spellAwards) {
        const spellMatch = award.trim().match(/(.+?)\s*([+-])(.+)/);
        if (spellMatch) {
          const charName = spellMatch[1].trim();
          const isAdding = spellMatch[2] === '+';
          const slotLevel = spellMatch[3].trim().toLowerCase();

          const char = findCharacterByName(characters, charName);
          if (char) {
            let spellSlots = {};
            try {
              spellSlots = JSON.parse(char.spell_slots || '{}');
            } catch (e) {
              spellSlots = {};
            }

            if (slotLevel === 'rest') {
              // Restore all spell slots to max
              for (const level in spellSlots) {
                if (spellSlots[level].max) {
                  spellSlots[level].used = 0;
                }
              }
            } else {
              // Parse slot level (1st, 2nd, 3rd, etc.)
              const levelNum = slotLevel.replace(/[^0-9]/g, '');
              if (levelNum && spellSlots[levelNum]) {
                if (!isAdding) {
                  // Using a spell slot
                  spellSlots[levelNum].used = Math.min(
                    (spellSlots[levelNum].used || 0) + 1,
                    spellSlots[levelNum].max || 0
                  );
                } else {
                  // Restoring a spell slot
                  spellSlots[levelNum].used = Math.max((spellSlots[levelNum].used || 0) - 1, 0);
                }
              }
            }

            db.prepare('UPDATE characters SET spell_slots = ? WHERE id = ?').run(JSON.stringify(spellSlots), char.id);
            io.emit('character_updated', { ...char, spell_slots: JSON.stringify(spellSlots) });
          }
        }
      }
    }
  }

  // Parse and update AC EFFECTS from AI response
  // Format: [AC: CharacterName +EffectName +Value Type] or [AC: CharacterName -EffectName] or [AC: CharacterName base ArmorName Value]
  const acMatches = aiResponse.match(/\[AC:([^\]]+)\]/gi);
  if (acMatches) {
    for (const match of acMatches) {
      const acContent = match.replace(/\[AC:/i, '').replace(']', '').trim();

      // Try to match "base" command: CharacterName base ArmorName Value
      const baseMatch = acContent.match(/(.+?)\s+base\s+(.+?)\s+(\d+)$/i);
      if (baseMatch) {
        const charName = baseMatch[1].trim();
        const armorName = baseMatch[2].trim();
        const baseValue = parseInt(baseMatch[3]);

        const char = findCharacterByName(characters, charName);
        if (char) {
          let acEffects = parseAcEffects(char.ac_effects);
          acEffects.base_source = armorName;
          acEffects.base_value = baseValue;
          updateCharacterAC(char.id, acEffects);
          const updatedChar = db.prepare('SELECT * FROM characters WHERE id = ?').get(char.id);
          io.emit('character_updated', updatedChar);
        }
        continue;
      }

      // Try to match add effect: CharacterName +EffectName +Value Type
      const addMatch = acContent.match(/(.+?)\s+\+(.+?)\s+\+(\d+)\s+(\w+)$/i);
      if (addMatch) {
        const charName = addMatch[1].trim();
        const effectName = addMatch[2].trim();
        const effectValue = parseInt(addMatch[3]);
        const effectType = addMatch[4].trim().toLowerCase();

        const char = findCharacterByName(characters, charName);
        if (char) {
          let acEffects = parseAcEffects(char.ac_effects);
          // Check if effect already exists, update it if so
          const existingIdx = acEffects.effects.findIndex(e => e.name.toLowerCase() === effectName.toLowerCase());
          if (existingIdx !== -1) {
            acEffects.effects[existingIdx].value = effectValue;
            acEffects.effects[existingIdx].type = effectType;
          } else {
            acEffects.effects.push({
              id: uuidv4(),
              name: effectName,
              value: effectValue,
              type: effectType,
              temporary: effectType === 'spell',
              notes: ''
            });
          }
          updateCharacterAC(char.id, acEffects);
          const updatedChar = db.prepare('SELECT * FROM characters WHERE id = ?').get(char.id);
          io.emit('character_updated', updatedChar);
        }
        continue;
      }

      // Try to match remove effect: CharacterName -EffectName
      const removeMatch = acContent.match(/(.+?)\s+-(.+)$/i);
      if (removeMatch) {
        const charName = removeMatch[1].trim();
        const effectName = removeMatch[2].trim();

        const char = findCharacterByName(characters, charName);
        if (char) {
          let acEffects = parseAcEffects(char.ac_effects);
          acEffects.effects = acEffects.effects.filter(e => e.name.toLowerCase() !== effectName.toLowerCase());
          updateCharacterAC(char.id, acEffects);
          const updatedChar = db.prepare('SELECT * FROM characters WHERE id = ?').get(char.id);
          io.emit('character_updated', updatedChar);
        }
        continue;
      }
    }
  }

  // Parse and update HP from AI response
  // Format: [HP: CharacterName -10] (damage) or [HP: CharacterName +5] (healing) or [HP: CharacterName =20] (set to specific value)
  const hpMatches = aiResponse.match(/\[HP:\s*([^\]]+)\]/gi);
  console.log('HP tags found:', hpMatches);
  if (hpMatches) {
    for (const match of hpMatches) {
      const hpContent = match.replace(/\[HP:\s*/i, '').replace(']', '').trim();
      console.log('HP content:', hpContent);

      // Match: CharacterName +/-/= Value (with optional spaces around operator)
      const hpMatch = hpContent.match(/(.+?)\s*([+\-=])\s*(\d+)/);
      console.log('HP regex match:', hpMatch);
      if (hpMatch) {
        const charName = hpMatch[1].trim();
        const operator = hpMatch[2];
        const value = parseInt(hpMatch[3]);
        console.log(`HP parsed: char="${charName}", op="${operator}", val=${value}`);

        const char = findCharacterByName(characters, charName);
        if (char) {
          let newHp;
          if (operator === '=') {
            newHp = value;
          } else if (operator === '+') {
            newHp = Math.min((char.hp || 0) + value, char.max_hp || value);
          } else {
            newHp = Math.max((char.hp || 0) - value, 0);
          }

          db.prepare('UPDATE characters SET hp = ? WHERE id = ?').run(newHp, char.id);
          const updatedChar = db.prepare('SELECT * FROM characters WHERE id = ?').get(char.id);
          io.emit('character_updated', updatedChar);
          console.log(`HP Update: ${char.character_name} ${operator}${value} -> ${newHp} HP`);
        } else {
          console.log(`HP Update FAILED: Character "${charName}" not found in session`);
        }
      }
    }
  }

  // Parse COMBAT commands from AI response
  // Format: [COMBAT: START CombatName] or [COMBAT: END] or [COMBAT: NEXT] or [COMBAT: PREV]
  const combatMatches = aiResponse.match(/\[COMBAT:([^\]]+)\]/gi);
  if (combatMatches) {
    for (const match of combatMatches) {
      const combatContent = match.replace(/\[COMBAT:/i, '').replace(']', '').trim().toUpperCase();

      if (combatContent.startsWith('START')) {
        const combatName = combatContent.replace('START', '').trim() || 'Combat';
        // Start a new combat
        const combatId = uuidv4();
        const combatants = characters.map(c => ({
          id: c.id,
          name: c.character_name,
          initiative: Math.floor(Math.random() * 20) + 1 + Math.floor(((c.dexterity || 10) - 10) / 2),
          hp: c.hp,
          maxHp: c.max_hp,
          ac: c.ac,
          isPlayer: true
        })).sort((a, b) => b.initiative - a.initiative);

        db.prepare(`INSERT INTO combats (id, session_id, name, combatants, is_active) VALUES (?, ?, ?, ?, 1)`)
          .run(combatId, sessionId, combatName, JSON.stringify(combatants));

        const combat = db.prepare('SELECT * FROM combats WHERE id = ?').get(combatId);
        io.emit('combat_started', { sessionId, combat: { ...combat, combatants: JSON.parse(combat.combatants) } });
        console.log(`Combat started: ${combatName}`);
      } else if (combatContent === 'END') {
        // End active combat
        db.prepare('UPDATE combats SET is_active = 0 WHERE session_id = ? AND is_active = 1').run(sessionId);
        io.emit('combat_ended', { sessionId });
        console.log('Combat ended');
      } else if (combatContent === 'NEXT') {
        // Next turn
        const combat = db.prepare('SELECT * FROM combats WHERE session_id = ? AND is_active = 1').get(sessionId);
        if (combat) {
          const combatants = JSON.parse(combat.combatants || '[]');
          let newTurn = (combat.current_turn + 1) % combatants.length;
          let newRound = combat.round;
          if (newTurn === 0) newRound++;

          db.prepare('UPDATE combats SET current_turn = ?, round = ? WHERE id = ?').run(newTurn, newRound, combat.id);
          const updatedCombat = db.prepare('SELECT * FROM combats WHERE id = ?').get(combat.id);
          io.emit('combat_updated', { sessionId, combat: { ...updatedCombat, combatants: JSON.parse(updatedCombat.combatants) } });
        }
      } else if (combatContent === 'PREV') {
        // Previous turn
        const combat = db.prepare('SELECT * FROM combats WHERE session_id = ? AND is_active = 1').get(sessionId);
        if (combat) {
          const combatants = JSON.parse(combat.combatants || '[]');
          let newTurn = combat.current_turn - 1;
          let newRound = combat.round;
          if (newTurn < 0) {
            newTurn = combatants.length - 1;
            newRound = Math.max(1, newRound - 1);
          }

          db.prepare('UPDATE combats SET current_turn = ?, round = ? WHERE id = ?').run(newTurn, newRound, combat.id);
          const updatedCombat = db.prepare('SELECT * FROM combats WHERE id = ?').get(combat.id);
          io.emit('combat_updated', { sessionId, combat: { ...updatedCombat, combatants: JSON.parse(updatedCombat.combatants) } });
        }
      }
    }
  }

  // Update session
  // Calculate tokens based on recent history only (since last compaction)
  // This prevents the issue where total API tokens (which include system prompt + summary)
  // always exceed the threshold after compaction
  const recentHistoryForTokenCount = fullHistory.slice(compactedCount);
  const recentHistoryTokens = estimateTokens(JSON.stringify(recentHistoryForTokenCount));

  // Check if we need to compact
  const maxTokens = parseInt(settings.max_tokens_before_compact) || 8000;
  let newSummary = session.story_summary;
  let newCompactedCount = compactedCount;

  // Only compact if:
  // 1. Recent history tokens exceed threshold
  // 2. There are at least 4 messages since last compaction (prevent rapid re-compacting)
  const minMessagesBeforeCompact = 4;
  const shouldCompact = recentHistoryTokens > maxTokens && recentHistoryForTokenCount.length >= minMessagesBeforeCompact;

  console.log(`Token check: recentHistoryTokens=${recentHistoryTokens}, maxTokens=${maxTokens}, messagesSinceCompact=${recentHistoryForTokenCount.length}, shouldCompact=${shouldCompact}`);

  if (shouldCompact) {
    console.log('Compacting history...');
    // Compact the recent history (messages since last compaction)
    const recentHistoryToCompact = fullHistory.slice(compactedCount);
    newSummary = await compactHistory(apiConfig, session.story_summary, recentHistoryToCompact, characters);
    // Mark all current messages as compacted
    newCompactedCount = fullHistory.length;
    // Keep full history for display, reset token tracking
    db.prepare('UPDATE game_sessions SET story_summary = ?, full_history = ?, compacted_count = ?, total_tokens = 0, current_turn = current_turn + 1 WHERE id = ?')
      .run(newSummary, JSON.stringify(fullHistory), newCompactedCount, sessionId);
  } else {
    db.prepare('UPDATE game_sessions SET full_history = ?, total_tokens = ?, current_turn = current_turn + 1 WHERE id = ?')
      .run(JSON.stringify(fullHistory), recentHistoryTokens, sessionId);
  }

  // Clear pending actions
  db.prepare('DELETE FROM pending_actions WHERE session_id = ?').run(sessionId);

  // Emit update to all clients
  io.emit('turn_processed', {
    sessionId,
    response: aiResponse,
    turn: session.current_turn + 1,
    tokensUsed: recentHistoryTokens,
    compacted: shouldCompact
  });

  return { response: aiResponse, tokensUsed: recentHistoryTokens };
}

// Compact history function - Creates structured summary for AI context
async function compactHistory(apiConfig, existingSummary, history, characters = []) {
  // Format history with better context
  const historyText = history.map(h => {
    if (h.type === 'action' && h.character_name) {
      return `[${h.character_name}]: ${h.content}`;
    } else if (h.type === 'narration' || h.role === 'assistant') {
      return `[DM]: ${h.content}`;
    } else if (h.type === 'gm_nudge') {
      return `[GM INSTRUCTION]: ${h.content}`;
    } else if (h.hidden || h.type === 'context') {
      return ''; // Skip hidden context
    }
    return `${h.role}: ${h.content}`;
  }).filter(t => t).join('\n\n');

  // Get character names for the prompt
  const characterNames = characters.map(c => c.character_name).join(', ') || 'the party';

  const compactPrompt = `You are creating a STRUCTURED SUMMARY of a D&D adventure for continuity purposes.
This summary will be used to maintain context in future sessions, so accuracy and completeness are critical.

PLAYER CHARACTERS: ${characterNames}

${existingSummary ? `=== EXISTING SUMMARY (update and expand this) ===\n${existingSummary}\n\n` : ''}=== RECENT EVENTS TO INCORPORATE ===
${historyText}

=== OUTPUT FORMAT (use this EXACT structure) ===

## STORY SO FAR
[2-4 paragraphs summarizing the overall plot progression, major events, and narrative arc]

## CURRENT SITUATION
[1-2 paragraphs: Where is the party RIGHT NOW? What were they just doing? What immediate situation are they in?]

## ACTIVE QUESTS & OBJECTIVES
${characters.length > 0 ? characters.map(c => `- List any active quests or goals`).join('\n') : '- List any active quests or goals for the party'}

## KEY NPCs ENCOUNTERED
[For each important NPC:]
- **NPC Name**: Who they are, relationship to party (friendly/hostile/neutral), last known status/location

## IMPORTANT DISCOVERIES
- Key items found, secrets learned, locations discovered
- Any plot-relevant information the party has learned

## UNRESOLVED THREADS
- Mysteries or questions left unanswered
- Enemies that escaped or threats that remain
- Promises made, debts owed, loose ends

## PARTY STATUS NOTES
- Any ongoing conditions, curses, blessings affecting the party
- Resources gained or lost (if narratively significant)
- Reputation changes with factions

=== INSTRUCTIONS ===
1. Be SPECIFIC with names, places, and details - vague summaries lose critical context
2. If updating an existing summary, MERGE the information - don't just append
3. Keep the most recent events in CURRENT SITUATION section
4. Remove outdated information (completed quests, dead NPCs, resolved threads)
5. Prioritize information the AI will need to maintain story consistency

Generate the structured summary now:`;

  console.log('=== Compacting History ===');
  console.log(`Previous summary length: ${existingSummary?.length || 0} chars`);
  console.log(`History entries to compact: ${history.length}`);

  try {
    const response = await fetch(apiConfig.api_endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiConfig.api_key}`
      },
      body: JSON.stringify({
        model: apiConfig.api_model,
        messages: [{ role: 'user', content: compactPrompt }],
        max_tokens: 4000 // Summaries should be concise
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Compaction API error:', errorText);
      return existingSummary + '\n\n[Compaction failed - API error]';
    }

    const data = await response.json();
    const summary = extractAIMessage(data);

    if (!summary) {
      console.error('Compaction failed - no summary extracted');
      return existingSummary + '\n\n[Compaction failed - could not parse response]';
    }

    console.log(`New summary length: ${summary.length} chars`);
    return summary;

  } catch (error) {
    console.error('Compaction error:', error);
    return existingSummary + `\n\n[Compaction failed - ${error.message}]`;
  }
}

function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

// Helper to get OpenAI API key from active config
function getOpenAIApiKey() {
  const activeConfig = getActiveApiConfig();
  if (activeConfig && activeConfig.api_endpoint && activeConfig.api_endpoint.includes('openai.com')) {
    return activeConfig.api_key;
  }
  // Check all configs for an OpenAI one
  const configs = db.prepare('SELECT * FROM api_configs WHERE endpoint LIKE ?').all('%openai.com%');
  if (configs.length > 0) {
    return configs[0].api_key;
  }
  return null;
}

// Socket.IO connection
io.on('connection', (socket) => {
  logger.debug('Client connected', { socketId: socket.id });

  socket.on('disconnect', () => {
    logger.debug('Client disconnected', { socketId: socket.id });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  logger.info(`D&D Multiplayer server running on port ${PORT}`);
});
