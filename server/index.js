require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const Database = require('better-sqlite3');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Database setup
const db = new Database(process.env.DB_PATH || './data/dnd.db');
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
`);

// Initialize default settings if not exist
const initSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
const defaultPassword = process.env.GAME_PASSWORD || 'changeme';
initSetting.run('game_password', bcrypt.hashSync(defaultPassword, 10));
initSetting.run('api_endpoint', 'https://api.openai.com/v1/chat/completions');
initSetting.run('api_key', '');
initSetting.run('api_model', 'gpt-4');
initSetting.run('max_tokens_before_compact', '8000');
initSetting.run('system_prompt', `You are a creative and engaging Dungeon Master for a D&D 5e game.
Your role is to:
- Narrate the story vividly and immersively
- Control NPCs and monsters
- Describe environments, combat outcomes, and consequences of player actions
- Keep track of the game state and maintain consistency
- Be fair but challenging
- Ask for dice rolls when appropriate (tell players what to roll)

Current party information will be provided. Wait for all players to submit their actions before narrating the outcome.`);

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Middleware to check password
const checkPassword = (req, res, next) => {
  const password = req.headers['x-game-password'];
  const storedHash = db.prepare('SELECT value FROM settings WHERE key = ?').get('game_password');

  if (!storedHash || !bcrypt.compareSync(password || '', storedHash.value)) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  next();
};

// API Routes
app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  const storedHash = db.prepare('SELECT value FROM settings WHERE key = ?').get('game_password');

  if (bcrypt.compareSync(password, storedHash.value)) {
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

app.get('/api/settings', checkPassword, (req, res) => {
  const settings = {};
  const rows = db.prepare('SELECT key, value FROM settings').all();
  rows.forEach(row => {
    if (row.key !== 'game_password') {
      settings[row.key] = row.value;
    }
  });
  res.json(settings);
});

app.post('/api/settings', checkPassword, (req, res) => {
  const { api_endpoint, api_key, api_model, max_tokens_before_compact, system_prompt, new_password } = req.body;

  const updateSetting = db.prepare('UPDATE settings SET value = ? WHERE key = ?');

  if (api_endpoint) updateSetting.run(api_endpoint, 'api_endpoint');
  if (api_key) updateSetting.run(api_key, 'api_key');
  if (api_model) updateSetting.run(api_model, 'api_model');
  if (max_tokens_before_compact) updateSetting.run(max_tokens_before_compact, 'max_tokens_before_compact');
  if (system_prompt) updateSetting.run(system_prompt, 'system_prompt');
  if (new_password) updateSetting.run(bcrypt.hashSync(new_password, 10), 'game_password');

  res.json({ success: true });
});

// Character routes
app.get('/api/characters', checkPassword, (req, res) => {
  const characters = db.prepare('SELECT * FROM characters ORDER BY created_at DESC').all();
  res.json(characters);
});

app.post('/api/characters', checkPassword, (req, res) => {
  const { player_name, character_name, race, class: charClass, strength, dexterity, constitution, intelligence, wisdom, charisma, background, equipment } = req.body;

  const id = uuidv4();
  const hp = 10 + Math.floor((constitution - 10) / 2); // Basic HP calculation

  db.prepare(`
    INSERT INTO characters (id, player_name, character_name, race, class, strength, dexterity, constitution, intelligence, wisdom, charisma, hp, max_hp, background, equipment)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, player_name, character_name, race, charClass, strength, dexterity, constitution, intelligence, wisdom, charisma, hp, hp, background, equipment);

  const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(id);
  io.emit('character_created', character);
  res.json(character);
});

app.delete('/api/characters/:id', checkPassword, (req, res) => {
  db.prepare('DELETE FROM characters WHERE id = ?').run(req.params.id);
  io.emit('character_deleted', req.params.id);
  res.json({ success: true });
});

// Game session routes
app.get('/api/sessions', checkPassword, (req, res) => {
  const sessions = db.prepare('SELECT * FROM game_sessions ORDER BY created_at DESC').all();
  res.json(sessions);
});

app.post('/api/sessions', checkPassword, (req, res) => {
  const { name } = req.body;
  const id = uuidv4();

  db.prepare('INSERT INTO game_sessions (id, name, full_history, story_summary) VALUES (?, ?, ?, ?)').run(id, name, '[]', '');

  const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(id);
  io.emit('session_created', session);
  res.json(session);
});

app.get('/api/sessions/:id', checkPassword, (req, res) => {
  const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const pendingActions = db.prepare('SELECT * FROM pending_actions WHERE session_id = ?').all(req.params.id);
  const characters = db.prepare('SELECT * FROM characters').all();

  res.json({ session, pendingActions, characters });
});

// Submit action
app.post('/api/sessions/:id/action', checkPassword, async (req, res) => {
  const { character_id, action } = req.body;
  const sessionId = req.params.id;

  // Check if character already has pending action
  const existing = db.prepare('SELECT * FROM pending_actions WHERE session_id = ? AND character_id = ?').get(sessionId, character_id);
  if (existing) {
    db.prepare('UPDATE pending_actions SET action = ? WHERE id = ?').run(action, existing.id);
  } else {
    db.prepare('INSERT INTO pending_actions (id, session_id, character_id, action) VALUES (?, ?, ?, ?)').run(uuidv4(), sessionId, character_id, action);
  }

  const pendingActions = db.prepare('SELECT * FROM pending_actions WHERE session_id = ?').all(sessionId);
  const characters = db.prepare('SELECT * FROM characters').all();

  io.emit('action_submitted', { sessionId, pendingActions, character_id });

  // Check if all characters have submitted actions
  if (pendingActions.length >= characters.length && characters.length > 0) {
    // Process turn with AI
    try {
      const result = await processAITurn(sessionId, pendingActions, characters);
      res.json({ processed: true, result });
    } catch (error) {
      console.error('AI processing error:', error);
      res.json({ processed: false, error: error.message });
    }
  } else {
    res.json({ processed: false, waiting: characters.length - pendingActions.length });
  }
});

// Force process turn (DM override)
app.post('/api/sessions/:id/process', checkPassword, async (req, res) => {
  const sessionId = req.params.id;
  const pendingActions = db.prepare('SELECT * FROM pending_actions WHERE session_id = ?').all(sessionId);
  const characters = db.prepare('SELECT * FROM characters').all();

  try {
    const result = await processAITurn(sessionId, pendingActions, characters);
    res.json({ success: true, result });
  } catch (error) {
    console.error('AI processing error:', error);
    res.status(500).json({ error: error.message });
  }
});

// AI Processing function
async function processAITurn(sessionId, pendingActions, characters) {
  const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(sessionId);
  const settings = {};
  db.prepare('SELECT key, value FROM settings').all().forEach(row => settings[row.key] = row.value);

  if (!settings.api_key) {
    throw new Error('API key not configured');
  }

  let history = JSON.parse(session.full_history || '[]');

  // Build character info
  const characterInfo = characters.map(c =>
    `${c.character_name} (${c.race} ${c.class}, played by ${c.player_name}): STR:${c.strength} DEX:${c.dexterity} CON:${c.constitution} INT:${c.intelligence} WIS:${c.wisdom} CHA:${c.charisma} HP:${c.hp}/${c.max_hp}`
  ).join('\n');

  // Build action summary
  const actionSummary = pendingActions.map(pa => {
    const char = characters.find(c => c.id === pa.character_id);
    return `${char ? char.character_name : 'Unknown'}: ${pa.action}`;
  }).join('\n');

  // Add user message for this turn
  const userMessage = `
PARTY STATUS:
${characterInfo}

PLAYER ACTIONS THIS TURN:
${actionSummary}

Please narrate the outcome of these actions and describe what happens next.`;

  history.push({ role: 'user', content: userMessage });

  // Build messages array
  const messages = [
    { role: 'system', content: settings.system_prompt + (session.story_summary ? `\n\nSTORY SO FAR:\n${session.story_summary}` : '') },
    ...history
  ];

  // Call AI API
  const response = await fetch(settings.api_endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${settings.api_key}`
    },
    body: JSON.stringify({
      model: settings.api_model,
      messages: messages,
      max_tokens: 2000
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`API Error: ${error}`);
  }

  const data = await response.json();
  const aiResponse = data.choices[0].message.content;
  const tokensUsed = data.usage?.total_tokens || estimateTokens(JSON.stringify(messages) + aiResponse);

  history.push({ role: 'assistant', content: aiResponse });

  // Update session
  const newTotalTokens = (session.total_tokens || 0) + tokensUsed;

  // Check if we need to compact
  const maxTokens = parseInt(settings.max_tokens_before_compact);
  let newSummary = session.story_summary;

  if (newTotalTokens > maxTokens) {
    // Compact the history
    newSummary = await compactHistory(settings, session.story_summary, history);
    history = []; // Reset history after compaction
    db.prepare('UPDATE game_sessions SET story_summary = ?, full_history = ?, total_tokens = 0, current_turn = current_turn + 1 WHERE id = ?')
      .run(newSummary, '[]', sessionId);
  } else {
    db.prepare('UPDATE game_sessions SET full_history = ?, total_tokens = ?, current_turn = current_turn + 1 WHERE id = ?')
      .run(JSON.stringify(history), newTotalTokens, sessionId);
  }

  // Clear pending actions
  db.prepare('DELETE FROM pending_actions WHERE session_id = ?').run(sessionId);

  // Emit update to all clients
  io.emit('turn_processed', {
    sessionId,
    response: aiResponse,
    turn: session.current_turn + 1,
    tokensUsed: newTotalTokens,
    compacted: newTotalTokens > maxTokens
  });

  return { response: aiResponse, tokensUsed: newTotalTokens };
}

// Compact history function
async function compactHistory(settings, existingSummary, history) {
  const historyText = history.map(h => `${h.role}: ${h.content}`).join('\n\n');

  const compactPrompt = `You are summarizing a D&D adventure for continuity purposes.
Create a concise but comprehensive summary that captures:
- Key plot points and story progression
- Important NPCs encountered
- Major decisions made by the party
- Current location and situation
- Any ongoing quests or objectives

${existingSummary ? `PREVIOUS SUMMARY:\n${existingSummary}\n\n` : ''}
RECENT EVENTS TO ADD TO SUMMARY:
${historyText}

Provide an updated comprehensive summary:`;

  const response = await fetch(settings.api_endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${settings.api_key}`
    },
    body: JSON.stringify({
      model: settings.api_model,
      messages: [{ role: 'user', content: compactPrompt }],
      max_tokens: 1500
    })
  });

  if (!response.ok) {
    return existingSummary + '\n\n[Compaction failed - continuing with truncated history]';
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

// Socket.IO connection
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`D&D Multiplayer server running on port ${PORT}`);
});
